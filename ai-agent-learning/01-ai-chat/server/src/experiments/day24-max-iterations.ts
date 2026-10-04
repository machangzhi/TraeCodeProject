/**
 * Day 24：MAX_ITERATIONS —— 给 Agent 循环装上硬上限
 *
 * Day 22/23 的循环里有一个临时安全上限（TEMP_SAFETY_LIMIT=8），但它只是"到数就砍"：
 * 答案是一句占位文本，没有收尾、没有预算核算，也从未用确定性手段验证过"真的会停"。
 *
 * 今天把它正式化：
 *
 *   1. 硬上限 MAX_ITERATIONS = 10：while 循环最多 10 轮 LLM 决策；
 *   2. 协议一致性：第 10 轮的 tool_calls 仍会全部执行并回传（不允许 assistant
 *      tool_calls 悬空，否则消息历史违反 OpenAI 协议、状态无法恢复）；
 *   3. 强制收尾：达到上限后去掉 tools 再调一次 LLM，让它基于已获取的信息总结作答，
 *      而不是留一句生硬的占位符；收尾调用失败时写入明确的失败答复（兜底）；
 *   4. 预算守恒：llmCalls === iteration + (强制收尾 ? 1 : 0) ≤ MAX_ITERATIONS + 1，
 *      死循环的最坏成本是可计算的，而不是无限的。
 *
 * 验证策略（唯一变量 = LLM 是真是假）：
 *   Part A 用脚本化 Mock LLM 确定性复现"无限循环"——真实模型配合度太高，很难稳定
 *   触发死循环，而上限逻辑必须 100% 可验证。零 API 成本测试：正常结束 / 跑满上限 /
 *   小上限配置 / 收尾失败兜底 / 预算守恒 / 并行协议 / 校准不变量检查器本身。
 *   Part B 用真实 LLM：正常链路不被上限误伤 + "中毒工具"（永远返回"请重试"）观察
 *   真实模型的放弃行为，并验证最坏情况下循环必然终止。
 *
 * 运行：npx tsx src/experiments/day24-max-iterations.ts
 * 输出：01-ai-chat/docs/day24-max-iterations.md
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
 // ① 工具执行体（沿用 Day 16-23 的安全实现）
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
 // ② ToolRegistry（Day 19/20 成果复用，支持注入"中毒工具"）
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

function makeRegistry(opts: { poisonWeather: boolean } = { poisonWeather: false }): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register({
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
  reg.register({
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
  reg.register({
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
    // 中毒模式：无论查哪个城市，永远返回"临时错误，请重试"——模拟最恶性的工具故障，
    // 用于观察真实模型会不会陷入"重试→失败→再重试"的循环，以及上限能否兜住。
    run: opts.poisonWeather
      ? ({ city }) => {
          throw new ToolExecError(`天气服务临时不可用（查询了 "${city}"），请稍后重试`);
        }
      : ({ city }) => getWeather(city),
  });
  reg.register({
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
  return reg;
}

// ###################################################################
 // ③ AgentState（Day 23 成果扩展：stopReason / 强制收尾 / 预算核算）
// ###################################################################

type StopReason = "finished" | "max_iterations";

interface ToolCallRecord {
  seq: number;
  callId: string;
  iteration: number;
  name: string;
  args: string;
  ok: boolean;
  output: unknown;
  failedStage?: FailStage;
  at: string;
}

type AgentStatus = "running" | "finished";

class AgentState {
  readonly messages: OpenAI.Chat.ChatCompletionMessageParam[];
  readonly toolCalls: ToolCallRecord[] = [];
  iteration = 0;
  status: AgentStatus = "running";
  answer = "";
  /** 循环为何结束：模型自行收尾（finished）或触发硬上限（max_iterations） */
  stopReason: StopReason | null = null;
  /** 是否发起过强制收尾调用（含失败尝试） */
  forcedFinalAttempted = false;
  /** 强制收尾是否成功拿到非空答复 */
  forcedFinalOk = false;
  /** LLM 实际被调用的总次数（含强制收尾）——预算核算的核心字段 */
  llmCalls = 0;
  readonly maxIterations: number;
  promptTokens = 0;
  completionTokens = 0;
  startedAt: string;
  updatedAt: string;

  constructor(systemPrompt: string, userInput: string, maxIterations: number) {
    this.messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userInput },
    ];
    this.maxIterations = maxIterations;
    this.startedAt = new Date().toISOString();
    this.updatedAt = this.startedAt;
  }

  private touch(): void {
    this.updatedAt = new Date().toISOString();
  }

  nextIteration(): number {
    this.iteration += 1;
    this.touch();
    return this.iteration;
  }

  append(...msgs: OpenAI.Chat.ChatCompletionMessageParam[]): void {
    this.messages.push(...msgs);
    this.touch();
  }

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

  recordUsage(promptTokens: number, completionTokens: number): void {
    this.promptTokens += promptTokens;
    this.completionTokens += completionTokens;
    this.touch();
  }

  finish(answer: string, stopReason: StopReason): void {
    this.status = "finished";
    this.answer = answer;
    this.stopReason = stopReason;
    this.touch();
  }

  snapshot(): Record<string, unknown> {
    const last = this.messages[this.messages.length - 1];
    return {
      status: this.status,
      stopReason: this.stopReason,
      iteration: this.iteration,
      maxIterations: this.maxIterations,
      llmCalls: this.llmCalls,
      forcedFinalAttempted: this.forcedFinalAttempted,
      forcedFinalOk: this.forcedFinalOk,
      messageCount: this.messages.length,
      toolCallCount: this.toolCalls.length,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      lastRole: last?.role ?? null,
      updatedAt: this.updatedAt,
    };
  }
}

