/**
 * Day 20：多个 Tool —— Calculator / Time / Weather / Search，LLM 自主选择与组合
 *
 * Day 19 解决了"工具如何统一管理"，今天解决另一个问题：工具集扩大后，
 * 模型能不能选对？学习焦点从"实现工具"转为"工具选择"：
 *
 *   - 直选：问题明确指向某个工具
 *   - 消歧：生活化/模糊表述能否翻译成正确工具
 *   - 克制：自身知识能答的，不调搜索（避免不必要的工具往返与成本）
 *   - 并行 vs 链式：无依赖的并行，有依赖的分轮（S6：search 拿价格 → calculator 算涨幅）
 *
 * 新增 search 工具：无搜索 API，使用 Mock 固定结果（与 weather 同样策略，
 * dataSource:"mock"，模型转述时须披露）。
 *
 * 判分分两层：
 *   ① 工具选择：expectedTools 必须出现；allowedTools 白名单（出现名单外即误调用）
 *   ② 答案正确：gold 来自内置确定性实现 / Mock 快照
 *
 * 运行：npx tsx src/experiments/day20-multiple-tools.ts
 * 输出：01-ai-chat/docs/day20-multiple-tools.md
 */
import "../env";
import OpenAI from "openai";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL,
});
const MODEL = process.env.MODEL_CHAT || "deepseek-chat";
const TOOL_NAMES = ["calculator", "get_current_time", "get_weather", "search"] as const;

// ###################################################################
 // ① 工具执行体
// ###################################################################

class ToolExecError extends Error {}

// ---- Calculator（递归下降安全求值，无 eval）----
function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) i++;
    else if (/[0-9.]/.test(ch)) {
      let num = "";
      while (i < src.length && /[0-9.]/.test(src[i])) num += src[i++];
      if ((num.match(/\./g) ?? []).length > 1 || num === ".") throw new ToolExecError(`非法数字：${num}`);
      tokens.push(num);
    } else if ("+-*/%^()".includes(ch)) {
      tokens.push(ch);
      i++;
    } else throw new ToolExecError(`不支持的字符：${ch}`);
  }
  return tokens;
}

function calculate(expression: string): number {
  if (expression.length > 200) throw new ToolExecError("表达式过长（上限 200）");
  const tokens = tokenize(expression);
  if (tokens.length === 0) throw new ToolExecError("表达式为空");
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseExpr(): number {
    let v = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const r = parseTerm();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  function parseTerm(): number {
    let v = parseFactor();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = next();
      const r = parseFactor();
      if (op === "*") v *= r;
      else {
        if (r === 0) throw new ToolExecError(op === "/" ? "除数不能为 0" : "对 0 取模无意义");
        v = op === "/" ? v / r : v % r;
      }
    }
    return v;
  }
  function parseFactor(): number {
    const b = parseUnary();
    if (peek() === "^") {
      next();
      return b ** parseFactor();
    }
    return b;
  }
  function parseUnary(): number {
    if (peek() === "-" || peek() === "+") {
      const sign = next() === "-" ? -1 : 1;
      return sign * parseUnary();
    }
    return parsePrimary();
  }
  function parsePrimary(): number {
    const tk = peek();
    if (tk === "(") {
      next();
      const v = parseExpr();
      if (next() !== ")") throw new ToolExecError("括号不匹配");
      return v;
    }
    if (tk === undefined) throw new ToolExecError("表达式不完整");
    if (!/^[0-9.]+$/.test(tk)) throw new ToolExecError(`此处应为数字：${tk}`);
    next();
    return Number(tk);
  }

  const result = parseExpr();
  if (pos !== tokens.length) throw new ToolExecError(`存在无法解析的片段：${tokens.slice(pos).join(" ")}`);
  if (!Number.isFinite(result)) throw new ToolExecError("结果超出范围");
  return result;
}

