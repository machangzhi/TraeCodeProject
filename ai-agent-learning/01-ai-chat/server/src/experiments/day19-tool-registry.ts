/**
 * Day 19：Tool Registry —— 工具的统一注册 / 查找 / 参数校验 / 执行 / 错误处理
 *
 * Day 16-18 的编排循环里，每个工具的判断、执行、报错都是各自手写的。今天把
 * 它们收敛为一套通用机制：
 *
 *   ToolHandler  = { name, definition(给 LLM 的 JSON Schema), schema(zod), run(执行体) }
 *   ToolRegistry = register / get / definitions / execute
 *
 * execute 是一条四阶段流水线，每阶段失败都返回带 stage 标签的统一错误：
 *   lookup(未注册名) → parse(JSON 非法) → validate(zod 不通过) → execute(执行体抛错)
 *
 * 收益：编排循环彻底"工具无关"——新增工具只需 registry.register(handler)，
 * 循环一行不改；所有工具错误被同一格式收敛，可观测、可统计。
 *
 * 实验分两部分：
 *   Part A（确定性单元测试，零成本）：Registry 五项能力 × 10 断言
 *   Part B（真实 LLM，4 场景）：复合问题让模型自主选择/并行/链式调用
 *
 * 运行：npx tsx src/experiments/day19-tool-registry.ts
 * 输出：01-ai-chat/docs/day19-tool-registry.md
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

// ###################################################################
 // ① 三个工具的执行体（Day 16-18 的精简安全实现）
// ###################################################################

// ---- Calculator：递归下降，无 eval ----
class ToolExecError extends Error {}

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
    if (peek() === "-") {
      next();
      return -parseUnary();
    }
    if (peek() === "+") {
      next();
      return parseUnary();
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

// ---- Time：Intl 探针 + 结构化返回 ----
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
    hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekdayZh: Record<string, string> = {
    Mon: "星期一", Tue: "星期二", Wed: "星期三", Thu: "星期四",
    Fri: "星期五", Sat: "星期六", Sun: "星期日",
  };
  return {
    timezone,
    hourMinute: `${get("hour").padStart(2, "0")}:${get("minute")}`,
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: weekdayZh[get("weekday")] ?? get("weekday"),
  };
}

// ---- Weather：Mock 固定快照 + 归一化 ----
const SNAPSHOT_AT = "2026-10-04T10:00:00+08:00";
const MOCK_TABLE: Record<string, { temperatureC: number; condition: string; precipitationMm: number }> = {
  北京: { temperatureC: 22, condition: "晴", precipitationMm: 0 },
  上海: { temperatureC: 24, condition: "多云", precipitationMm: 0 },
  广州: { temperatureC: 28, condition: "雷阵雨", precipitationMm: 6 },
  深圳: { temperatureC: 27, condition: "中雨", precipitationMm: 8 },
  成都: { temperatureC: 19, condition: "阴", precipitationMm: 0 },
  杭州: { temperatureC: 23, condition: "小雨", precipitationMm: 2 },
};
const CITY_ALIASES: Record<string, string> = {
  beijing: "北京", shanghai: "上海", guangzhou: "广州", shenzhen: "深圳",
  chengdu: "成都", hangzhou: "杭州", bj: "北京", sh: "上海", gz: "广州", sz: "深圳",
};
function normalizeCity(raw: string): string | null {
  const lowered = raw.trim().replace(/\s+/g, " ").toLowerCase();
  if (CITY_ALIASES[lowered]) return CITY_ALIASES[lowered];
  const stripped = raw.trim().replace(/(市|省)$/u, "");
  return MOCK_TABLE[stripped] ? stripped : null;
}
function getWeather(city: string) {
  const canonical = normalizeCity(city);
  if (!canonical) {
    throw new ToolExecError(`未知城市："${city}"，覆盖：${Object.keys(MOCK_TABLE).join("、")}`);
  }
  return { city: canonical, observedAt: SNAPSHOT_AT, dataSource: "mock" as const, ...MOCK_TABLE[canonical] };
}

// ###################################################################
 // ② ToolHandler 契约 与 ToolRegistry
// ###################################################################

interface ToolHandler<T = any> {
  /** 与工具定义中 function.name 一致，Registry 以它为键 */
  name: string;
  /** 发给 LLM 的工具定义（JSON Schema） */
  definition: OpenAI.Chat.Completions.ChatCompletionTool;
  /** 参数校验 schema */
  schema: z.ZodType<T>;
  /** 执行体：只接收已通过校验的参数；抛错由 Registry 兜底 */
  run(args: T): unknown;
}

