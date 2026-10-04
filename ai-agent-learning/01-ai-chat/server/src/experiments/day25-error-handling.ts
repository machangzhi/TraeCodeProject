/**
 * Day 25：错误处理 —— 五类错误的分类学与循环级韧性
 *
 * 计划：处理 Tool不存在 / 参数错误 / Tool执行异常 / LLM异常 / 无限循环。
 * 此前已零散覆盖过其中几类：Day 19 execute 四阶段流水线、Day 22 A7 错误穿透、
 * Day 24 无限循环硬上限。今天把它们收敛为一张完整的错误分类表，
 * 并补上此前缺失的一层：**LLM 调用本身失败时，循环怎么办**。
 *
 * 错误分类学（前四类发生在工具层，第五类发生在模型层）：
 *   1. lookup   工具不存在 → 错误 JSON 回喂，模型转述/换路
 *   2. parse    参数不是合法 JSON → 回喂解析错误
 *   3. validate 参数不过 Zod → 回喂字段级 details
 *   4. execute  工具执行抛异常 → 回喂业务错误（可含修复引导）
 *   5. LLM 异常 → 循环层重试 3 次（指数外退避），耗尽则抛 AgentFailureError
 *      携带部分状态——宁可明确失败，也不伪造 finished；
 *      无限循环（Day 24 MAX_ITERATIONS）继续作为组合故障的最后兜底。
 *
 * 计账口径（Day 24 R6 不变量语义保持不变）：
 *   llmCalls    = 成功的 LLM 决策次数（R6: llmCalls === iteration + 强制收尾?1:0）
 *   llmAttempts = 全部尝试次数（含失败与重试）——重试成本的可观测字段
 *
 * 验证策略：
 *   Part A 脚本化 Mock 注入五类错误，零 API 成本验证：每类错误都能以
 *   "错误 JSON 回喂 + 循环存活" 或 "明确失败 + 状态保留" 收场；
 *   Part B 真实 LLM 少量场景：瞬时故障（fail-first 注入）下模型选择
 *   自愈重试还是如实放弃（2 跑报分布），以及未知城市错误引导的转述质量。
 *
 * 运行：npx tsx src/experiments/day25-error-handling.ts
 * 输出：01-ai-chat/docs/day25-error-handling.md
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
 // ① 工具执行体（沿用 Day 16-24 的安全实现）
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
  if (!hit) throw new ToolExecError(`未知城市："${city}"，当前覆盖：${Object.keys(MOCK_WEATHER).join("、")}`);
  return { city: stripped, observedAt: SNAPSHOT_AT, dataSource: "mock" as const, ...hit };
}

// ###################################################################
 // ② ToolRegistry（Day 19 四阶段 + Day 25 故障注入）
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
  /** 四阶段流水线，永不抛出——所有错误都变成结构化 ExecResult */
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

interface RegistryOpts {
  /** get_weather 前 N 次调用抛"瞬时过载"错误，之后成功（确定性故障注入） */
  weatherFailFirst?: number;
  /** 瞬时故障的错误文案（默认鼓励立即重试） */
  weatherFlakyMessage?: string;
}

function makeRegistry(opts: RegistryOpts = {}): ToolRegistry {
  const reg = new ToolRegistry();
  let weatherCalls = 0;
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
    run: ({ city }) => {
      weatherCalls += 1;
      if (opts.weatherFailFirst && weatherCalls <= opts.weatherFailFirst) {
        throw new ToolExecError(
          opts.weatherFlakyMessage ?? "天气服务瞬时过载（瞬时故障，立即重试一次通常即可成功）",
        );
      }
      return getWeather(city);
    },
  });
  return reg;
}

// ###################################################################
 // ③ AgentState（Day 24 成果扩展：llmAttempts 计账 + failed 状态）
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
  stopReason: StopReason | null = null;
  forcedFinalAttempted = false;
  forcedFinalOk = false;
  /** 成功的 LLM 决策次数（R6 不变量口径） */
  llmCalls = 0;
  /** 全部 LLM 尝试次数（含失败与重试）——重试成本可观测 */
  llmAttempts = 0;
  /** 最后一次 LLM 层错误摘要（失败时填充） */
  lastLLMError: string | null = null;
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
      llmAttempts: this.llmAttempts,
      forcedFinalAttempted: this.forcedFinalAttempted,
      forcedFinalOk: this.forcedFinalOk,
      lastLLMError: this.lastLLMError,
      messageCount: this.messages.length,
      toolCallCount: this.toolCalls.length,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      lastRole: last?.role ?? null,
      updatedAt: this.updatedAt,
    };
  }
}