/**
 * 状态不变量检查器——上限逻辑的可信度来自它：
 *   R1 消息头：[0]=system，[1]=user；
 *   R2 协议一致：每个带 tool_calls 的 assistant 消息后，紧跟等量 tool 消息且 id 一一对应
 *      （悬空的 tool_calls 会让下一次 API 调用直接被拒）；
 *   R3 记账一致：toolCalls 记录数 === 消息里 tool 角色条数；
 *   R4 收尾完整：finished 状态下最后一条是 assistant 且内容非空；
 *   R5 上限硬约束：iteration ≤ maxIterations；
 *   R6 预算守恒：llmCalls === iteration + (强制收尾?1:0)，且 ≤ maxIterations+1。
 */
function checkInvariants(state: AgentState): string[] {
  const v: string[] = [];
  const msgs = state.messages;

  if (msgs[0]?.role !== "system") v.push(`R1 违规：messages[0] 应为 system，实际 ${msgs[0]?.role}`);
  if (msgs[1]?.role !== "user") v.push(`R1 违规：messages[1] 应为 user，实际 ${msgs[1]?.role}`);

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i] as OpenAI.Chat.ChatCompletionMessage;
    if (m.role === "assistant" && m.tool_calls?.length) {
      const n = m.tool_calls.length;
      const follows = msgs.slice(i + 1, i + 1 + n);
      const idsOk = follows.every((t, k) => {
        if (t.role !== "tool") return false;
        const expected = m.tool_calls![k].id;
        return (t as OpenAI.Chat.ChatCompletionToolMessageParam).tool_call_id === expected;
      });
      if (follows.length < n || !idsOk) {
        v.push(`R2 违规：第 ${i} 条 assistant 的 ${n} 个 tool_calls 未被等量同 id 的 tool 消息紧跟`);
      }
    }
  }

  const toolMsgCount = msgs.filter((m) => m.role === "tool").length;
  if (toolMsgCount !== state.toolCalls.length) {
    v.push(`R3 违规：tool 消息 ${toolMsgCount} 条 ≠ toolCalls 记录 ${state.toolCalls.length} 条`);
  }

  if (state.status === "finished") {
    const last = msgs[msgs.length - 1] as OpenAI.Chat.ChatCompletionMessage | undefined;
    if (last?.role !== "assistant" || !(last.content ?? "").trim()) {
      v.push(`R4 违规：结束状态最后一条应为非空 assistant 消息，实际 ${last?.role ?? "空"}`);
    }
  }

  if (state.iteration > state.maxIterations) {
    v.push(`R5 违规：iteration=${state.iteration} 超过上限 ${state.maxIterations}`);
  }

  const expectedCalls = state.iteration + (state.forcedFinalAttempted ? 1 : 0);
  if (state.llmCalls !== expectedCalls) {
    v.push(`R6 违规：llmCalls=${state.llmCalls} ≠ iteration(${state.iteration})+强制收尾(${state.forcedFinalAttempted ? 1 : 0})`);
  }
  if (state.llmCalls > state.maxIterations + 1) {
    v.push(`R6 违规：llmCalls=${state.llmCalls} 超过预算上限 maxIterations+1=${state.maxIterations + 1}`);
  }
  return v;
}