// ---- Time ----
const DEFAULT_TZ = "Asia/Shanghai";
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
function getCurrentTime(timezone = DEFAULT_TZ) {
  if (!isValidTimezone(timezone)) throw new ToolExecError(`非法时区："${timezone}"，请使用 IANA 名`);
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    timezone,
    hourMinute: `${get("hour").padStart(2, "0")}:${get("minute")}`,
    date: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

// ---- Weather（Mock 快照 + 归一化）----
const SNAPSHOT_AT = "2026-10-04T10:00:00+08:00";
const MOCK_WEATHER: Record<string, { temperatureC: number; condition: string; precipitationMm: number }> = {
  北京: { temperatureC: 22, condition: "晴", precipitationMm: 0 },
  上海: { temperatureC: 24, condition: "多云", precipitationMm: 0 },
  广州: { temperatureC: 28, condition: "雷阵雨", precipitationMm: 6 },
  深圳: { temperatureC: 27, condition: "中雨", precipitationMm: 8 },
};
function getWeather(city: string) {
  const stripped = city.trim().replace(/(市|省)$/u, "");
  const hit = MOCK_WEATHER[stripped];
  if (!hit) throw new ToolExecError(`未知城市："${city}"，覆盖：${Object.keys(MOCK_WEATHER).join("、")}`);
  return { city: stripped, observedAt: SNAPSHOT_AT, dataSource: "mock" as const, ...hit };
}

// ---- Search（Mock：query 关键词命中固定结果）----
interface MockSearchEntry {
  pattern: RegExp;
  title: string;
  snippet: string;
}
const MOCK_SEARCH: MockSearchEntry[] = [
  {
    pattern: /(特斯拉|tesla|tsla)/i,
    title: "TSLA 实时行情（Mock）",
    snippet: "截至美东收盘，特斯拉(TSLA)报 252.14 美元，上一交易日收盘价 240.50 美元。",
  },
  {
    pattern: /(苹果|apple|aapl)/i,
    title: "AAPL 实时行情（Mock）",
    snippet: "苹果公司(AAPL)最新报 227.73 美元，上一交易日收盘价 225.10 美元。",
  },
  {
    pattern: /(deepseek)/i,
    title: "DeepSeek 发布新模型（Mock）",
    snippet: "Mock 新闻：DeepSeek 于近期发布新一代代码模型，SWE-bench 成绩提升。",
  },
];

function search(query: string) {
  const q = query.trim();
  if (!q) throw new ToolExecError("query 不能为空");
  const hits = MOCK_SEARCH.filter((e) => e.pattern.test(q));
  const results =
    hits.length > 0
      ? hits.map((h) => ({ title: h.title, snippet: h.snippet, url: "https://example.com/mock" }))
      : [{ title: "未找到匹配结果（Mock）", snippet: `Mock 搜索库中没有与 "${q}" 相关的条目。`, url: "" }];
  return { query: q, searchedAt: new Date().toISOString(), dataSource: "mock" as const, results };
}

// ###################################################################
 // ② ToolHandler 契约 与 ToolRegistry（Day 19 成果直接复用）
// ###################################################################

interface ToolHandler<T = any> {
  name: string;
  definition: OpenAI.Chat.Completions.ChatCompletionTool;
  schema: z.ZodType<T>;
  run(args: T): unknown;
}

type FailStage = "lookup" | "parse" | "validate" | "execute";
type ExecResult =
  | { ok: true; data: unknown }
  | { ok: false; stage: FailStage; error: string; details?: unknown };

class ToolRegistry {
  private handlers = new Map<string, ToolHandler>();

  register(handler: ToolHandler): void {
    if (this.handlers.has(handler.name)) throw new Error(`工具重复注册：${handler.name}`);
    if (handler.definition.function.name !== handler.name) throw new Error(`工具名不一致：${handler.name}`);
    this.handlers.set(handler.name, handler);
  }

  definitions(): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return [...this.handlers.values()].map((h) => h.definition);
  }

  execute(name: string, rawArguments: string): ExecResult {
    const handler = this.handlers.get(name);
    if (!handler) return { ok: false, stage: "lookup", error: `未注册的工具："${name}"` };

    let raw: unknown;
    try {
      raw = rawArguments ? JSON.parse(rawArguments) : {};
    } catch (e) {
      return { ok: false, stage: "parse", error: `工具参数不是合法 JSON：${e instanceof Error ? e.message : String(e)}` };
    }

    const parsed = handler.schema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        stage: "validate",
        error: "工具参数校验失败",
        details: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      };
    }

    try {
      return { ok: true, data: handler.run(parsed.data) };
    } catch (e) {
      return { ok: false, stage: "execute", error: e instanceof Error ? e.message : String(e) };
    }
  }
}

const registry = new ToolRegistry();

