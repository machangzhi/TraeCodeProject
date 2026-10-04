/**
 * Day 23：Agent State —— 把循环状态显式化
 *
 * Day 22 的循环里，messages、iteration、工具执行记录都是 runAgent 的局部变量：
 * 循环结束它们就消失，外部看不见、存不下、也无法从中断处恢复。
 *
 * 今天把它们收敛为一个显式状态对象：
 *
 *   AgentState = {
 *     messages:  Message[]         // 对话历史（喂给 LLM 的唯一输入）
 *     toolCalls: ToolCallRecord[]  // 每次工具调用的结构化记录
 *     iteration: number           // 当前 LLM 轮次
 *     status:    "running" | "finished"
 *   }
 *
 * 收益：① 循环每一步都变成对 state 的显式转换，可检查不变量；
 *       ② snapshot() 可随时序列化为 JSON——可持久化、可调试、可恢复；
 *       ③ 明天 Day 24 的 MAX_ITERATIONS 直接读 state.iteration；
 *          Day 26 Memory 直接复用 state.messages。
 *
 * 实验：Part A 状态转换单元测试（零成本）；Part B 真实 LLM 4 场景。
 *
 * 运行：npx tsx src/experiments/day23-agent-state.ts
 * 输出：01-ai-chat/docs/day23-agent-state.md
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
 // ① 工具（沿用 Day 16-22 的安全实现）
// ###################################################################

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
  if (!isValidTimezone(timezone)) throw new ToolExecError(`非法时区："${timezone}"`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    timezone,
    hourMinute: `${get("hour").padStart(2, "0")}:${get("minute")}`,
    date: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

const SNAPSHOT_AT = "2026-10-04T10:00:00+08:00";
const MOCK_WEATHER: Record<string, { temperatureC: number; condition: string; precipitationMm: number }> = {
  北京: { temperatureC: 22, condition: "晴", precipitationMm: 0 },
  上海: { temperatureC: 24, condition: "多云", precipitationMm: 0 },
  深圳: { temperatureC: 27, condition: "中雨", precipitationMm: 8 },
};
function getWeather(city: string) {
  const stripped = city.trim().replace(/(市|省)$/u, "");
  const hit = MOCK_WEATHER[stripped];
  if (!hit) throw new ToolExecError(`未知城市："${city}"，覆盖：${Object.keys(MOCK_WEATHER).join("、")}`);
  return { city: stripped, observedAt: SNAPSHOT_AT, dataSource: "mock" as const, ...hit };
}

const MOCK_SEARCH: { pattern: RegExp; title: string; snippet: string }[] = [
  {
    pattern: /(特斯拉|tesla|tsla)/i,
    title: "TSLA 行情（Mock）",
    snippet: "特斯拉(TSLA)报 252.14 美元，上一交易日收盘价 240.50 美元。",
  },
];
function search(query: string) {
  const q = query.trim();
  if (!q) throw new ToolExecError("query 不能为空");
  const hits = MOCK_SEARCH.filter((e) => e.pattern.test(q));
  return {
    query: q,
    searchedAt: new Date().toISOString(),
    dataSource: "mock" as const,
    results: hits.length
      ? hits.map((h) => ({ title: h.title, snippet: h.snippet, url: "https://example.com/mock" }))
      : [{ title: "无结果（Mock）", snippet: `没有与 "${q}" 相关条目。`, url: "" }],
  };
}

// ###################################################################
 // ② ToolRegistry
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
  register(h: ToolHandler): void {
    if (this.handlers.has(h.name)) throw new Error(`工具重复注册：${h.name}`);
    if (h.definition.function.name !== h.name) throw new Error(`工具名不一致：${h.name}`);
    this.handlers.set(h.name, h);
  }
  definitions(): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return [...this.handlers.values()].map((h) => h.definition);
  }
  execute(name: string, rawArguments: string): ExecResult {
    const h = this.handlers.get(name);
    if (!h) return { ok: false, stage: "lookup", error: `未注册的工具："${name}"` };
    let raw: unknown;
    try {
      raw = rawArguments ? JSON.parse(rawArguments) : {};
    } catch (e) {
      return { ok: false, stage: "parse", error: `参数不是合法 JSON：${e instanceof Error ? e.message : String(e)}` };
    }
    const parsed = h.schema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false, stage: "validate", error: "参数校验失败",
        details: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      };
    }
    try {
      return { ok: true, data: h.run(parsed.data) };
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
        properties: { expression: { type: "string" } },
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
      description: "获取时区当前时间/日期。",
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
      description: "查询城市天气（温度、状况、降水量）。",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
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
      description: "搜索实时信息（股价、新闻）。常识问题不要调用。",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  schema: z.object({ query: z.string().min(1).max(100) }),
  run: ({ query }) => search(query),
});

// ###################################################################
 // ③ AgentState —— 今天的核心
// ###################################################################

interface ToolCallRecord {
  seq: number; // 第几次工具调用（全局序号）
  callId: string;
  iteration: number; // 发生在第几轮 LLM
  name: string;
  args: string;
  ok: boolean;
  output: unknown;
  failedStage?: FailStage;
  at: string;
}

type AgentStatus = "running" | "finished";

interface StateSnapshot {
  status: AgentStatus;
  iteration: number;
  messageCount: number;
  toolCallCount: number;
  promptTokens: number;
  completionTokens: number;
  lastRole: string | null;
  updatedAt: string;
}

class AgentState {
  readonly messages: OpenAI.Chat.ChatCompletionMessageParam[];
  readonly toolCalls: ToolCallRecord[] = [];
  iteration = 0;
  status: AgentStatus = "running";
  answer = "";
  promptTokens = 0;
  completionTokens = 0;
  startedAt: string;
  updatedAt: string;

  constructor(systemPrompt: string, userInput: string) {
    this.messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userInput },
    ];
    this.startedAt = new Date().toISOString();
    this.updatedAt = this.startedAt;
  }

  private touch(): void {
    this.updatedAt = new Date().toISOString();
  }

  /** 进入下一轮 LLM */
  nextIteration(): number {
    this.iteration += 1;
    this.touch();
    return this.iteration;
  }

  /** 追加一条/多条消息（assistant 决策、tool 结果） */
  append(...msgs: OpenAI.Chat.ChatCompletionMessageParam[]): void {
    this.messages.push(...msgs);
    this.touch();
  }

  /** 记录一次工具调用的完整结果 */
  recordToolCall(rec: Omit<ToolCallRecord, "seq" | "at">): ToolCallRecord {
    const full: ToolCallRecord = {
      ...rec,
      seq: this.toolCalls.length + 1,
      at: new Date().toISOString(),
    };
    this.toolCalls.push(full);
    this.touch();
    return full;
  }

  /** 累计一次 LLM 响应的 token 用量 */
  recordUsage(promptTokens: number, completionTokens: number): void {
    this.promptTokens += promptTokens;
    this.completionTokens += completionTokens;
    this.touch();
  }

  /** 循环正常结束 */
  finish(answer: string): void {
    this.status = "finished";
    this.answer = answer;
    this.touch();
  }

  /** 轻量摘要 */
  snapshot(): StateSnapshot {
    const last = this.messages[this.messages.length - 1];
    return {
      status: this.status,
      iteration: this.iteration,
      messageCount: this.messages.length,
      toolCallCount: this.toolCalls.length,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      lastRole: last?.role ?? null,
      updatedAt: this.updatedAt,
    };
  }
}

