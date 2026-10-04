/**
 * Day 17：Time Tool —— getCurrentTime() 的正式版
 *
 * 在 Day 15 极简 time 工具基础上补齐：
 *   1. timezone 参数的正式校验：用 Intl.DateTimeFormat 试构造——非法 IANA
 *      时区会抛 RangeError，工具返回结构化 {error}（错误穿透，沿用 Day 16）。
 *   2. 城市名 → IANA 的翻译交给 LLM（"东京"→Asia/Tokyo），工具只认 IANA。
 *   3. 返回结构化字段（本地时间、星期、日期、UTC 偏移、时区缩写），
 *      让模型回答"周几/几号/时差"时有确定依据，不必自己算时区偏移。
 *
 * 8 个场景：
 *   S1 默认时区（不带参数）
 *   S2 显式 IANA 时区
 *   S3 城市名翻译
 *   S4 两个城市并行查询（复用 Day 15 并行 tool_calls 编排）
 *   S5 跨日期线：问某地星期几 + 与北京的时差
 *   S6 非地球地点"火星"（模型应拒绝翻译或拿到 error 后解释，不得编造时间）
 *   S7 伪造 IANA 字符串（工具确定性返回 error）
 *   S8 常识问题（不应调用工具）
 *
 * 判分：合法时区题由脚本在同一瞬间独立用 Intl 计算 gold（HH:MM / 星期 / 日期），
 * 与模型答复比对；非法时区题检查是否"不编造 + 给出解释"。
 *
 * 运行：npx tsx src/experiments/day17-time-tool.ts
 * 输出：01-ai-chat/docs/day17-time-tool.md
 */
import "../env";
import OpenAI from "openai";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL,
});
const MODEL = process.env.MODEL_CHAT || "deepseek-chat";

// ================= ① 时区工具实现 =================
const DEFAULT_TZ = "Asia/Shanghai";

// 校验 IANA 时区：合法时区能被 Intl 正常格式化，非法则抛 RangeError
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface TimeInfo {
  timezone: string;
  iso: string;
  local: string; // 完整本地时间文本
  hourMinute: string; // HH:MM（24h）
  date: string; // YYYY-MM-DD
  weekday: string; // 星期X
  offsetMinutes: number; // 相对 UTC 的偏移（分钟）
  abbreviation: string; // 时区缩写，如 CST
}

function getCurrentTime(timezone = DEFAULT_TZ): TimeInfo {
  if (!isValidTimezone(timezone)) {
    throw new TimeToolError(
      `非法时区："${timezone}"。请使用 IANA 时区名（如 Asia/Shanghai、Europe/London）。`,
    );
  }

  const now = new Date();

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

  // 从本地文本与 UTC 的差异反算偏移
  const asUTC = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    Number(get("hour")) % 24,
    Number(get("minute")),
    Number(get("second")),
  );
  const offsetMinutes = Math.round((asUTC - now.getTime()) / 60_000);

  const weekdayZh: Record<string, string> = {
    Mon: "星期一",
    Tue: "星期二",
    Wed: "星期三",
    Thu: "星期四",
    Fri: "星期五",
    Sat: "星期六",
    Sun: "星期日",
  };

  const local = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
    hour12: false,
  }).format(now);

  // 时区缩写（部分环境可能给 GMT+X 形式）
  const abbreviation =
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName")?.value ?? "";

  return {
    timezone,
    iso: now.toISOString(),
    local,
    hourMinute: `${get("hour").padStart(2, "0")}:${get("minute")}`,
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: weekdayZh[get("weekday")] ?? get("weekday"),
    offsetMinutes,
    abbreviation,
  };
}

class TimeToolError extends Error {}

// ================= ② 工具定义 =================
const TIME_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_current_time",
    description:
      "获取指定 IANA 时区在当前瞬间的日期、时间、星期、UTC 偏移。用户询问任何城市/地区的现在时间、星期、日期或两地时差时调用。只接受 IANA 时区名（城市名请先翻译，如 东京→Asia/Tokyo）。",
    parameters: {
      type: "object",
      properties: {
        timezone: {
          type: "string",
          description: `IANA 时区名，如 Asia/Shanghai、America/New_York；不填默认 ${DEFAULT_TZ}`,
        },
      },
      required: [] as string[],
    },
  },
};