registry.register({
  name: "calculator",
  definition: {
    type: "function",
    function: {
      name: "calculator",
      description: "精确数学计算器。数值计算必须调用，不要心算。支持 + - * / % ^ ( )。",
      parameters: {
        type: "object",
        properties: { expression: { type: "string", description: "如 (252.14-240.50)/240.50*100" } },
        required: ["expression"],
      },
    },
  },
  schema: z.object({ expression: z.string().min(1).max(200) }),
  run: ({ expression }) => ({ expression, result: calculate(expression) }),
});

registry.register({
  name: "get_current_time",
  definition: {
    type: "function",
    function: {
      name: "get_current_time",
      description: "获取时区当前时间/日期。询问时间、星期、日期时调用。",
      parameters: {
        type: "object",
        properties: { timezone: { type: "string", description: `IANA 名；默认 ${DEFAULT_TZ}` } },
        required: [] as string[],
      },
    },
  },
  schema: z.object({ timezone: z.string().optional() }),
  run: ({ timezone }) => getCurrentTime(timezone),
});

registry.register({
  name: "get_weather",
  definition: {
    type: "function",
    function: {
      name: "get_weather",
      description: "查询城市天气（温度、天气状况、降水量）。问天气/气温/是否带伞时调用。",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "城市名" } },
        required: ["city"],
      },
    },
  },
  schema: z.object({ city: z.string().min(1) }),
  run: ({ city }) => getWeather(city),
});

registry.register({
  name: "search",
  definition: {
    type: "function",
    function: {
      name: "search",
      description: "搜索实时信息或你知识截止后未知的信息（股价、最新新闻等）。常识问题不要调用。",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "搜索关键词，应简洁聚焦" } },
        required: ["query"],
      },
    },
  },
  schema: z.object({ query: z.string().min(1).max(100) }),
  run: ({ query }) => search(query),
});

// ###################################################################
 // ③ 场景与判分
// ###################################################################

interface Scenario {
  id: string;
  title: string;
  text: string;
  /** 必须实际调用的工具（至少包含） */
  expectedTools?: string[];
  /** 允许调用的工具白名单（出现名单外 = 误调用）；不填则不限 */
  allowedTools?: string[];
  /** 答案判分 */
  judgeAnswer: (answer: string) => { pass: boolean; note: string };
}

function answerHas(answer: string, n: number, tolerance = 0): boolean {
  const text = answer.replace(/,/g, "");
  const re = new RegExp(`(^|[^0-9.])${String(n).replace(".", "\\.")}([^0-9]|$)`);
  if (re.test(text)) return true;
  if (tolerance > 0) {
    const nums = text.match(/-?\d+(\.\d+)?/g) ?? [];
    return nums.some((x) => Math.abs(Number(x) - n) <= tolerance);
  }
  return false;
}

// gold：S6 涨幅 = (252.14-240.50)/240.50*100 = 4.84（用 calculator 同源计算确认）
const TSLA_GAIN_PCT = ((252.14 - 240.5) / 240.5) * 100;