/** 不变量检查器（同 Day 24 R1-R6；状态为 running 时 R4 自动跳过） */
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
  if (state.llmAttempts < state.llmCalls) {
    v.push(`R6 违规：llmAttempts=${state.llmAttempts} 不应小于 llmCalls=${state.llmCalls}`);
  }
  return v;
}

// ###################################################################
 // ④ Agent 主循环（Day 25：LLM 层重试 + 明确失败）
// ###################################################################

const MAX_ITERATIONS = 10;
const LLM_MAX_ATTEMPTS = 3;

const SYSTEM_PROMPT =
  "你可以使用 calculator / get_current_time / get_weather。精确计算与实时信息必须调用工具，不要心算或编造；Mock 数据须说明；无依赖的调用同一轮并行；信息足够后用中文作答。";

type LLMResponse = {
  message: OpenAI.Chat.ChatCompletionMessage;
  usage: { prompt_tokens: number; completion_tokens: number };
};
type LLMFn = (
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  options: { tools?: OpenAI.Chat.Completions.ChatCompletionTool[] },
) => Promise<LLMResponse>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 真实 LLM 客户端：单次尝试 30s 超时；重试策略统一上移到循环层，便于计账 */
async function callLLM(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  options: { tools?: OpenAI.Chat.Completions.ChatCompletionTool[] },
): Promise<LLMResponse> {
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
}

/** LLM 重试耗尽时抛出，携带部分状态——宁可明确失败，不伪造 finished */
class AgentFailureError extends Error {
  constructor(message: string, public readonly state: AgentState) {
    super(message);
    this.name = "AgentFailureError";
  }
}

async function runAgent(
  llm: LLMFn,
  userInput: string,
  opts: {
    maxIterations?: number;
    registry?: ToolRegistry;
    systemPrompt?: string;
    llmRetryBackoffMs?: number;
  } = {},
): Promise<AgentState> {
  const maxIterations = opts.maxIterations ?? MAX_ITERATIONS;
  const registry = opts.registry ?? makeRegistry();
  const backoffMs = opts.llmRetryBackoffMs ?? 2000;
  const state = new AgentState(opts.systemPrompt ?? SYSTEM_PROMPT, userInput, maxIterations);

  /** 带重试的一次 LLM 调用；耗尽时抛 AgentFailureError（含部分状态） */
  const callLLMWithRetry = async (options: { tools?: OpenAI.Chat.Completions.ChatCompletionTool[] }) => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= LLM_MAX_ATTEMPTS; attempt++) {
      state.llmAttempts += 1;
      try {
        return await llm(state.messages, options);
      } catch (err) {
        lastErr = err;
        state.lastLLMError = err instanceof Error ? err.message : String(err);
        if (attempt < LLM_MAX_ATTEMPTS) await sleep(backoffMs);
      }
    }
    throw new AgentFailureError(
      `LLM 连续 ${LLM_MAX_ATTEMPTS} 次调用失败，任务中止：${state.lastLLMError}`,
      state,
    );
  };

  let finished = false;
  while (!finished) {
    // 注意：iteration 在决策成功后才自增——LLM 失败的轮次不计入，
    // 这样 R6（llmCalls === iteration + 强制收尾）在失败路径下也成立。
    const resp = await callLLMWithRetry({ tools: registry.definitions() });
    state.nextIteration();
    state.llmCalls += 1;
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

    // ---- 出口二：硬上限 → 强制收尾（Day 24 机制，组合故障的最后兜底） ----
    if (state.iteration >= maxIterations) {
      state.append({
        role: "user",
        content: `[system] 已达到最大迭代次数（${maxIterations}）。请基于以上已获取的信息直接给出最终中文答复；如任务未完成，请说明已完成的部分和未完成的原因。`,
      });
      const fin = await callLLMWithRetry({}); // 不带 tools，物理断绝继续调工具
      state.llmCalls += 1;
      state.forcedFinalAttempted = true;
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
      finished = true;
    }
  }

  return state;
}