// ###################################################################
 // ④ Agent 主循环（MAX_ITERATIONS 正式实现）
// ###################################################################

const MAX_ITERATIONS = 10;

const SYSTEM_PROMPT =
  "你可以使用 calculator / get_current_time / get_weather / search。精确计算与实时信息必须调用工具，不要心算或编造；Mock 数据须说明；无依赖的调用同一轮并行；信息足够后用中文作答。";

type LLMResponse = {
  message: OpenAI.Chat.ChatCompletionMessage;
  usage: { prompt_tokens: number; completion_tokens: number };
};
type LLMFn = (
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  options: { tools?: OpenAI.Chat.Completions.ChatCompletionTool[] },
) => Promise<LLMResponse>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 真实 LLM 客户端：30s 超时 + 最多 3 次重试（Day 12 惯例） */
async function callLLM(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  options: { tools?: OpenAI.Chat.Completions.ChatCompletionTool[] },
  attempt = 1,
): Promise<LLMResponse> {
  try {
    const resp = await client.chat.completions.create(
      { model: MODEL, messages, temperature: 0, ...(options.tools ? { tools: options.tools } : {}) },
      { timeout: 30_000, maxRetries: 0 },
    );
    return {
      message: resp.choices[0].message,
      usage: {
        prompt_tokens: resp.usage?.prompt_tokens ?? 0,
        completion_tokens: resp.usage?.completion_tokens ?? 0,
      },
    };
  } catch (err) {
    if (attempt >= 3) throw err;
    console.warn(`[day24] 网络错误（第 ${attempt} 次），2s 后重试`);
    await sleep(2000);
    return callLLM(messages, options, attempt + 1);
  }
}

async function runAgent(
  llm: LLMFn,
  userInput: string,
  opts: { maxIterations?: number; registry?: ToolRegistry; systemPrompt?: string } = {},
): Promise<AgentState> {
  const maxIterations = opts.maxIterations ?? MAX_ITERATIONS;
  const registry = opts.registry ?? makeRegistry();
  const state = new AgentState(opts.systemPrompt ?? SYSTEM_PROMPT, userInput, maxIterations);

  let finished = false;
  while (!finished) {
    state.nextIteration();
    state.llmCalls += 1;
    const resp = await llm(state.messages, { tools: registry.definitions() });
    state.recordUsage(resp.usage.prompt_tokens, resp.usage.completion_tokens);
    const msg = resp.message;
    const calls = msg.tool_calls ?? [];

    // ---- 出口一：模型不再要求工具 → 自主收尾 ----
    if (calls.length === 0) {
      state.append(msg);
      state.finish(msg.content ?? "", "finished");
      finished = true;
      break;
    }

    // ---- 第 10 轮的 tool_calls 也必须执行完：不允许悬空 ----
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

    // ---- 出口二：达到硬上限 → 强制收尾，而不是生硬砍断 ----
    if (state.iteration >= maxIterations) {
      state.append({
        role: "user",
        content: `[system] 已达到最大迭代次数（${maxIterations}）。请基于以上已获取的信息直接给出最终中文答复；如任务未完成，请说明已完成的部分和未完成的原因。`,
      });
      state.llmCalls += 1;
      state.forcedFinalAttempted = true;
      try {
        const fin = await llm(state.messages, {}); // 关键：不带 tools，物理断绝继续调工具的可能
        state.recordUsage(fin.usage.prompt_tokens, fin.usage.completion_tokens);
        const answer = (fin.message.content ?? "").trim();
        if (answer) {
          state.append(fin.message);
          state.forcedFinalOk = true;
          state.finish(answer, "max_iterations");
        } else {
          const fallback = `[Agent 已达到最大迭代次数（${maxIterations}），收尾答复为空，任务未完成，已强制停止。]`;
          state.append({ role: "assistant", content: fallback });
          state.finish(fallback, "max_iterations");
        }
      } catch (err) {
        const fallback = `[Agent 已达到最大迭代次数（${maxIterations}），收尾调用失败：${err instanceof Error ? err.message : String(err)}，任务未完成，已强制停止。]`;
        state.append({ role: "assistant", content: fallback });
        state.finish(fallback, "max_iterations");
      }
      finished = true;
    }
  }

  return state;
}