// ================= 网络调用：30s 超时 + 3 次重试 =================
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function createChat(
  body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
  attempt = 1,
): Promise<OpenAI.Chat.ChatCompletion> {
  try {
    return await client.chat.completions.create(body, { timeout: 30_000, maxRetries: 0 });
  } catch (err) {
    if (attempt >= 3) throw err;
    console.warn(`[day17] 网络错误（第 ${attempt} 次），2s 后重试`);
    await sleep(2000);
    return createChat(body, attempt + 1);
  }
}

// ================= ③ 场景定义 =================
type ExpectKind = "valid" | "invalid" | "knowledge";

interface Scenario {
  id: string;
  title: string;
  text: string;
  kind: ExpectKind;
  /** valid：答复中必须出现的时区（至少一个），gold 据此独立计算 */
  expectTimezones?: string[];
  /** 是否额外要求答复中出现星期/日期（S5） */
  expectWeekday?: boolean;
}

const SCENARIOS: Scenario[] = [
  { id: "S1", title: "默认时区（不给参数）", text: "现在几点了？", kind: "valid", expectTimezones: [DEFAULT_TZ] },
  { id: "S2", title: "显式 IANA 时区", text: "请帮我查一下 Europe/London 现在的时间。", kind: "valid", expectTimezones: ["Europe/London"] },
  { id: "S3", title: "城市名翻译", text: "东京现在几点？", kind: "valid", expectTimezones: ["Asia/Tokyo"] },
  { id: "S4", title: "两城市并行查询", text: "纽约和伦敦现在分别是几点？", kind: "valid", expectTimezones: ["America/New_York", "Europe/London"] },
  { id: "S5", title: "跨日期线：星期 + 时差", text: "洛杉矶现在是星期几、几号？跟北京时间差几个小时？", kind: "valid", expectTimezones: ["America/Los_Angeles", DEFAULT_TZ], expectWeekday: true },
  { id: "S6", title: "非地球地点（火星）", text: "火星上现在几点？", kind: "invalid" },
  { id: "S7", title: "伪造 IANA 字符串", text: "帮我查一下时区 Atlantis/Nowhere 现在的时间。", kind: "invalid" },
  { id: "S8", title: "常识问题（不应调用）", text: "UTC 和 GMT 有什么区别？一句话说明。", kind: "knowledge" },
];

// ================= ④ 运行单场景（编排循环） =================
interface ToolCallTrace {
  name: string;
  args: string;
  isError: boolean;
  result: string;
}

interface ScenarioResult {
  id: string;
  title: string;
  finalAnswer: string;
  toolCalls: ToolCallTrace[];
  apiRounds: number;
  correct: boolean;
  judgeNote: string;
  promptTokens: number;
  completionTokens: number;
}