const scenarios: Scenario[] = [
  {
    id: "S1",
    title: "直选·计算器",
    text: "帮我算一下 1234 乘以 5678 等于多少？",
    expectedTools: ["calculator"],
    allowedTools: ["calculator"],
    judgeAnswer: (a) => {
      // gold 由确定性实现直接算出，禁止手敲（手误曾写成 7007542）
      const gold = calculate("1234*5678");
      return { pass: answerHas(a, gold), note: `gold=${gold}` };
    },
  },
  {
    id: "S2",
    title: "直选·时间",
    text: "现在几点了？",
    expectedTools: ["get_current_time"],
    allowedTools: ["get_current_time"],
    judgeAnswer: (a) => {
      const gold = getCurrentTime();
      const m = a.match(/(\d{1,2})[:：](\d{2})/);
      if (!m) return { pass: false, note: `未给时间，gold≈${gold.hourMinute}` };
      const given = Number(m[1]) * 60 + Number(m[2]);
      const g = Number(gold.hourMinute.slice(0, 2)) * 60 + Number(gold.hourMinute.slice(3, 5));
      return { pass: Math.abs(given - g) <= 1, note: `gold=${gold.hourMinute}，答复=${m[0]}` };
    },
  },
  {
    id: "S3",
    title: "直选·天气",
    text: "深圳现在天气怎么样？多少度？",
    expectedTools: ["get_weather"],
    allowedTools: ["get_weather"],
    judgeAnswer: (a) => ({ pass: answerHas(a, 27), note: "gold 深圳=27°C（中雨）" }),
  },
  {
    id: "S4",
    title: "直选·搜索",
    text: "特斯拉（TSLA）目前的股价是多少美元？",
    expectedTools: ["search"],
    allowedTools: ["search"],
    judgeAnswer: (a) => ({ pass: answerHas(a, 252.14), note: "gold=252.14（Mock）" }),
  },
  {
    id: "S5",
    title: "消歧·生活化表述→天气",
    text: "我在上海，现在出门需要带伞吗？",
    expectedTools: ["get_weather"],
    allowedTools: ["get_weather"],
    judgeAnswer: (a) => {
      const noUmbrella = /不用|不需要|不必/.test(a);
      return { pass: noUmbrella, note: `上海多云降水 0mm，gold=不用带伞；命中"不用/不需要"=${noUmbrella}` };
    },
  },
  {
    id: "S6",
    title: "链式·搜索→计算器（涨幅）",
    text: "特斯拉股价相比上一个交易日收盘价，涨了百分之多少？",
    expectedTools: ["search", "calculator"],
    allowedTools: ["search", "calculator"],
    judgeAnswer: (a) => ({
      pass: answerHas(a, Number(TSLA_GAIN_PCT.toFixed(2)), 0.05),
      note: `gold=(252.14-240.50)/240.50*100=${TSLA_GAIN_PCT.toFixed(2)}%`,
    }),
  },
  {
    id: "S7",
    title: "克制·常识不调用",
    text: "水在标准大气压下的沸点是多少？",
    expectedTools: [],
    allowedTools: [],
    judgeAnswer: (a) => ({ pass: answerHas(a, 100), note: "gold=100°C，且零工具调用" }),
  },
  {
    id: "S8",
    title: "并行·天气+搜索",
    text: "顺便问两个事：深圳现在多少度？苹果（AAPL）股价多少美元？",
    expectedTools: ["get_weather", "search"],
    allowedTools: ["get_weather", "search"],
    judgeAnswer: (a) => {
      const t1 = answerHas(a, 27);
      const t2 = answerHas(a, 227.73);
      return { pass: t1 && t2, note: `深圳27°C 命中=${t1}；AAPL 227.73 命中=${t2}` };
    },
  },
];

// ###################################################################
 // ④ 编排循环（工具无关，与 Day 19 相同）
// ###################################################################

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function createChat(
  body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
  attempt = 1,
): Promise<OpenAI.Chat.ChatCompletion> {
  try {
    return await client.chat.completions.create(body, { timeout: 30_000, maxRetries: 0 });
  } catch (err) {
    if (attempt >= 3) throw err;
    console.warn(`[day20] 网络错误（第 ${attempt} 次），2s 后重试`);
    await sleep(2000);
    return createChat(body, attempt + 1);
  }
}