// ###################################################################
 // ④ Part A：状态转换单元测试
// ###################################################################

interface UnitCase {
  id: string;
  descr: string;
  pass: boolean;
  detail: string;
}
function U(id: string, descr: string, cond: boolean, detail: string): UnitCase {
  return { id, descr, pass: cond, detail };
}

function runStateUnitTests(): UnitCase[] {
  const cs: UnitCase[] = [];
  const s = new AgentState("sys", "hello");

  cs.push(U("T1", "初始：2 条消息、iteration=0、running",
    s.messages.length === 2 && s.iteration === 0 && s.status === "running",
    JSON.stringify(s.snapshot())));

  const it1 = s.nextIteration();
  cs.push(U("T2", "nextIteration：iteration=1", it1 === 1 && s.iteration === 1, `iteration=${s.iteration}`));

  // 模拟一轮 assistant 工具调用 + tool 结果
  s.append({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "calculator", arguments: '{"expression":"1+1"}' } }] });
  s.recordToolCall({ callId: "c1", iteration: 1, name: "calculator", args: '{"expression":"1+1"}', ok: true, output: { result: 2 } });
  s.append({ role: "tool", tool_call_id: "c1", content: '{"result":2}' });

  cs.push(U("T3", "一轮后：消息 +3（assistant+tool）、1 次工具记录",
    s.messages.length === 4 && s.toolCalls.length === 1,
    `messages=${s.messages.length}, toolCalls=${s.toolCalls.length}`));

  cs.push(U("T4", "工具记录 seq 单调、绑定 iteration=1",
    s.toolCalls[0].seq === 1 && s.toolCalls[0].iteration === 1 && s.toolCalls[0].ok,
    JSON.stringify({ seq: s.toolCalls[0].seq, iter: s.toolCalls[0].iteration })));

  // 第二轮模型收尾
  s.nextIteration();
  s.append({ role: "assistant", content: "答案是 2" });
  s.finish("答案是 2");
  cs.push(U("T5", "收尾：status=finished、iteration=2、answer 已存",
    s.status === "finished" && s.iteration === 2 && s.answer === "答案是 2",
    JSON.stringify(s.snapshot())));

  // 失败调用记录
  const s2 = new AgentState("sys", "x");
  s2.nextIteration();
  s2.recordToolCall({ callId: "c9", iteration: 1, name: "get_weather", args: '{"city":"重庆"}', ok: false, output: { error: "未知城市" }, failedStage: "execute" });
  cs.push(U("T6", "失败记录保留 failedStage=execute",
    !s2.toolCalls[0].ok && s2.toolCalls[0].failedStage === "execute",
    `stage=${s2.toolCalls[0].failedStage}`));

  // 快照可序列化（为持久化/恢复验证）
  let serializable = true;
  try {
    JSON.stringify(s.snapshot());
    JSON.stringify(s2.snapshot());
  } catch {
    serializable = false;
  }
  cs.push(U("T7", "snapshot 可 JSON 序列化", serializable, JSON.stringify(s.snapshot())));

  return cs;
}