async function runScenario(s: Scenario): Promise<ScenarioResult> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "你是严谨的时间助手。时间、星期、日期、时差必须来自 get_current_time 工具的真实返回，禁止凭记忆估算；城市名先翻译成 IANA 时区。遇到工具返回 error 时如实告知用户，不要编造时间。",
    },
    { role: "user", content: s.text },
  ];

  const toolCalls: ToolCallTrace[] = [];
  let finalAnswer = "";
  let apiRounds = 0;
  let promptTokens = 0;
  let completionTokens = 0;

  for (let round = 1; round <= 3; round++) {
    const resp = await createChat({
      model: MODEL,
      messages,
      temperature: 0,
      tools: [TIME_TOOL],
    });
    apiRounds++;
    promptTokens += resp.usage?.prompt_tokens ?? 0;
    completionTokens += resp.usage?.completion_tokens ?? 0;

    const msg = resp.choices[0].message;
    const calls = msg.tool_calls;
    if (!calls || calls.length === 0) {
      finalAnswer = msg.content ?? "";
      break;
    }

    messages.push(msg);
    for (const call of calls) {
      let isError = false;
      let result = "";
      try {
        const args = call.function.arguments ? (JSON.parse(call.function.arguments) as { timezone?: string }) : {};
        const info = getCurrentTime(args.timezone);
        result = JSON.stringify(info);
      } catch (e) {
        isError = true;
        result = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
      toolCalls.push({ name: call.function.name, args: call.function.arguments, isError, result });
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  const { correct, judgeNote } = judge(s, finalAnswer, toolCalls);
  return {
    id: s.id,
    title: s.title,
    finalAnswer,
    toolCalls,
    apiRounds,
    correct,
    judgeNote,
    promptTokens,
    completionTokens,
  };
}

// ================= ⑤ 判分 =================
function judge(
  s: Scenario,
  answer: string,
  toolCalls: ToolCallTrace[],
): { correct: boolean; judgeNote: string } {
  const text = answer.replace(/,/g, "");

  if (s.kind === "valid") {
    // 同一瞬间独立计算 gold（脚本自身的工具函数即权威实现）
    const checks: string[] = [];
    let allPass = true;

    for (const tz of s.expectTimezones ?? []) {
      const gold = getCurrentTime(tz);
      // 从答复中找 HH:MM；允许工具调用与最终答复间隔几秒，分钟数允许相等或差 1
      const re = /(\d{1,2})[:：](\d{2})/g;
      let minuteHit = false;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const hh = Number(m[1]);
        const mm = Number(m[2]);
        const given = hh * 60 + mm;
        const goldMin = Number(gold.hourMinute.slice(0, 2)) * 60 + Number(gold.hourMinute.slice(3, 5));
        const diff = Math.abs(given - goldMin);
        if (diff <= 1 || diff === 23 * 60 + 59) {
          minuteHit = true;
          break;
        }
      }
      if (!minuteHit) allPass = false;
      checks.push(`${tz}: gold=${gold.hourMinute} 匹配=${minuteHit}`);
    }

    if (s.expectWeekday) {
      // 选洛杉矶 gold，答复应包含其星期或日期
      const la = getCurrentTime("America/Los_Angeles");
      const weekdayHit = text.includes(la.weekday) || text.includes(la.weekday.replace("星期", "周"));
      // 日期写法全部接受：2026-10-04 / 10-04 / 10月4日 / 10月04日 / 2026年10月4日
      // 用正则兼容可选年份、- 与 年/月/日 分隔、日月的前导零
      const yyyy = la.date.slice(0, 4);
      const mmNum = Number(la.date.slice(5, 7));
      const ddNum = Number(la.date.slice(8, 10));
      const dateRe = new RegExp(
        `(${yyyy}[-年/])?0?${mmNum}[-月/]0?${ddNum}日?`,
      );
      const dateHit = text.includes(la.date) || dateRe.test(text);
      // 时差：北京(480) - 洛杉矶(offsetMinutes) 的小时差，文本需出现该数字
      const bj = getCurrentTime(DEFAULT_TZ);
      const hourDiff = Math.round((bj.offsetMinutes - la.offsetMinutes) / 60);
      const diffHit = new RegExp(`${hourDiff}\\s*小时`).test(text) || text.includes(`-${hourDiff}`);
      if (!weekdayHit || !dateHit || !diffHit) allPass = false;
      checks.push(
        `洛杉矶星期=${la.weekday} 命中=${weekdayHit}；日期=${la.date} 命中=${dateHit}；时差=${hourDiff}小时 命中=${diffHit}`,
      );
    }

    return {
      correct: allPass,
      judgeNote: checks.join(" | "),
    };
  }

  if (s.kind === "invalid") {
    // 期望：不给出地球某地的具体时间，明确说明无法获取/没有此时区
    const noFabricatedTime = !/\d{1,2}[:：]\d{2}/.test(text);
    const explains =
      s.id === "S6"
        ? /(火星|无法|不能|没有|不存在|不适用)/.test(text)
        : /(时区|无法|不能|不存在|非法|无效|错误)/.test(text);
    const usedToolOrRefused = toolCalls.length > 0 || /(无法|不能|没有)/.test(text);
    const correct = noFabricatedTime && explains && usedToolOrRefused;
    return {
      correct,
      judgeNote: `未编造具体时间=${noFabricatedTime}，给出解释=${explains}，经工具或直接拒绝=${usedToolOrRefused}（工具调用 ${toolCalls.length} 次，其中 error ${toolCalls.filter((t) => t.isError).length} 次）`,
    };
  }

  // knowledge：不调用工具，且讲出两者关系（基准/原子时/时区/协调世界时语义之一）
  const noTool = toolCalls.length === 0;
  const contentOk = /(UTC|GMT)/.test(text) && /(基准|原子|时区|协调|本初子午|格林尼治|标准)/.test(text);
  return {
    correct: noTool && contentOk,
    judgeNote: `未调用工具=${noTool}，解释要素齐全=${contentOk}`,
  };
}

// ================= ⑥ 报告生成 =================
function fmtToolCalls(r: ScenarioResult): string {
  if (r.toolCalls.length === 0) return "（未调用工具）";
  return r.toolCalls
    .map((t) => {
      const tag = t.isError ? " ❌error" : "";
      // result 截断防止过长
      const result = t.result.length > 220 ? `${t.result.slice(0, 220)}...` : t.result;
      return `    - args \`${t.args}\` → \`${result}\`${tag}`;
    })
    .join("\n");
}

function buildMarkdown(results: ScenarioResult[]): string {
  const date = new Date().toISOString().slice(0, 10);

  const totalPrompt = results.reduce((n, r) => n + r.promptTokens, 0);
  const totalCompletion = results.reduce((n, r) => n + r.completionTokens, 0);
  const correctCount = results.filter((r) => r.correct).length;
  const totalRounds = results.reduce((n, r) => n + r.apiRounds, 0);

  const overview = results
    .map(
      (r) =>
        `| ${r.id} | ${r.title} | ${r.apiRounds} | ${r.toolCalls.length}（error ${r.toolCalls.filter((t) => t.isError).length}） | ${r.correct ? "✅" : "❌"} |`,
    )
    .join("\n");

  const details = results
    .map(
      (r) => `## ${r.id}：${r.title}

- 判分：${r.correct ? "✅" : "❌"} ${r.judgeNote}
- API 轮数：${r.apiRounds}
- 工具调用：
${fmtToolCalls(r)}
- 最终答复：

\`\`\`text
${r.finalAnswer.trim()}
\`\`\``,
    )
    .join("\n\n---\n\n");

  return `# Day 17：Time Tool —— getCurrentTime() 正式版（时区校验 + 结构化返回）

> 日期：${date}
> 模型：${MODEL}（temperature=0）
> 通过：${correctCount}/8；共 ${totalRounds} 次 API 轮；Prompt Tokens ${totalPrompt}，Completion Tokens ${totalCompletion}

## 场景总览

| 场景 | 说明 | API 轮数 | 工具调用次数 | 结果 |
|---|---|---|---|---|
${overview}

---

${details}

---

## 学习笔记 / 概念卡片 / 面试题

<!-- 人工补充 -->
`;
}

// ================= main =================
async function main() {
  const results: ScenarioResult[] = [];
  for (const s of SCENARIOS) {
    console.log(`[day17] === ${s.id} ${s.title} ===`);
    const r = await runScenario(s);
    results.push(r);
    console.log(`[day17]   correct=${r.correct} calls=${r.toolCalls.length}`);
  }

  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs");
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, "day17-time-tool.md");
  writeFileSync(outFile, buildMarkdown(results), "utf-8");
  console.log(`[day17] 结果已写入 ${outFile}`);
}

main().catch((err) => {
  console.error("[day17] 实验失败：", err);
  process.exit(1);
});