interface Trace {
  name: string;
  args: string;
  failedStage?: FailStage;
  content: string;
}
interface ScenarioResult {
  scenario: Scenario;
  finalAnswer: string;
  traces: Trace[];
  apiRounds: number;
  toolChoicePass: boolean;
  toolChoiceNote: string;
  answerPass: boolean;
  answerNote: string;
  promptTokens: number;
  completionTokens: number;
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "你可以使用 calculator / get_current_time / get_weather / search。规则：数值计算必须用 calculator 不心算；实时信息（时间、天气、股价、新闻）必须用对应工具；search/get_weather 返回 Mock 数据须明确说明；常识问题不要调用任何工具；无依赖的多个调用放在同一轮并行。",
    },
    { role: "user", content: scenario.text },
  ];

  const traces: Trace[] = [];
  let finalAnswer = "";
  let apiRounds = 0;
  let promptTokens = 0;
  let completionTokens = 0;

  for (let round = 1; round <= 6; round++) {
    const resp = await createChat({
      model: MODEL, messages, temperature: 0, tools: registry.definitions(),
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
      const r = registry.execute(call.function.name, call.function.arguments);
      const content = JSON.stringify(
        r.ok
          ? r.data
          : { error: r.error, stage: r.stage, ...("details" in r ? { details: r.details } : {}) },
      );
      traces.push({
        name: call.function.name,
        args: call.function.arguments,
        ...(r.ok ? {} : { failedStage: (r as any).stage }),
        content,
      });
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }

  // 判分①：工具选择
  const calledTools = [...new Set(traces.map((t) => t.name))].sort();
  const missing = (scenario.expectedTools ?? []).filter((t) => !calledTools.includes(t));
  const extra = calledTools.filter((t) => !(scenario.allowedTools ?? [...TOOL_NAMES]).includes(t));
  const toolChoicePass = missing.length === 0 && extra.length === 0;
  const toolChoiceNote =
    calledTools.length === 0
      ? "零调用"
      : `调用 [${calledTools.join(", ")}]` +
        (missing.length ? `；缺 ${missing.join(",")}` : "") +
        (extra.length ? `；误调用 ${extra.join(",")}` : "");

  // 判分②：答案
  const j = scenario.judgeAnswer(finalAnswer);

  return {
    scenario, finalAnswer, traces, apiRounds,
    toolChoicePass, toolChoiceNote,
    answerPass: j.pass, answerNote: j.note,
    promptTokens, completionTokens,
  };
}

// ###################################################################
 // ⑤ 报告
// ###################################################################

function buildMarkdown(results: ScenarioResult[]): string {
  const date = new Date().toISOString().slice(0, 10);

  const choicePass = results.filter((r) => r.toolChoicePass).length;
  const answerPass = results.filter((r) => r.answerPass).length;

  // 工具选择矩阵：场景 × 4 工具
  const matrixHeader = `| 场景 | calculator | get_current_time | get_weather | search |\n|---|---|---|---|---|`;
  const matrixRows = results
    .map((r) => {
      const called = new Set(r.traces.map((t) => t.name));
      const cell = (n: string) => (called.has(n) ? "✅" : "·");
      return `| ${r.scenario.id} ${r.scenario.title} | ${cell("calculator")} | ${cell("get_current_time")} | ${cell("get_weather")} | ${cell("search")} |`;
    })
    .join("\n");

  const summaryRows = results
    .map((r) =>
      `| ${r.scenario.id} | ${r.scenario.title} | ${r.apiRounds} | ${r.toolChoicePass ? "✅" : "❌"} ${r.toolChoiceNote} | ${r.answerPass ? "✅" : "❌"} ${r.answerNote} |`,
    )
    .join("\n");

  const promptTokens = results.reduce((n, r) => n + r.promptTokens, 0);
  const completionTokens = results.reduce((n, r) => n + r.completionTokens, 0);

  const details = results
    .map((r) => {
      const traces =
        r.traces.length === 0
          ? "（零调用）"
          : r.traces
              .map((t) => {
                const c = t.content.length > 220 ? `${t.content.slice(0, 220)}...` : t.content;
                return `    - ${t.name} \`${t.args}\` → \`${c}\`${t.failedStage ? ` ❌${t.failedStage}` : ""}`;
              })
              .join("\n");
      return `## ${r.scenario.id}：${r.scenario.title}

- 工具选择：${r.toolChoicePass ? "✅" : "❌"} ${r.toolChoiceNote}
- 答案判分：${r.answerPass ? "✅" : "❌"} ${r.answerNote}
- API 轮数：${r.apiRounds}
- 轨迹：
${traces}
- 最终答复：

\`\`\`text
${r.finalAnswer.trim()}
\`\`\``;
    })
    .join("\n\n---\n\n");

  return `# Day 20：多个 Tool —— LLM 在 4 个工具中自主选择与组合

> 日期：${date}
> 模型：${MODEL}（temperature=0）
> 工具：calculator / get_current_time / get_weather（Mock）/ search（Mock）

## 总览

- 工具选择正确率：${choicePass}/8
- 答案正确率：${answerPass}/8
- Prompt Tokens ${promptTokens}，Completion Tokens ${completionTokens}

## 工具选择矩阵（该场景实际调用的工具）

${matrixHeader}
${matrixRows}

## 明细判分

| 场景 | 说明 | API 轮数 | 工具选择 | 答案 |
|---|---|---|---|---|
${summaryRows}

---

${details}

---

## 学习笔记 / 概念卡片 / 面试题

<!-- 人工补充 -->
`;
}

// ###################################################################
 // main
// ###################################################################

async function main() {
  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    console.log(`[day20] === ${s.id} ${s.title} ===`);
    const r = await runScenario(s);
    results.push(r);
    console.log(`[day20]   选择=${r.toolChoicePass} 答案=${r.answerPass} | ${r.toolChoiceNote}`);
  }

  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs");
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, "day20-multiple-tools.md");
  writeFileSync(outFile, buildMarkdown(results), "utf-8");
  console.log(`[day20] 结果已写入 ${outFile}`);
}

main().catch((err) => {
  console.error("[day20] 实验失败：", err);
  process.exit(1);
});