// ###################################################################
 // ⑤ Part A：脚本化 Mock LLM —— 确定性复现死循环（零 API 成本）
// ###################################################################

type MockStep =
  | { kind: "tools"; calls: { name: string; args: string }[]; narration?: string }
  | { kind: "final"; answer: string };

const ZERO_USAGE = { prompt_tokens: 0, completion_tokens: 0 };

/**
 * 脚本耗尽后永远重复最后一个"工具步骤"——这就是确定性的无限循环。
 * 强制收尾调用（options 无 tools）按 forced 配置回答或抛错。
 */
function scriptedLLM(steps: MockStep[], forced: { answer?: string; fail?: boolean } = {}): LLMFn {
  let callIdx = 0;
  let stepIdx = 0;
  return async (_messages, options) => {
    if (!options.tools) {
      if (forced.fail) throw new Error("Mock 强制收尾调用网络错误");
      const msg: OpenAI.Chat.ChatCompletionMessage = {
        role: "assistant",
        content: forced.answer ?? "[Mock] 基于已获取的信息总结作答。",
        refusal: null,
      };
      return { message: msg, usage: ZERO_USAGE };
    }
    const step = steps[Math.min(stepIdx, steps.length - 1)];
    stepIdx += 1;
    if (step.kind === "final") {
      const msg: OpenAI.Chat.ChatCompletionMessage = {
        role: "assistant",
        content: step.answer,
        refusal: null,
      };
      return { message: msg, usage: ZERO_USAGE };
    }
    const msg: OpenAI.Chat.ChatCompletionMessage = {
      role: "assistant",
      content: step.narration ?? null,
      refusal: null,
      tool_calls: step.calls.map((c) => ({
        id: `mock_call_${++callIdx}`,
        type: "function" as const,
        function: { name: c.name, arguments: c.args },
      })),
    };
    return { message: msg, usage: ZERO_USAGE };
  };
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

interface UnitCase {
  id: string;
  descr: string;
  pass: boolean;
  detail: string;
}
function U(id: string, descr: string, cond: boolean, detail: string): UnitCase {
  return { id, descr, pass: cond, detail };
}

async function runUnitTests(): Promise<UnitCase[]> {
  const cs: UnitCase[] = [];
  const loopSteps: MockStep[] = [
    { kind: "tools", calls: [{ name: "calculator", args: '{"expression":"1+1"}' }], narration: "再算一次" },
  ];

  // A1 正常两轮结束
  {
    const st = await runAgent(scriptedLLM([
      { kind: "tools", calls: [{ name: "calculator", args: '{"expression":"1+1"}' }] },
      { kind: "final", answer: "答案是 2" },
    ]), "算一下 1+1");
    const inv = checkInvariants(st);
    cs.push(U("A1", "正常流程：2 轮结束、上限未触发、不变量全部通过",
      st.stopReason === "finished" && st.iteration === 2 && st.llmCalls === 2 && !st.forcedFinalAttempted && inv.length === 0,
      `stopReason=${st.stopReason} iter=${st.iteration} llmCalls=${st.llmCalls} 违规=${inv.length}`));
  }

  // A2 无限循环 → 恰好在第 10 轮被截停 + 强制收尾成功
  let a2State: AgentState;
  {
    a2State = await runAgent(scriptedLLM(loopSteps, { answer: "[Mock 收尾] 已执行 10 轮计算，均为 1+1=2，任务未产生新信息。" }), "无限算 1+1");
    const inv = checkInvariants(a2State);
    cs.push(U("A2", "死循环复现：恰好第 10 轮截停、强制收尾成功、不变量通过",
      a2State.stopReason === "max_iterations" && a2State.iteration === MAX_ITERATIONS
      && a2State.forcedFinalAttempted && a2State.forcedFinalOk
      && a2State.toolCalls.length === MAX_ITERATIONS && inv.length === 0,
      `iter=${a2State.iteration} llmCalls=${a2State.llmCalls} tools=${a2State.toolCalls.length} answer="${a2State.answer.slice(0, 30)}" 违规=${inv.length}`));
  }

  // A3 上限可配置：MAX=3 时恰好第 3 轮截停
  {
    const st = await runAgent(scriptedLLM(loopSteps, { answer: "[Mock 收尾] 3 轮。" }), "无限算 1+1", { maxIterations: 3 });
    const inv = checkInvariants(st);
    cs.push(U("A3", "上限可配置：MAX=3 恰好第 3 轮截停、llmCalls=4",
      st.stopReason === "max_iterations" && st.iteration === 3 && st.llmCalls === 4 && inv.length === 0,
      `iter=${st.iteration} llmCalls=${st.llmCalls} 违规=${inv.length}`));
  }

  // A4 强制收尾调用本身失败 → 兜底答复，状态依然完整
  {
    const st = await runAgent(scriptedLLM(loopSteps, { fail: true }), "无限算 1+1", { maxIterations: 4 });
    const inv = checkInvariants(st);
    const fallbackOk = /\[Agent 已达到最大迭代次数（4）/.test(st.answer);
    cs.push(U("A4", "收尾失败兜底：forcedFinalOk=false、兜底答复入历史、不变量通过",
      st.stopReason === "max_iterations" && st.forcedFinalAttempted && !st.forcedFinalOk && fallbackOk && inv.length === 0,
      `forcedFinalOk=${st.forcedFinalOk} answer="${st.answer.slice(0, 40)}" 违规=${inv.length}`));
  }

  // A5 预算守恒：最坏情况 LLM 次数 = 上限 + 1
  {
    cs.push(U("A5", "预算守恒：llmCalls = iteration+1 = MAX_ITERATIONS+1 ≤ 11",
      a2State.llmCalls === MAX_ITERATIONS + 1 && a2State.llmCalls <= MAX_ITERATIONS + 1,
      `llmCalls=${a2State.llmCalls}，公式=iteration(${a2State.iteration})+收尾(${a2State.forcedFinalAttempted ? 1 : 0})`));
  }

  // A6 并行调用的协议一致性
  {
    const st = await runAgent(scriptedLLM([
      { kind: "tools", calls: [
        { name: "calculator", args: '{"expression":"1+1"}' },
        { name: "get_current_time", args: "{}" },
      ] },
      { kind: "final", answer: "已完成。" },
    ], {}), "算 1+1 并告诉我时间");
    const inv = checkInvariants(st);
    cs.push(U("A6", "并行调用：单轮 2 个 tool_calls 均有对应 tool 回传、不变量通过",
      st.toolCalls.length === 2 && st.iteration === 2 && inv.length === 0,
      `tools=${st.toolCalls.length} iter=${st.iteration} 违规=${inv.length}`));
  }

  // A7 校准：故意破坏状态（抽走一条 tool 回传），检查器必须能抓到
  {
    const broken = await runAgent(scriptedLLM(loopSteps, { answer: "x" }), "无限算 1+1", { maxIterations: 2 });
    broken.messages.splice(3, 1); // 抽走第 1 条 tool 回传
    const inv = checkInvariants(broken);
    const caught = inv.some((s) => s.startsWith("R2") || s.startsWith("R3"));
    cs.push(U("A7", "校准检查器：抽走 tool 回传后必须报 R2/R3 违规（防止检查器形同虚设）",
      caught,
      `违规数=${inv.length}，首条=${inv[0] ?? "（无！校准失败）"}`));
  }

  return cs;
}

// ###################################################################
 // ⑥ Part B：真实 LLM 场景
// ###################################################################

interface ScenarioSpec {
  id: string;
  title: string;
  maxIterations: number;
  poisonWeather: boolean;
  text: string;
  judge: (state: AgentState) => { pass: boolean; note: string };
}

const realScenarios: ScenarioSpec[] = [
  {
    id: "B1",
    title: "正常链式·search→calculator（上限不误伤）",
    maxIterations: MAX_ITERATIONS,
    poisonWeather: false,
    text: "特斯拉股价相比上一交易日收盘价涨了多少美元？涨幅百分之多少？",
    judge: (st) => {
      const goldDiff = Number(calculate("252.14-240.50").toFixed(2));
      const goldPct = Number(calculate("(252.14-240.50)/240.50*100").toFixed(2));
      const d = answerHas(st.answer, goldDiff, 0.02);
      const p = answerHas(st.answer, goldPct, 0.05);
      const seq = st.toolCalls.map((t) => t.name).join(" → ");
      return {
        pass: st.stopReason === "finished" && d && p && st.iteration < MAX_ITERATIONS,
        note: `gold 差额=${goldDiff} 命中=${d}；gold 涨幅=${goldPct}% 命中=${p}；stopReason=${st.stopReason}；序列=${seq}`,
      };
    },
  },
  {
    id: "B2",
    title: "零工具·常识（1 轮即结束）",
    maxIterations: MAX_ITERATIONS,
    poisonWeather: false,
    text: "水在标准大气压下沸点是多少？",
    judge: (st) => ({
      pass: answerHas(st.answer, 100) && st.toolCalls.length === 0 && st.iteration === 1 && st.stopReason === "finished",
      note: `gold=100；iteration=${st.iteration}；工具=${st.toolCalls.length}；stopReason=${st.stopReason}`,
    }),
  },
  {
    id: "B3",
    title: "中毒工具·第 1 次（MAX=3 观察放弃行为）",
    maxIterations: 3,
    poisonWeather: true,
    text: "北京现在天气怎么样？多少度？",
    judge: (st) => {
      const weatherTries = st.toolCalls.filter((t) => t.name === "get_weather").length;
      const honest = /失败|错误|无法|不可用|暂时|稍后|重试|故障|异常|未能/.test(st.answer);
      return {
        pass: st.status === "finished" && st.iteration <= 3 && st.llmCalls <= 4 && honest,
        note: `get_weather 尝试=${weatherTries} 次；stopReason=${st.stopReason}；如实转述=${honest}；llmCalls=${st.llmCalls}`,
      };
    },
  },
  {
    id: "B4",
    title: "中毒工具·第 2 次（MAX=3 报分布）",
    maxIterations: 3,
    poisonWeather: true,
    text: "帮我看看深圳今天多少度，要不要带伞？",
    judge: (st) => {
      const weatherTries = st.toolCalls.filter((t) => t.name === "get_weather").length;
      const honest = /失败|错误|无法|不可用|暂时|稍后|重试|故障|异常|未能/.test(st.answer);
      return {
        pass: st.status === "finished" && st.iteration <= 3 && st.llmCalls <= 4 && honest,
        note: `get_weather 尝试=${weatherTries} 次；stopReason=${st.stopReason}；如实转述=${honest}；llmCalls=${st.llmCalls}`,
      };
    },
  },
];

// ###################################################################
 // ⑦ 报告
// ###################################################################

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

function buildMarkdown(
  unit: UnitCase[],
  finals: { spec: ScenarioSpec; state: AgentState; pass: boolean; note: string }[],
): string {
  const date = new Date().toISOString().slice(0, 10);
  const upass = unit.filter((c) => c.pass).length;
  const bpass = finals.filter((f) => f.pass).length;
  const totalPrompt = finals.reduce((n, f) => n + f.state.promptTokens, 0);
  const totalCompletion = finals.reduce((n, f) => n + f.state.completionTokens, 0);

  const unitRows = unit
    .map((c) => `| ${c.id} | ${c.descr} | ${c.pass ? "✅" : "❌"} | \`${truncate(c.detail, 110)}\` |`)
    .join("\n");

  const bRows = finals
    .map((f) =>
      `| ${f.spec.id} | ${f.spec.title} | ${f.spec.maxIterations} | ${f.state.iteration} | ${f.state.llmCalls} | ${f.state.toolCalls.length} | ${f.state.stopReason} | ${f.pass ? "✅" : "❌"} |`)
    .join("\n");

  const details = finals.map(({ spec, state, pass, note }) => {
    const tcalls = state.toolCalls
      .map((t) => `    ${t.ok ? "✓" : "✗"} #${t.seq} 第${t.iteration}轮 ${t.name} \`${truncate(t.args, 60)}\` → \`${truncate(JSON.stringify(t.output), 160)}\`${t.failedStage ? ` [${t.failedStage}]` : ""}`)
      .join("\n");
    const inv = checkInvariants(state);
    return `## ${spec.id}：${spec.title}

- 判分：${pass ? "✅" : "❌"} ${note}
- 用户输入：${spec.text}
- MAX_ITERATIONS=${spec.maxIterations}；状态快照：\`${JSON.stringify(state.snapshot())}\`
- 不变量检查：${inv.length === 0 ? "✅ 零违规" : `❌ ${inv.join("；")}`}
- 工具记录：
${tcalls || "（零调用）"}
- 最终答复：

\`\`\`text
${state.answer.trim()}
\`\`\``;
  }).join("\n\n---\n\n");

  return `# Day 24：MAX_ITERATIONS —— 给 Agent 循环装上硬上限

> 日期：${date}
> 模型：${MODEL}（temperature=0；Part A 为脚本化 Mock，零 API 成本）

## 设计要点

- \`MAX_ITERATIONS = ${MAX_ITERATIONS}\`：第 10 轮的 tool_calls 仍执行完（协议不允许悬空），随后**去掉 tools 强制收尾**一次，让模型基于已有信息总结；收尾失败写入明确兜底答复。
- 预算守恒：\`llmCalls = iteration + (强制收尾?1:0) ≤ MAX_ITERATIONS + 1\`，死循环最坏成本可计算。
- 不变量检查器 R1-R6 随每次运行校验（含 A7 对检查器本身的校准）。

## Part A：Mock 死循环单测（${upass}/${unit.length}，零 API）

| 用例 | 断言 | 结果 | 详情 |
|---|---|---|---|
${unitRows}

## Part B：真实 LLM（${bpass}/${finals.length}；Prompt Tokens ${totalPrompt}，Completion Tokens ${totalCompletion}）

| 场景 | 说明 | MAX | 轮数 | llmCalls | 工具次数 | stopReason | 结果 |
|---|---|---|---|---|---|---|---|
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
  console.log(`[day24] Part A：Mock 单测开始（MAX_ITERATIONS=${MAX_ITERATIONS}）`);
  const unit = await runUnitTests();
  for (const c of unit) console.log(`[day24] ${c.pass ? "PASS" : "FAIL"} ${c.id} ${c.descr}`);
  if (unit.some((c) => !c.pass)) throw new Error("Part A 单测未全通过，停止（先修循环逻辑再跑真实场景）");

  const finals: { spec: ScenarioSpec; state: AgentState; pass: boolean; note: string }[] = [];
  for (const spec of realScenarios) {
    console.log(`[day24] === ${spec.id} ${spec.title} ===`);
    const registry = makeRegistry({ poisonWeather: spec.poisonWeather });
    const state = await runAgent(callLLM, spec.text, {
      maxIterations: spec.maxIterations,
      registry,
    });
    const j = spec.judge(state);
    const inv = checkInvariants(state);
    finals.push({ spec, state, pass: j.pass && inv.length === 0, note: `${j.note}${inv.length ? `；不变量违规=${inv.join("；")}` : ""}` });
    console.log(`[day24]   pass=${j.pass} iter=${state.iteration} llmCalls=${state.llmCalls} stop=${state.stopReason}`);
  }

  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs");
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, "day24-max-iterations.md");
  writeFileSync(outFile, buildMarkdown(unit, finals), "utf-8");
  console.log(`[day24] 已写入 ${outFile}`);
}

main().catch((err) => {
  console.error("[day24] 失败：", err);
  process.exit(1);
});