type FailStage = "lookup" | "parse" | "validate" | "execute";
type ExecResult =
  | { ok: true; data: unknown }
  | { ok: false; stage: FailStage; error: string; details?: unknown };

class ToolRegistry {
  private handlers = new Map<string, ToolHandler>();

  register(handler: ToolHandler): void {
    if (this.handlers.has(handler.name)) {
      throw new Error(`工具重复注册：${handler.name}`);
    }
    if (handler.definition.function.name !== handler.name) {
      throw new Error(`工具名不一致：${handler.name} vs definition ${handler.definition.function.name}`);
    }
    this.handlers.set(handler.name, handler);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  get(name: string): ToolHandler | undefined {
    return this.handlers.get(name);
  }

  /** 全部工具定义——直接作为 API 的 tools 参数 */
  definitions(): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return [...this.handlers.values()].map((h) => h.definition);
  }

  /**
   * 四阶段执行流水线：
   *   lookup → parse → validate → execute
   * 任何阶段失败都不抛异常，返回 { ok:false, stage }，由调用方决定如何回传。
   */
  execute(name: string, rawArguments: string): ExecResult {
    const handler = this.handlers.get(name);
    if (!handler) {
      return { ok: false, stage: "lookup", error: `未注册的工具："${name}"` };
    }

    let raw: unknown;
    try {
      raw = rawArguments ? JSON.parse(rawArguments) : {};
    } catch (e) {
      return {
        ok: false,
        stage: "parse",
        error: `工具参数不是合法 JSON：${e instanceof Error ? e.message : String(e)}`,
      };
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
      return {
        ok: false,
        stage: "execute",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

// ###################################################################
 // ③ 注册三个工具
// ###################################################################

const registry = new ToolRegistry();

registry.register({
  name: "calculator",
  definition: {
    type: "function",
    function: {
      name: "calculator",
      description: "精确数学计算器。需要数值计算时调用，不要心算。支持 + - * / % ^ ( )。",
      parameters: {
        type: "object",
        properties: { expression: { type: "string", description: "如 (199*0.85)-20" } },
        required: ["expression"],
      },
    },
  },
  schema: z.object({
    expression: z.string().min(1, "expression 不能为空").max(200, "expression 过长"),
  }),
  run: ({ expression }) => ({ expression, result: calculate(expression) }),
});

registry.register({
  name: "get_current_time",
  definition: {
    type: "function",
    function: {
      name: "get_current_time",
      description: "获取 IANA 时区当前的时间、日期、星期。询问时间/星期/日期时调用。",
      parameters: {
        type: "object",
        properties: {
          timezone: { type: "string", description: `IANA 名；不填默认 ${DEFAULT_TZ}` },
        },
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
      description: "查询城市天气（温度、状况、降水量）。问天气/气温/下雨时调用。",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "城市名，中文/拼音/英文均可" } },
        required: ["city"],
      },
    },
  },
  schema: z.object({ city: z.string().min(1, "city 不能为空") }),
  run: ({ city }) => getWeather(city),
});

// ###################################################################
 // ④ Part A：Registry 五项能力的确定性单元测试
// ###################################################################

interface UnitCase {
  id: string;
  ability: string;
  actual: unknown;
  expected: unknown;
  pass: boolean;
}

function check(id: string, ability: string, actual: unknown, expected: unknown): UnitCase {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  return { id, ability, actual, expected, pass };
}

function runUnitTests(): UnitCase[] {
  const cases: UnitCase[] = [];

  // 1. 注册 + 查找
  cases.push(check("U1", "注册/查找：已注册工具存在", registry.has("calculator"), true));
  cases.push(check("U2", "查找：未注册工具不存在", registry.has("nonexistent_tool"), false));

  // 2. 执行成功路径
  const okCalc = registry.execute("calculator", '{"expression":"(15+27)*13"}');
  cases.push(check("U3", "执行：calculator 正确求值", okCalc, {
    ok: true,
    data: { expression: "(15+27)*13", result: 546 },
  }));

  // 3. lookup 阶段：未注册名
  const badLookup = registry.execute("fake_tool", "{}");
  cases.push(check("U4", "错误处理-lookup：未注册名", badLookup, {
    ok: false, stage: "lookup", error: '未注册的工具："fake_tool"',
  }));

  // 4. parse 阶段：非法 JSON
  const badParse = registry.execute("calculator", "{not json");
  cases.push(check("U5", "错误处理-parse：参数非 JSON", badParse.ok === false && (badParse as any).stage, "parse"));

  // 5. validate 阶段：类型错误 / 缺必填
  const badValidate1 = registry.execute("calculator", '{"expression": 123}');
  cases.push(check("U6", "参数校验：expression 非字符串", badValidate1.ok === false && (badValidate1 as any).stage, "validate"));
  const badValidate2 = registry.execute("get_weather", '{}');
  cases.push(check("U7", "参数校验：缺必填 city", badValidate2.ok === false && (badValidate2 as any).stage, "validate"));

  // 6. execute 阶段：执行体错误（除零 / 未知城市）
  const badExec1 = registry.execute("calculator", '{"expression":"1/0"}');
  cases.push(check("U8", "错误处理-execute：除零", badExec1, {
    ok: false, stage: "execute", error: "除数不能为 0",
  }));
  const badExec2 = registry.execute("get_weather", '{"city":"火星基地"}');
  cases.push(check("U9", "错误处理-execute：未知城市", badExec2.ok === false && (badExec2 as any).stage, "execute"));

  // 7. definitions：三个定义且名称集合正确
  const defNames = registry.definitions().map((d) => d.function.name).sort();
  cases.push(check("U10", "注册：definitions 集合", defNames, ["calculator", "get_current_time", "get_weather"]));

  return cases;
}

// ###################################################################
 // ⑤ Part B：真实 LLM 集成（编排循环工具无关）
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
    console.warn(`[day19] 网络错误（第 ${attempt} 次），2s 后重试`);
    await sleep(2000);
    return createChat(body, attempt + 1);
  }
}