// ###################################################################
 // ⑤ Part B：真实 LLM，循环只操作 state
// ###################################################################

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function callLLM(messages: OpenAI.Chat.ChatCompletionMessageParam[], attempt = 1): Promise<OpenAI.Chat.ChatCompletion> {
  try {
    return await client.chat.completions.create(
      { model: MODEL, messages, temperature: 0, tools: registry.definitions() },
      { timeout: 30_000, maxRetries: 0 },
    );
  } catch (err) {
    if (attempt >= 3) throw err;
    console.warn(`[day23] 网络错误（第 ${attempt} 次），2s 后重试`);
    await sleep(2000);
    return callLLM(messages, attempt + 1);
  }
}

interface ScenarioSpec {
  id: string;
  title: string;
  text: string;
  judge: (state: AgentState) => { pass: boolean; note: string };
}

function answerHas(answer: string, n: number, tolerance = 0): boolean {
  const text = answer.replace(/,/g, "");
  const re = new RegExp(`(^|[^0-9.])${String(n).replace(".", "\\.")}([^0-9]|$)`);
  if (re.test(text)) return true;
  if (tolerance > 0) {
    return (text.match(/-?\d+(\.\d+)?/g) ?? []).some((x) => Math.abs(Number(x) - n) <= tolerance);
  }
  return false;
}

const TEMP_SAFETY_LIMIT = 8; // Day 24 正式化

async function runAgentWithState(userInput: string): Promise<AgentState> {
  const state = new AgentState(
    "你可以使用 calculator / get_current_time / get_weather / search。精确计算与实时信息必须调用工具，不要心算或编造；Mock 数据须说明；无依赖的调用同一轮并行；信息足够后用中文作答。",
    userInput,
  );

  let finished = false;
  while (!finished) {
    state.nextIteration();
    const resp = await callLLM(state.messages);
    state.recordUsage(resp.usage?.prompt_tokens ?? 0, resp.usage?.completion_tokens ?? 0);
    const msg = resp.choices[0].message;
    const calls = msg.tool_calls ?? [];

    if (calls.length === 0) {
      state.append(msg);
      state.finish(msg.content ?? "");
      finished = true;
      break;
    }

    state.append(msg);
    for (const call of calls) {
      const r = registry.execute(call.function.name, call.function.arguments);
      const output = r.ok
        ? r.data
        : { error: r.error, stage: r.stage, ...("details" in r && r.details ? { details: r.details } : {}) };
      const content = JSON.stringify(output);
      state.recordToolCall({
        callId: call.id, iteration: state.iteration,
        name: call.function.name, args: call.function.arguments,
        ok: r.ok, output, ...(r.ok ? {} : { failedStage: r.stage }),
      });
      state.append({ role: "tool", tool_call_id: call.id, content });
    }

    if (state.iteration >= TEMP_SAFETY_LIMIT) {
      state.finish("[达到安全上限]");
      finished = true;
    }
  }

  return state;
}