// ###################################################################
 // ⑤ Part A：脚本化 Mock 注入五类错误（零 API 成本）
// ###################################################################

type MockStep =
  | { kind: "tools"; calls: { name: string; args: string }[]; narration?: string }
  | { kind: "final"; answer: string };

const ZERO_USAGE = { prompt_tokens: 0, completion_tokens: 0 };

function scriptedLLM(
  steps: MockStep[],
  opts: { forcedAnswer?: string; failFirstInvocations?: number; invocationError?: Error } = {},
): LLMFn {
  let callIdx = 0;
  let stepIdx = 0;
  let invocations = 0;
  return async (_messages, options) => {
    invocations += 1;
    if (opts.failFirstInvocations && invocations <= opts.failFirstInvocations) {
      throw opts.invocationError ?? new Error("Mock LLM 网络错误（模拟服务端 500）");
    }
    if (!options.tools) {
      const msg: OpenAI.Chat.ChatCompletionMessage = {
        role: "assistant",
        content: opts.forcedAnswer ?? "[Mock 收尾] 基于已获取的信息总结作答。",
        refusal: null,
      };
      return { message: msg, usage: ZERO_USAGE };
    }
    const step = steps[Math.min(stepIdx, steps.length - 1)];
    stepIdx += 1;
    if (step.kind === "final") {
      const msg: OpenAI.Chat.ChatCompletionMessage = { role: "assistant", content: step.answer, refusal: null };
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

interface UnitCase {
  id: string;
  descr: string;
  pass: boolean;
  detail: string;
}
function U(id: string, descr: string, cond: boolean, detail: string): UnitCase {
  return { id, descr, pass: cond, detail };
}

function firstFailure(state: AgentState): { stage?: FailStage; error?: string } {
  const bad = state.toolCalls.find((t) => !t.ok);
  return bad ? { stage: bad.failedStage, error: JSON.stringify(bad.output).slice(0, 80) } : {};
}

async function runUnitTests(): Promise<UnitCase[]> {
  const cs: UnitCase[] = [];

  // A1 lookup：调用未注册工具
  {
    const st = await runAgent(scriptedLLM([
      { kind: "tools", calls: [{ name: "get_stock", args: '{"symbol":"TSLA"}' }] },
      { kind: "final", answer: "抱歉，我没有查询股票的工具。" },
    ], {}), "查一下特斯拉股价", { llmRetryBackoffMs: 0 });
    const inv = checkInvariants(st);
    const f = firstFailure(st);
    cs.push(U("A1", "lookup：未注册工具返回错误 JSON、循环存活、不变量通过",
      st.status === "finished" && f.stage === "lookup" && /未注册的工具/.test(f.error ?? "") && inv.length === 0,
      `stage=${f.stage} error="${f.error}" 违规=${inv.length}`));
  }

  // A2 parse：参数不是合法 JSON
  {
    const st = await runAgent(scriptedLLM([
      { kind: "tools", calls: [{ name: "calculator", args: '{"expression": "1+1"' }] },
      { kind: "final", answer: "参数格式出错了。" },
    ], {}), "算 1+1", { llmRetryBackoffMs: 0 });
    const inv = checkInvariants(st);
    const f = firstFailure(st);
    cs.push(U("A2", "parse：坏 JSON 参数返回解析错误、循环存活",
      st.status === "finished" && f.stage === "parse" && /合法 JSON/.test(f.error ?? "") && inv.length === 0,
      `stage=${f.stage} error="${f.error}" 违规=${inv.length}`));
  }

  // A3 validate：参数不过 Zod（空表达式）
  {
    const st = await runAgent(scriptedLLM([
      { kind: "tools", calls: [{ name: "calculator", args: '{"expression": ""}' }] },
      { kind: "final", answer: "表达式不能为空。" },
    ], {}), "算空表达式", { llmRetryBackoffMs: 0 });
    const inv = checkInvariants(st);
    const f = firstFailure(st);
    const hasDetails = st.toolCalls[0] && JSON.stringify(st.toolCalls[0].output).includes("details");
    cs.push(U("A3", "validate：Zod 失败回喂字段级 details、循环存活",
      st.status === "finished" && f.stage === "validate" && hasDetails === true && inv.length === 0,
      `stage=${f.stage} details=${hasDetails} output="${JSON.stringify(st.toolCalls[0]?.output).slice(0, 80)}"`));
  }

  // A4 execute：工具抛业务异常（未知城市，错误含覆盖引导）
  {
    const st = await runAgent(scriptedLLM([
      { kind: "tools", calls: [{ name: "get_weather", args: '{"city":"重庆"}' }] },
      { kind: "final", answer: "重庆暂不在覆盖范围。" },
    ], {}), "重庆天气", { llmRetryBackoffMs: 0 });
    const inv = checkInvariants(st);
    const f = firstFailure(st);
    cs.push(U("A4", "execute：业务异常回喂且错误自带覆盖引导、循环存活",
      st.status === "finished" && f.stage === "execute" && /未知城市/.test(f.error ?? "") && /覆盖/.test(f.error ?? "") && inv.length === 0,
      `stage=${f.stage} error="${f.error}"`));
  }

  // A5 LLM 瞬时异常：前 2 次失败，第 3 次成功 → 自愈
  {
    const st = await runAgent(scriptedLLM([
      { kind: "tools", calls: [{ name: "calculator", args: '{"expression":"1+1"}' }] },
      { kind: "final", answer: "答案是 2" },
    ], { failFirstInvocations: 2 }), "算 1+1", { llmRetryBackoffMs: 0 });
    const inv = checkInvariants(st);
    cs.push(U("A5", "LLM 自愈：前 2 次 500、第 3 次成功，llmAttempts=4、llmCalls=2",
      st.status === "finished" && st.iteration === 2 && st.llmCalls === 2 && st.llmAttempts === 4 && st.lastLLMError !== null && inv.length === 0,
      `iter=${st.iteration} llmCalls=${st.llmCalls} llmAttempts=${st.llmAttempts} lastErr="${st.lastLLMError}" 违规=${inv.length}`));
  }

  // A6 LLM 异常耗尽：3 次全败 → AgentFailureError + 部分状态不伪造 finished
  {
    let caught: AgentFailureError | null = null;
    try {
      await runAgent(scriptedLLM([{ kind: "final", answer: "x" }], {
        failFirstInvocations: 99,
      }), "任意输入", { llmRetryBackoffMs: 0 });
    } catch (e) {
      if (e instanceof AgentFailureError) caught = e;
    }
    const st = caught?.state;
    const inv = st ? checkInvariants(st) : ["未捕获到状态"];
    cs.push(U("A6", "LLM 耗尽：抛 AgentFailureError、状态保留为 running、不伪造答案",
      caught !== null && /连续 3 次调用失败/.test(caught.message)
      && st?.status === "running" && st.iteration === 0 && st.llmCalls === 0 && st.llmAttempts === 3 && inv.length === 0,
      `message="${caught?.message.slice(0, 60)}" iter=${st?.iteration} llmAttempts=${st?.llmAttempts} status=${st?.status} 违规=${inv.length}`));
  }

  // A7 组合故障：工具永远失败 + 模型永远重试 → MAX_ITERATIONS=3 兜底（衔接 Day 24）
  {
    const st = await runAgent(scriptedLLM([
      { kind: "tools", calls: [{ name: "get_weather", args: '{"city":"北京"}' }] },
    ], { forcedAnswer: "[Mock 收尾] 天气服务持续失败，已重试 3 轮，任务未完成。" }), "北京天气", {
      maxIterations: 3,
      registry: makeRegistry({ weatherFailFirst: 99 }),
      llmRetryBackoffMs: 0,
    });
    const inv = checkInvariants(st);
    const allFailed = st.toolCalls.length === 3 && st.toolCalls.every((t) => !t.ok && t.failedStage === "execute");
    cs.push(U("A7", "组合兜底：3 轮重试全败 → 上限截停 + 强制收尾，协议一致",
      st.stopReason === "max_iterations" && st.iteration === 3 && allFailed && st.forcedFinalOk && inv.length === 0,
      `iter=${st.iteration} tools=${st.toolCalls.length}(全败=${allFailed}) forcedFinalOk=${st.forcedFinalOk} 违规=${inv.length}`));
  }

  return cs;
}

// ###################################################################
 // ⑥ Part B：真实 LLM 场景
// ###################################################################

function answerHas(answer: string, n: number, tolerance = 0): boolean {
  const text = answer.replace(/,/g, "");
  const re = new RegExp(`(^|[^0-9.])${String(n).replace(".", "\\.")}([^0-9]|$)`);
  if (re.test(text)) return true;
  if (tolerance > 0) {
    return (text.match(/-?\d+(\.\d+)?/g) ?? []).some((x) => Math.abs(Number(x) - n) <= tolerance);
  }
  return false;
}

interface ScenarioSpec {
  id: string;
  title: string;
  text: string;
  registryOpts: RegistryOpts;
  judge: (state: AgentState) => { pass: boolean; note: string };
}

const realScenarios: ScenarioSpec[] = [
  {
    id: "B1",
    title: "瞬时故障·第 1 次（错误文案鼓励重试，观察自愈 vs 放弃）",
    text: "北京现在天气怎么样？多少度？",
    registryOpts: { weatherFailFirst: 1 },
    judge: (st) => {
      const calls = st.toolCalls.filter((t) => t.name === "get_weather");
      const recovered = calls.some((t) => t.ok);
      const honest = /失败|错误|无法|不可用|过载|暂时|稍后|重试|抱歉/.test(st.answer);
      const pass =
        st.status === "finished" && st.stopReason === "finished"
        && (recovered ? answerHas(st.answer, 22) : honest);
      const path = recovered ? "自愈重试成功" : "如实放弃";
      return {
        pass,
        note: `路径=${path}；get_weather 调用 ${calls.length} 次（成功 ${calls.filter((t) => t.ok).length}）${recovered ? "；温度 22°C 命中" : `；如实转述=${honest}`}`,
      };
    },
  },
  {
    id: "B2",
    title: "瞬时故障·第 2 次（报分布）",
    text: "北京今天天气如何？",
    registryOpts: { weatherFailFirst: 1 },
    judge: (st) => {
      const calls = st.toolCalls.filter((t) => t.name === "get_weather");
      const recovered = calls.some((t) => t.ok);
      const honest = /失败|错误|无法|不可用|过载|暂时|稍后|重试|抱歉/.test(st.answer);
      const pass =
        st.status === "finished" && st.stopReason === "finished"
        && (recovered ? answerHas(st.answer, 22) : honest);
      const path = recovered ? "自愈重试成功" : "如实放弃";
      return {
        pass,
        note: `路径=${path}；get_weather 调用 ${calls.length} 次（成功 ${calls.filter((t) => t.ok).length}）${recovered ? "；温度 22°C 命中" : `；如实转述=${honest}`}`,
      };
    },
  },
  {
    id: "B3",
    title: "未知城市引导（execute 错误含覆盖列表 → 转述质量）",
    text: "重庆现在天气怎么样？多少度？",
    registryOpts: {},
    judge: (st) => {
      const failed = st.toolCalls.some((t) => !t.ok && t.failedStage === "execute");
      const ack = /无法|查不到|未知|不支持|暂时|覆盖|暂未/.test(st.answer);
      const guides = /北京|上海|深圳/.test(st.answer);
      return {
        pass: failed && ack && st.status === "finished" && st.stopReason === "finished",
        note: `execute 失败=${failed}；如实转述=${ack}；提及覆盖城市/替代=${guides}；工具次数=${st.toolCalls.length}`,
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
    .map((c) => `| ${c.id} | ${c.descr} | ${c.pass ? "✅" : "❌"} | \`${truncate(c.detail, 120)}\` |`)
    .join("\n");

  const bRows = finals
    .map((f) =>
      `| ${f.spec.id} | ${f.spec.title} | ${f.state.iteration} | ${f.state.llmAttempts} | ${f.state.toolCalls.length} | ${f.pass ? "✅" : "❌"} | \`${truncate(f.note, 60)}\` |`)
    .join("\n");

  const details = finals.map(({ spec, state, pass, note }) => {
    const tcalls = state.toolCalls
      .map((t) => `    ${t.ok ? "✓" : "✗"} #${t.seq} 第${t.iteration}轮 ${t.name} \`${truncate(t.args, 60)}\` → \`${truncate(JSON.stringify(t.output), 180)}\`${t.failedStage ? ` [${t.failedStage}]` : ""}`)
      .join("\n");
    const inv = checkInvariants(state);
    return `## ${spec.id}：${spec.title}

- 判分：${pass ? "✅" : "❌"} ${note}
- 用户输入：${spec.text}
- 状态快照：\`${JSON.stringify(state.snapshot())}\`
- 不变量检查：${inv.length === 0 ? "✅ 零违规" : `❌ ${inv.join("；")}`}
- 工具记录：
${tcalls || "（零调用）"}
- 最终答复：

\`\`\`text
${state.answer.trim()}
\`\`\``;
  }).join("\n\n---\n\n");

  return `# Day 25：错误处理 —— 五类错误的分类学与循环级韧性

> 日期：${date}
> 模型：${MODEL}（temperature=0；Part A 为 Mock 注入，零 API 成本）

## 错误分类学

| 层 | 阶段 | 处理方式 |
|---|---|---|
| 工具层 | lookup 工具不存在 | 错误 JSON 回喂（\`未注册的工具\`） |
| 工具层 | parse 参数非 JSON | 解析错误回喂 |
| 工具层 | validate Zod 失败 | 字段级 details 回喂 |
| 工具层 | execute 执行异常 | 业务错误回喂（可含修复引导） |
| 模型层 | LLM 调用失败 | 循环层重试 ${LLM_MAX_ATTEMPTS} 次 → 耗尽抛 AgentFailureError（携带部分状态，不伪造 finished） |
| 组合 | 无限循环 | Day 24 MAX_ITERATIONS 强制收尾兜底 |

计账口径：\`llmCalls\` = 成功决策数（R6 不变量），\`llmAttempts\` = 全部尝试（含重试）。

## Part A：Mock 注入单测（${upass}/${unit.length}，零 API）

| 用例 | 断言 | 结果 | 详情 |
|---|---|---|---|
${unitRows}

## Part B：真实 LLM（${bpass}/${finals.length}；Prompt Tokens ${totalPrompt}，Completion Tokens ${totalCompletion}）

| 场景 | 说明 | 轮数 | llmAttempts | 工具次数 | 结果 | 判分摘要 |
|---|---|---|---|---|---|---|
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
  console.log("[day25] Part A：Mock 注入单测开始");
  const unit = await runUnitTests();
  for (const c of unit) console.log(`[day25] ${c.pass ? "PASS" : "FAIL"} ${c.id} ${c.descr}`);
  if (unit.some((c) => !c.pass)) throw new Error("Part A 单测未全通过，停止");

  const finals: { spec: ScenarioSpec; state: AgentState; pass: boolean; note: string }[] = [];
  for (const spec of realScenarios) {
    console.log(`[day25] === ${spec.id} ${spec.title} ===`);
    try {
      const state = await runAgent(callLLM, spec.text, {
        registry: makeRegistry(spec.registryOpts),
        llmRetryBackoffMs: 2000,
      });
      const j = spec.judge(state);
      const inv = checkInvariants(state);
      finals.push({ spec, state, pass: j.pass && inv.length === 0, note: `${j.note}${inv.length ? `；不变量违规=${inv.join("；")}` : ""}` });
      console.log(`[day25]   pass=${j.pass} iter=${state.iteration} tools=${state.toolCalls.length} stop=${state.stopReason}`);
    } catch (e) {
      if (e instanceof AgentFailureError) {
        finals.push({ spec, state: e.state, pass: false, note: `LLM 异常中止：${e.message}` });
        console.log(`[day25]   LLM 异常中止（如实记录为失败，不崩溃整个实验）`);
      } else throw e;
    }
  }

  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs");
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, "day25-error-handling.md");
  writeFileSync(outFile, buildMarkdown(unit, finals), "utf-8");
  console.log(`[day25] 已写入 ${outFile}`);
}

main().catch((err) => {
  console.error("[day25] 失败：", err);
  process.exit(1);
});