interface LLMTrace {
  name: string;
  args: string;
  stage?: FailStage;
  result: string;
}
interface LLMScenarioResult {
  id: string;
  title: string;
  finalAnswer: string;
  traces: LLMTrace[];
  apiRounds: number;
  correct: boolean;
  judgeNote: string;
  promptTokens: number;
  completionTokens: number;
}

async function runLLMScenario(id: string, title: string, userText: string): Promise<LLMScenarioResult> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "你可以使用 calculator / get_current_time / get_weather 三个工具。数值计算、实时信息必须调用对应工具，不要心算或编造；get_weather 返回 Mock 数据，转述时说明。一次可以并行调用多个工具。",
    },
    { role: "user", content: userText },
  ];

  const traces: LLMTrace[] = [];
  let finalAnswer = "";
  let apiRounds = 0;
  let promptTokens = 0;
  let completionTokens = 0;

  for (let round = 1; round <= 5; round++) {
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
      const execResult = registry.execute(call.function.name, call.function.arguments);
      const content = JSON.stringify(
        execResult.ok ? execResult.data : { error: execResult.error, stage: execResult.stage, ...("details" in execResult ? { details: execResult.details } : {}) },
      );
      traces.push({
        name: call.function.name,
        args: call.function.arguments,
        ...(execResult.ok ? {} : { stage: (execResult as any).stage }),
        result: content,
      });
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }

  const { correct, judgeNote } = judgeLLM(id, finalAnswer);
  return {
    id, title, finalAnswer, traces, apiRounds,
    correct, judgeNote, promptTokens, completionTokens,
  };
}

function answerHasNumber(answer: string, n: number): boolean {
  return new RegExp(`(^|[^0-9.])${String(n).replace(".", "\\.")}([^0-9]|$)`).test(answer.replace(/,/g, ""));
}

// gold 全部来自内置确定性实现
function judgeLLM(id: string, answer: string): { correct: boolean; judgeNote: string } {
  const text = answer.replace(/,/g, "");
  switch (id) {
    case "L1": {
      // 现在时间 → 应给出 HH:MM（同一瞬间 gold，允许 1 分钟误差）
      const gold = getCurrentTime();
      const re = /(\d{1,2})[:：](\d{2})/;
      const m = text.match(re);
      if (!m) return { correct: false, judgeNote: `未给出时间，gold≈${gold.hourMinute}` };
      const given = Number(m[1]) * 60 + Number(m[2]);
      const gMin = Number(gold.hourMinute.slice(0, 2)) * 60 + Number(gold.hourMinute.slice(3, 5));
      const ok = Math.abs(given - gMin) <= 1;
      return { correct: ok, judgeNote: `gold=${gold.hourMinute}，答复=${m[0]}` };
    }
    case "L2": {
      // 并行：深圳 27°C + 199*0.85=169.15
      const t1 = answerHasNumber(text, 27);
      const t2 = answerHasNumber(text, 169.15);
      return { correct: t1 && t2, judgeNote: `深圳27°C 命中=${t1}；折扣169.15 命中=${t2}` };
    }
    case "L3": {
      // 链式：北京22 vs 上海24，上海更高，温差 2（"北京比上海低 2"）
      const temps = answerHasNumber(text, 22) && answerHasNumber(text, 24);
      const diff = answerHasNumber(text, 2);
      const directionOk = /上海.{0,12}(高|热|暖)|北京.{0,12}(低|冷)/.test(text);
      return {
        correct: temps && diff && directionOk,
        judgeNote: `两城温度命中=${temps}；温差2命中=${diff}；方向(上海更高)命中=${directionOk}`,
      };
    }
    case "L4": {
      // 常识：不调用（judgeLLM 无 trace 信息——在调用处补充检查），讲出光合作用
      const ok = /光合/.test(text) && /(二氧化碳|CO2)/.test(text) && /(氧气|O2)/.test(text);
      return { correct: ok, judgeNote: `光合作用要素（光合/CO2/O2）齐全=${ok}` };
    }
    default:
      return { correct: false, judgeNote: "未知场景" };
  }
}