const scenarios: ScenarioSpec[] = [
  {
    id: "B1",
    title: "单步·时间",
    text: "现在几点了？",
    judge: (st) => {
      const gold = getCurrentTime();
      const m = st.answer.match(/(\d{1,2})[:：](\d{2})/);
      if (!m) return { pass: false, note: `未给时间 gold≈${gold.hourMinute}` };
      const given = Number(m[1]) * 60 + Number(m[2]);
      const g = Number(gold.hourMinute.slice(0, 2)) * 60 + Number(gold.hourMinute.slice(3, 5));
      return { pass: Math.abs(given - g) <= 1, note: `gold=${gold.hourMinute} 答复=${m[0]}；${JSON.stringify(st.snapshot())}` };
    },
  },
  {
    id: "B2",
    title: "链式·搜索→计算",
    text: "特斯拉股价相比上一交易日收盘价涨了多少美元？涨幅百分之多少？",
    judge: (st) => {
      const d = answerHas(st.answer, Number(calculate("252.14-240.50").toFixed(2)), 0.02);
      const p = answerHas(st.answer, Number(calculate("(252.14-240.50)/240.50*100").toFixed(2)), 0.05);
      return { pass: d && p, note: `差额命中=${d} 涨幅命中=${p}；${JSON.stringify(st.snapshot())}` };
    },
  },
  {
    id: "B3",
    title: "错误穿透·未覆盖城市",
    text: "重庆天气怎么样？",
    judge: (st) => {
      const failed = st.toolCalls.some((t) => !t.ok && t.failedStage === "execute");
      const ack = /未知|无法|查不到|覆盖|不支持/.test(st.answer);
      return { pass: failed && ack, note: `execute 失败=${failed} 转述=${ack}；${JSON.stringify(st.snapshot())}` };
    },
  },
  {
    id: "B4",
    title: "零工具·常识",
    text: "水在标准大气压下沸点是多少？",
    judge: (st) => ({
      pass: answerHas(st.answer, 100) && st.toolCalls.length === 0 && st.iteration === 1,
      note: `gold=100；${JSON.stringify(st.snapshot())}`,
    }),
  },
];

// ###################################################################
 // ⑥ 报告
// ###################################################################

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

function buildMarkdown(unit: UnitCase[], finals: { spec: ScenarioSpec; state: AgentState; pass: boolean; note: string }[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const upass = unit.filter((c) => c.pass).length;
  const bpass = finals.filter((f) => f.pass).length;

  const unitRows = unit.map((c) => `| ${c.id} | ${c.descr} | ${c.pass ? "✅" : "❌"} | \`${truncate(c.detail, 90)}\` |`).join("\n");
  const bRows = finals.map((f) => `| ${f.spec.id} | ${f.spec.title} | ${f.state.iteration} | ${f.state.messages.length} | ${f.state.toolCalls.length} | ${f.pass ? "✅" : "❌"} |`).join("\n");

  const totalPromptTokens = finals.reduce((n, f) => n + f.state.promptTokens, 0);
  const totalCompletionTokens = finals.reduce((n, f) => n + f.state.completionTokens, 0);
  const details = finals.map(({ spec, state, pass, note }) => {
    const tcalls = state.toolCalls.map((t) => `    ${t.ok ? "✓" : "✗"} #${t.seq} 第${t.iteration}轮 ${t.name} \`${t.args}\` → \`${truncate(JSON.stringify(t.output), 200)}\`${t.failedStage ? ` [${t.failedStage}]` : ""}`).join("\n");
    return `## ${spec.id}：${spec.title}

- 判分：${pass ? "✅" : "❌"} ${note}
- 最终状态快照：\`${JSON.stringify(state.snapshot())}\`
- 工具记录：
${tcalls || "（零调用）"}
- 最终答复：

\`\`\`text
${state.answer.trim()}
\`\`\``;
  }).join("\n\n---\n\n");

  return `# Day 23：Agent State —— messages / toolCalls / iteration 显式化

> 日期：${date}
> 模型：${MODEL}（temperature=0）

## Part A：状态转换单元测试（${upass}/${unit.length}，零 API）

| 用例 | 断言 | 结果 | 详情 |
|---|---|---|---|
${unitRows}

## Part B：真实 LLM（${bpass}/${finals.length}；Prompt Tokens ${totalPromptTokens}，Completion Tokens ${totalCompletionTokens}）

| 场景 | 说明 | iteration | 消息数 | 工具记录 | 结果 |
|---|---|---|---|---|---|
${bRows}

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
  const unit = runStateUnitTests();
  for (const c of unit) console.log(`[day23] ${c.pass ? "PASS" : "FAIL"} ${c.id} ${c.descr}`);
  if (unit.some((c) => !c.pass)) throw new Error("状态单测未全通过，停止");

  const finals: { spec: ScenarioSpec; state: AgentState; pass: boolean; note: string }[] = [];
  for (const spec of scenarios) {
    console.log(`[day23] === ${spec.id} ${spec.title} ===`);
    const state = await runAgentWithState(spec.text);
    const j = spec.judge(state);
    finals.push({ spec, state, pass: j.pass, note: j.note });
    console.log(`[day23]   pass=${j.pass} iter=${state.iteration} tools=${state.toolCalls.length}`);
  }

  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs");
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, "day23-agent-state.md");
  writeFileSync(outFile, buildMarkdown(unit, finals), "utf-8");
  console.log(`[day23] 已写入 ${outFile}`);
}

main().catch((err) => {
  console.error("[day23] 失败：", err);
  process.exit(1);
});