// ###################################################################
 // ⑥ 报告
// ###################################################################

function fmtTraces(r: LLMScenarioResult): string {
  if (r.traces.length === 0) return "（未调用工具）";
  return r.traces
    .map((t) => {
      const tag = t.stage ? ` ❌${t.stage}` : "";
      const result = t.result.length > 200 ? `${t.result.slice(0, 200)}...` : t.result;
      return `    - ${t.name} args \`${t.args}\` → \`${result}\`${tag}`;
    })
    .join("\n");
}

function buildMarkdown(unit: UnitCase[], llm: LLMScenarioResult[]): string {
  const date = new Date().toISOString().slice(0, 10);

  const unitPass = unit.filter((c) => c.pass).length;
  const unitRows = unit
    .map((c) => `| ${c.id} | ${c.ability} | \`${JSON.stringify(c.actual)}\` | ${c.pass ? "✅" : "❌"} |`)
    .join("\n");

  const llmCorrect = llm.filter((r) => r.correct).length;
  const llmRows = llm
    .map((r) => `| ${r.id} | ${r.title} | ${r.apiRounds} | ${r.traces.length} | ${r.correct ? "✅" : "❌"} |`)
    .join("\n");

  const promptTokens = llm.reduce((n, r) => n + r.promptTokens, 0);
  const completionTokens = llm.reduce((n, r) => n + r.completionTokens, 0);

  const details = llm
    .map((r) => `## ${r.id}：${r.title}

- 判分：${r.correct ? "✅" : "❌"} ${r.judgeNote}
- API 轮数：${r.apiRounds}
- 工具轨迹：
${fmtTraces(r)}
- 最终答复：

\`\`\`text
${r.finalAnswer.trim()}
\`\`\``)
    .join("\n\n---\n\n");

  return `# Day 19：Tool Registry —— 统一注册 / 查找 / 校验 / 执行 / 错误处理

> 日期：${date}
> 模型：${MODEL}（temperature=0）

## Part A：Registry 能力单元测试（${unitPass}/${unit.length}，零 API 成本）

| 用例 | 能力 | 实际值 | 结果 |
|---|---|---|---|
${unitRows}

## Part B：真实 LLM 集成（${llmCorrect}/4；Prompt Tokens ${promptTokens}，Completion Tokens ${completionTokens}）

| 场景 | 说明 | API 轮数 | 工具调用 | 结果 |
|---|---|---|---|---|
${llmRows}

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
  // Part A
  const unit = runUnitTests();
  for (const c of unit) {
    console.log(`[day19] ${c.pass ? "PASS" : "FAIL"} ${c.id} ${c.ability}`);
  }
  if (unit.some((c) => !c.pass)) {
    throw new Error("单元测试未全部通过，停止 LLM 实验");
  }

  // Part B
  const scenarios: { id: string; title: string; text: string }[] = [
    { id: "L1", title: "单工具（时间）", text: "现在几点了？" },
    { id: "L2", title: "并行双工具（天气+计算器）", text: "帮我查深圳现在的天气，顺便算一下 199 元打 85 折是多少钱。" },
    { id: "L3", title: "链式（两城天气→温差）", text: "北京和上海现在分别多少度？北京比上海低几度？" },
    { id: "L4", title: "常识不调用", text: "植物为什么能净化空气？一句话说明。" },
  ];

  const llm: LLMScenarioResult[] = [];
  for (const s of scenarios) {
    console.log(`[day19] === ${s.id} ${s.title} ===`);
    const r = await runLLMScenario(s.id, s.title, s.text);
    llm.push(r);
    console.log(`[day19]   correct=${r.correct} traces=${r.traces.length}`);
  }

  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs");
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, "day19-tool-registry.md");
  writeFileSync(outFile, buildMarkdown(unit, llm), "utf-8");
  console.log(`[day19] 结果已写入 ${outFile}`);
}

main().catch((err) => {
  console.error("[day19] 实验失败：", err);
  process.exit(1);
});
