/**
 * Day 26：Agent Memory —— conversation history 与「Memory ≠ 无限保存」
 *
 * LLM 无状态：所谓"模型记得上一轮"，唯一的实现方式就是把历史消息
 * 塞进本次请求的 messages 数组（Day 23 已实证）。所以 Memory 的本质
 * 不是模型能力，而是**消息管理策略**：
 *
 *   ConversationMemory（以"轮"为原子单位）
 *     ├── addTurn(user, newMessages)：一轮对话结束后归档该轮全部新消息
 *     ├── buildMessages(strategy)：按策略重建本次请求的 messages
 *     │     ├── full        全量保留（记忆完整，成本随轮数增长）
 *     │     ├── window K    滑动窗口（只保留最近 K 轮，成本有界）
 *     │     └── tokenBudget 预算内保留最近尽可能多的整轮
 *     └── 裁剪以"轮"为原子：绝不会把 assistant(tool_calls) 和它的
 *         tool 回传拆开（Day 24 R2 协议不变量在 Memory 场景的应用）
 *
 * 核心命题：**Memory ≠ 无限保存全部聊天记录**——
 *   记得多 = tokens 多 = 成本高；裁掉旧轮 = 省钱但失忆。
 *   这不是 bug，是必须显式做出的工程权衡。
 *
 * 验证策略（唯一变量 = Memory 策略）：
 *   Part A 零 API：探针式 Mock LLM（在 messages 里 grep 标记词）确定性证明
 *   "记忆 = messages 传递"；三个裁剪策略的存储/裁剪/协议原子性单测。
 *   Part B 真实 LLM：同一两轮对话，full vs window=1——full 记得代号与天气
 *   （第二轮 promptTokens 明显增长），window 失忆（答不出代号）但第二轮
 *   prompt 显著更小。成本与记忆的取舍直接可测。
 *
 * 运行：npx tsx src/experiments/day26-agent-memory.ts
 * 输出：01-ai-chat/docs/day26-agent-memory.md
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
 // ① 工具执行体（沿用 Day 16-25 的安全实现）
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
 // ② ToolRegistry（Day 19/25 成果复用）
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

function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register({
    name: "calculator",
    definition: {
      type: "function",
      function: {
        name: "calculator",
        description: "精确数学计算器。数值计算必须调用，不要心算。",
        parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
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
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    },
    schema: z.object({ city: z.string().min(1) }),
    run: ({ city }) => getWeather(city),
  });
  return reg;
}

// ###################################################################
 // ③ ConversationMemory —— 今天的核心
// ###################################################################

type MemoryStrategy =
  | { kind: "full" }
  | { kind: "window"; k: number }
  | { kind: "tokenBudget"; maxTokens: number };

interface MemoryTurn {
  /** 该轮用户输入（语义索引用） */
  userContent: string;
  /** 该轮新增的全部消息（assistant 决策 / tool 回传 / 最终答复），裁剪的原子单位 */
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  /** 该轮 LLM 的 prompt 消耗（真实运行记录，Mock 为 0） */
  promptTokens: number;
}

/** 粗估 token 数：中文场景按 JSON 长度 / 2（仅用于预算策略与对比展示，非精确计费） */
function estimateTokens(msgs: OpenAI.Chat.ChatCompletionMessageParam[]): number {
  return Math.ceil(
    msgs.reduce((n, m) => {
      const c = (m as { content?: unknown }).content;
      return n + (typeof c === "string" ? c.length : JSON.stringify(c ?? "").length);
    }, 0) / 2,
  );
}

class ConversationMemory {
  private turns: MemoryTurn[] = [];
  constructor(public readonly systemPrompt: string) {}

  get turnCount(): number {
    return this.turns.length;
  }

  addTurn(userContent: string, newMessages: OpenAI.Chat.ChatCompletionMessageParam[], promptTokens: number): void {
    // 归档以 user 消息开头——记忆要完整包含"用户说过什么"
    this.turns.push({
      userContent,
      messages: [{ role: "user", content: userContent }, ...newMessages],
      promptTokens,
    });
  }

  /** 全部归档消息（不含 system），按序 */
  archivedMessages(): OpenAI.Chat.ChatCompletionMessageParam[] {
    return this.turns.flatMap((t) => t.messages);
  }

  /**
   * 按策略重建本次请求的 messages。裁剪以"轮"为原子单位——
   * 一轮内的 assistant(tool_calls) 与 tool 回传永远同进同退，
   * 保证输出永不违反 R2 协议不变量。
   */
  buildMessages(strategy: MemoryStrategy): OpenAI.Chat.ChatCompletionMessageParam[] {
    if (this.turns.length === 0) return [{ role: "system", content: this.systemPrompt }];

    let kept: MemoryTurn[];
    switch (strategy.kind) {
      case "full":
        kept = this.turns;
        break;
      case "window":
        kept = this.turns.slice(-strategy.k);
        break;
      case "tokenBudget": {
        // 从最新轮往旧走，装得下就保留，遇到装不下的即停（保持最近连续整轮）
        kept = [];
        let remaining = strategy.maxTokens - estimateTokens([{ role: "system", content: this.systemPrompt }]);
        for (let i = this.turns.length - 1; i >= 0; i--) {
          const cost = estimateTokens(this.turns[i].messages);
          if (cost > remaining) break;
          remaining -= cost;
          kept.unshift(this.turns[i]);
        }
        break;
      }
    }

    return [
      { role: "system", content: this.systemPrompt },
      ...kept.flatMap((t) => t.messages),
    ];
  }
}

/**
 * 消息协议检查（Memory 专用）：对任意一段待发送的 messages 验证
 * R2'（assistant 的 tool_calls 必须紧跟等量同 id 的 tool 回传）——
 * 裁剪策略无论怎么裁，输出都必须通过这道闸。
 */
function checkMessageProtocol(msgs: OpenAI.Chat.ChatCompletionMessageParam[]): string[] {
  const v: string[] = [];
  if (msgs[0]?.role !== "system") v.push(`首条应为 system，实际 ${msgs[0]?.role ?? "空"}`);
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
        v.push(`第 ${i} 条 assistant 的 ${n} 个 tool_calls 悬空（未被等量同 id 的 tool 消息紧跟）`);
      }
    }
  }
  return v;
}

// ###################################################################
 // ④ Agent 主循环（Day 22-25 成果，支持注入初始 messages）
// ###################################################################

const MAX_ITERATIONS = 10;

const SYSTEM_PROMPT =
  "你是一个多轮对话助手，可以使用 calculator / get_current_time / get_weather。需要精确计算或实时信息时调用对应工具，不要心算或编造；回答应基于对话历史中的信息；Mock 数据须说明；用中文作答。";

type LLMResponse = {
  message: OpenAI.Chat.ChatCompletionMessage;
  usage: { prompt_tokens: number; completion_tokens: number };
};
type LLMFn = (
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  options: { tools?: OpenAI.Chat.Completions.ChatCompletionTool[] },
) => Promise<LLMResponse>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

class AgentState {
  readonly messages: OpenAI.Chat.ChatCompletionMessageParam[];
  readonly toolCalls: { seq: number; callId: string; iteration: number; name: string; args: string; ok: boolean; output: unknown; failedStage?: FailStage; at: string }[] = [];
  iteration = 0;
  status: "running" | "finished" = "running";
  answer = "";
  stopReason: "finished" | "max_iterations" | null = null;
  forcedFinalAttempted = false;
  forcedFinalOk = false;
  llmCalls = 0;
  llmAttempts = 0;
  readonly maxIterations: number;
  promptTokens = 0;
  completionTokens = 0;

  constructor(readonly initialMessages: OpenAI.Chat.ChatCompletionMessageParam[], maxIterations: number) {
    this.messages = [...initialMessages];
    this.maxIterations = maxIterations;
  }

  append(...msgs: OpenAI.Chat.ChatCompletionMessageParam[]): void {
    this.messages.push(...msgs);
  }

  recordToolCall(rec: Omit<ToolCall, "seq" | "at">): void {
    this.toolCalls.push({ ...rec, seq: this.toolCalls.length + 1, at: new Date().toISOString() });
  }

  finish(answer: string, stopReason: "finished" | "max_iterations"): void {
    this.status = "finished";
    this.answer = answer;
    this.stopReason = stopReason;
  }

  snapshot(): Record<string, unknown> {
    return {
      status: this.status,
      stopReason: this.stopReason,
      iteration: this.iteration,
      llmCalls: this.llmCalls,
      llmAttempts: this.llmAttempts,
      messageCount: this.messages.length,
      toolCallCount: this.toolCalls.length,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
    };
  }
}
type ToolCall = AgentState["toolCalls"][number];

async function runAgent(
  llm: LLMFn,
  initialMessages: OpenAI.Chat.ChatCompletionMessageParam[],
  opts: { maxIterations?: number; registry?: ToolRegistry; llmRetryBackoffMs?: number } = {},
): Promise<AgentState> {
  const maxIterations = opts.maxIterations ?? MAX_ITERATIONS;
  const registry = opts.registry ?? makeRegistry();
  const backoffMs = opts.llmRetryBackoffMs ?? 2000;
  const state = new AgentState(initialMessages, maxIterations);

  const callLLMWithRetry = async (options: { tools?: OpenAI.Chat.Completions.ChatCompletionTool[] }) => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      state.llmAttempts += 1;
      try {
        return await llm(state.messages, options);
      } catch (err) {
        lastErr = err;
        if (attempt < 3) await sleep(backoffMs);
      }
    }
    throw new Error(`LLM 连续 3 次调用失败，任务中止：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  };

  let finished = false;
  while (!finished) {
    const resp = await callLLMWithRetry({ tools: registry.definitions() });
    state.iteration += 1;
    state.llmCalls += 1;
    state.promptTokens += resp.usage.prompt_tokens;
    state.completionTokens += resp.usage.completion_tokens;
    const msg = resp.message;
    const calls = msg.tool_calls ?? [];

    if (calls.length === 0) {
      state.append(msg);
      state.finish(msg.content ?? "", "finished");
      finished = true;
      break;
    }

    state.append(msg);
    for (const call of calls) {
      const r = registry.execute(call.function.name, call.function.arguments);
      const output = r.ok ? r.data : { error: r.error, stage: r.stage };
      state.recordToolCall({
        callId: call.id, iteration: state.iteration,
        name: call.function.name, args: call.function.arguments,
        ok: r.ok, output, ...(r.ok ? {} : { failedStage: r.stage }),
      });
      state.append({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
    }

    if (state.iteration >= maxIterations) {
      state.append({
        role: "user",
        content: `[system] 已达到最大迭代次数（${maxIterations}）。请基于以上信息直接给出最终中文答复。`,
      });
      const fin = await callLLMWithRetry({});
      state.llmCalls += 1;
      state.forcedFinalAttempted = true;
      const answer = (fin.message.content ?? "").trim();
      state.promptTokens += fin.usage.prompt_tokens;
      state.completionTokens += fin.usage.completion_tokens;
      if (answer) {
        state.append(fin.message);
        state.forcedFinalOk = true;
        state.finish(answer, "max_iterations");
      } else {
        const fallback = `[Agent 已达到最大迭代次数（${maxIterations}），任务未完成，已强制停止。]`;
        state.append({ role: "assistant", content: fallback });
        state.finish(fallback, "max_iterations");
      }
      finished = true;
    }
  }

  return state;
}

/** 多轮对话的一轮：Memory 提供历史 + 新输入，跑完把新消息归档 */
async function runConversationTurn(
  memory: ConversationMemory,
  userInput: string,
  llm: LLMFn,
  opts: { strategy: MemoryStrategy; registry?: ToolRegistry; llmRetryBackoffMs?: number },
): Promise<{ state: AgentState; inputMessageCount: number }> {
  const built = memory.buildMessages(opts.strategy);
  const inputMessages = [...built, { role: "user" as const, content: userInput }];
  const state = await runAgent(llm, inputMessages, {
    registry: opts.registry,
    llmRetryBackoffMs: opts.llmRetryBackoffMs,
  });
  const newMessages = state.messages.slice(inputMessages.length);
  memory.addTurn(userInput, newMessages, state.promptTokens);
  return { state, inputMessageCount: inputMessages.length };
}

// ###################################################################
 // ⑤ Part A：Mock 单测（零 API）
// ###################################################################

type MockStep =
  | { kind: "tools"; calls: { name: string; args: string }[]; narration?: string }
  | { kind: "final"; answer: string };

const ZERO_USAGE = { prompt_tokens: 0, completion_tokens: 0 };

function scriptedLLM(steps: MockStep[]): LLMFn {
  let callIdx = 0;
  let stepIdx = 0;
  return async (_messages, options) => {
    if (!options.tools) {
      const msg: OpenAI.Chat.ChatCompletionMessage = { role: "assistant", content: "[Mock 收尾]", refusal: null };
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

/** 探针 LLM：在收到的 messages 里 grep 标记词——记忆实证的确定性实现 */
function probeLLM(marker: string): LLMFn {
  return async (messages) => {
    const text = JSON.stringify(messages);
    const answer = text.includes(marker)
      ? `记得：${marker}`
      : "抱歉，我不知道。";
    const msg: OpenAI.Chat.ChatCompletionMessage = { role: "assistant", content: answer, refusal: null };
    return { message: msg, usage: ZERO_USAGE };
  };
}

/** 手工构造一轮"带工具调用"的归档新增消息（user 由 addTurn 统一添加，不经过 LLM） */
function fabricatedToolTurn(): OpenAI.Chat.ChatCompletionMessageParam[] {
  return [
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "fab_call_1", type: "function", function: { name: "calculator", arguments: '{"expression":"2+2"}' } }],
    },
    { role: "tool", tool_call_id: "fab_call_1", content: '{"expression":"2+2","result":4}' },
    { role: "assistant", content: "答案是 4。" },
  ];
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

  // T1 基础归档与全量重建
  {
    const mem = new ConversationMemory("sys");
    mem.addTurn("我叫小明，代号 Alpha-7", [{ role: "assistant", content: "记住了。" }], 0);
    mem.addTurn("北京天气如何", [{ role: "assistant", content: "22°C。" }], 0);
    const msgs = mem.buildMessages({ kind: "full" });
    const text = JSON.stringify(msgs);
    cs.push(U("T1", "full：system 首位 + 两轮消息全量按序重建",
      msgs[0].role === "system" && msgs.length === 5 && /Alpha-7/.test(text) && text.indexOf("Alpha-7") < text.indexOf("22°C"),
      `messages=${msgs.length}（1 system + 2 user + 2 assistant）`));
  }

  // T2 窗口裁剪 K=1
  {
    const mem = new ConversationMemory("sys");
    mem.addTurn("第一轮", [{ role: "assistant", content: "回复一" }], 0);
    mem.addTurn("第二轮", [{ role: "assistant", content: "回复二" }], 0);
    const msgs = mem.buildMessages({ kind: "window", k: 1 });
    const text = JSON.stringify(msgs);
    cs.push(U("T2", "window K=1：只保留 system + 最近一轮，旧轮整体移除",
      msgs.length === 3 && /第二轮/.test(text) && !/第一轮/.test(text),
      `messages=${msgs.length}，含"回复二"=${/回复二/.test(text)}，含"回复一"=${/回复一/.test(text)}`));
  }

  // T3 裁剪原子性：带工具调用的轮次整体保留/整体消失，输出永不悬空
  {
    const mem = new ConversationMemory("sys");
    mem.addTurn("算一下 2+2", fabricatedToolTurn(), 0);
    mem.addTurn("谢谢", [{ role: "assistant", content: "不客气。" }], 0);

    const kept = mem.buildMessages({ kind: "window", k: 2 });
    const keptViolations = checkMessageProtocol(kept);
    const keptHasTool = kept.some((m) => m.role === "tool");

    const trimmed = mem.buildMessages({ kind: "window", k: 1 });
    const trimmedViolations = checkMessageProtocol(trimmed);
    const trimmedHasTool = trimmed.some((m) => m.role === "tool");

    cs.push(U("T3", "原子性：K=2 工具轮完整保留、K=1 工具轮整体消失，两种结果协议零违规",
      keptHasTool && keptViolations.length === 0 && !trimmedHasTool && trimmedViolations.length === 0,
      `K=2 含 tool=${keptHasTool} 违规=${keptViolations.length}；K=1 含 tool=${trimmedHasTool} 违规=${trimmedViolations.length}`));
  }

  // T4 tokenBudget：预算足够全量、预算不足从最旧轮开始丢且 system 永在
  {
    const mem = new ConversationMemory("这是一个足够长的系统提示词，用于测试预算扣除");
    for (let i = 1; i <= 3; i++) {
      mem.addTurn(`第${i}轮的较长的用户输入内容`, [{ role: "assistant", content: `第${i}轮的同样较长的助手答复内容` }], 0);
    }
    const full = mem.buildMessages({ kind: "full" });
    const tight = mem.buildMessages({ kind: "tokenBudget", maxTokens: 50 });
    const tightText = JSON.stringify(tight);
    const ok = tight[0].role === "system"
      && tight.length < full.length
      && /第3轮/.test(tightText)
      && !/第1轮/.test(tightText);
    cs.push(U("T4", "tokenBudget：预算内保留最近连续整轮、最旧先丢、system 永在",
      ok,
      `full=${full.length} 条 → 预算后=${tight.length} 条，含第3轮=${/第3轮/.test(tightText)}，含第1轮=${/第1轮/.test(tightText)}`));
  }

  // T5 记忆实证：探针 LLM 在 messages 里 grep 标记词——full 记得
  {
    const mem = new ConversationMemory("sys");
    mem.addTurn("我的项目代号是 Alpha-7，请记住。", [{ role: "assistant", content: "好的，已记住。" }], 0);
    const { state } = await runConversationTurn(mem, "我的项目代号是什么？", probeLLM("Alpha-7"), {
      strategy: { kind: "full" },
      llmRetryBackoffMs: 0,
    });
    cs.push(U("T5", "记忆实证（full）：探针在 messages 中找到 Alpha-7 → 答出",
      state.answer.includes("记得：Alpha-7"),
      `answer="${state.answer}"`));
  }

  // T6 失忆对照：第 3 轮提问，window K=1 只保留第 2 轮 → 标记词被裁 → 探针答不知道
  {
    const mem = new ConversationMemory("sys");
    mem.addTurn("我的项目代号是 Alpha-7，请记住。", [{ role: "assistant", content: "好的，已记住。" }], 0);
    mem.addTurn("帮我算一下 1+1。", [{ role: "assistant", content: "1+1=2。" }], 0);
    const { state } = await runConversationTurn(mem, "我的项目代号是什么？", probeLLM("Alpha-7"), {
      strategy: { kind: "window", k: 1 },
      llmRetryBackoffMs: 0,
    });
    cs.push(U("T6", "失忆对照（window K=1，第 3 轮提问）：第 1 轮被裁 → 探针找不到 Alpha-7 → 答不知道",
      state.answer.includes("不知道"),
      `answer="${state.answer}"（与 T5 唯一差异 = Memory 策略 + 提问轮次）`));
  }

  // T7 端到端：多轮 Memory + 工具调用，状态与 Memory 协议双重校验
  {
    const mem = new ConversationMemory("sys");
    mem.addTurn("随便聊一句", [{ role: "assistant", content: "好的。" }], 0);
    const { state } = await runConversationTurn(mem, "帮我算 3*7，再告诉我一句总结", scriptedLLM([
      { kind: "tools", calls: [{ name: "calculator", args: '{"expression":"3*7"}' }] },
      { kind: "final", answer: "3*7=21，计算完成。" },
    ]), { strategy: { kind: "full" }, llmRetryBackoffMs: 0 });

    const memMsgs = mem.buildMessages({ kind: "full" });
    const memViolations = checkMessageProtocol(memMsgs);
    // 端到端后 Memory 应含 2 轮：第 1 轮 2 条（user+assistant）、第 2 轮 4 条（user+assistant(tool)+tool+final）
    const archived = mem.archivedMessages();
    cs.push(U("T7", "端到端：工具轮完整归档（user+assistant+tool+final 4 条），Memory 协议零违规",
      mem.turnCount === 2 && archived.length === 6 && archived.some((m) => m.role === "tool")
      && state.answer.includes("21") && memViolations.length === 0,
      `turns=${mem.turnCount} archived=${archived.length} 含 tool=${archived.some((m) => m.role === "tool")} 违规=${memViolations.length}`));
  }

  return cs;
}

// ###################################################################
 // ⑥ Part B：真实 LLM 对比（唯一变量 = Memory 策略）
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

interface RoundResult {
  round: number;
  userInput: string;
  answer: string;
  inputMessageCount: number;
  promptTokens: number;
  completionTokens: number;
  toolCalls: number;
}

interface PartBResult {
  id: string;
  title: string;
  strategy: MemoryStrategy;
  rounds: RoundResult[];
  pass: boolean;
  note: string;
}

async function runPartB(): Promise<PartBResult[]> {
  const registry = makeRegistry();
  const results: PartBResult[] = [];

  const R1_INPUT = "记住：我的项目代号是 Alpha-7。另外帮我查一下北京现在天气怎么样，多少度。";
  const R2_INPUT = "帮我算一下 8*3。";
  const R3_INPUT = "我的项目代号是什么？刚才查到北京多少度？";

  /** 同样的三轮对话，唯一变量 = Memory 策略；第 3 轮提问，窗口策略才会真正裁掉记忆轮 */
  async function runThreeTurns(strategy: MemoryStrategy): Promise<RoundResult[]> {
    const memory = new ConversationMemory(SYSTEM_PROMPT);
    const rounds: RoundResult[] = [];
    for (const [round, input] of [[1, R1_INPUT], [2, R2_INPUT], [3, R3_INPUT]] as const) {
      const { state, inputMessageCount } = await runConversationTurn(memory, input, callLLM, { strategy, registry });
      rounds.push({
        round, userInput: input, answer: state.answer,
        inputMessageCount, promptTokens: state.promptTokens,
        completionTokens: state.completionTokens, toolCalls: state.toolCalls.length,
      });
    }
    return rounds;
  }

  // B1 full 策略：第 3 轮应记得代号与天气
  {
    const rounds = await runThreeTurns({ kind: "full" });
    const last = rounds[2].answer;
    const remembersCode = /alpha-7/i.test(last);
    const remembersWeather = answerHas(last, 22);
    results.push({
      id: "B1", title: "full 全量记忆", strategy: { kind: "full" }, rounds,
      pass: remembersCode && remembersWeather,
      note: `代号 Alpha-7 命中=${remembersCode}；北京 22°C 命中=${remembersWeather}；三轮请求消息数 ${rounds.map((r) => r.inputMessageCount).join("→")}，promptTokens ${rounds.map((r) => r.promptTokens).join("→")}`,
    });
  }

  // B2 window K=1：第 3 轮只带第 2 轮，记忆轮被裁 → 失忆
  {
    const rounds = await runThreeTurns({ kind: "window", k: 1 });
    const last = rounds[2].answer;
    const noCode = !/alpha-7/i.test(last);
    const honest = /没有|不知道|无法|未|没提供|记忆/.test(last);
    results.push({
      id: "B2", title: "window K=1（第 3 轮时记忆轮已被裁）", strategy: { kind: "window", k: 1 }, rounds,
      pass: noCode && honest,
      note: `失忆实证：不含 Alpha-7=${noCode}；诚实表示不知道=${honest}；三轮请求消息数 ${rounds.map((r) => r.inputMessageCount).join("→")}，promptTokens ${rounds.map((r) => r.promptTokens).join("→")}（对比 B1）`,
    });
  }

  return results;
}

// ###################################################################
 // ⑦ 报告
// ###################################################################

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

function buildMarkdown(unit: UnitCase[], partB: PartBResult[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const upass = unit.filter((c) => c.pass).length;
  const bpass = partB.filter((r) => r.pass).length;
  const totalPrompt = partB.flatMap((r) => r.rounds).reduce((n, r) => n + r.promptTokens, 0);
  const totalCompletion = partB.flatMap((r) => r.rounds).reduce((n, r) => n + r.completionTokens, 0);

  const unitRows = unit
    .map((c) => `| ${c.id} | ${c.descr} | ${c.pass ? "✅" : "❌"} | \`${truncate(c.detail, 120)}\` |`)
    .join("\n");

  const bRows = partB.map((r) => {
    const roundCells = r.rounds
      .map((rd) => `第${rd.round}轮 输入${rd.inputMessageCount}条/prompt ${rd.promptTokens}tk`)
      .join("；");
    return `| ${r.id} | ${r.title} | ${roundCells} | ${r.pass ? "✅" : "❌"} |`;
  }).join("\n");

  const details = partB.map((r) => {
    const roundBlocks = r.rounds.map((rd) => `### ${r.id} 第 ${rd.round} 轮

- 用户输入：${rd.userInput}
- 请求携带消息数：${rd.inputMessageCount}；Prompt Tokens：${rd.promptTokens}；Completion Tokens：${rd.completionTokens}；工具调用：${rd.toolCalls}
- 答复：

\`\`\`text
${rd.answer.trim() || "（见上）"}
\`\`\``).join("\n\n");
    return `## ${r.id}：${r.title}（策略：${r.strategy.kind}${"k" in r.strategy ? ` k=${r.strategy.k}` : ""}）

- 判分：${r.pass ? "✅" : "❌"} ${r.note}

${roundBlocks}`;
  }).join("\n\n---\n\n");

  return `# Day 26：Agent Memory —— conversation history 与「Memory ≠ 无限保存」

> 日期：${date}
> 模型：${MODEL}（temperature=0；Part A 为探针 Mock，零 API 成本）

## 设计要点

- Memory 本质是**消息管理策略**：LLM 无状态，"记得"的唯一实现是把历史消息放进本次请求。
- \`ConversationMemory\` 以"轮"为原子单位归档/裁剪，三种策略：\`full\` / \`window K\` / \`tokenBudget\`。
- 裁剪以轮为原子 ⇒ assistant(tool_calls) 与 tool 回传永不拆散，输出必过 R2' 协议闸（\`checkMessageProtocol\`）。
- Part B 对比唯一变量 = Memory 策略：full vs window K=1（同样的两轮对话）。

## Part A：Mock 单测（${upass}/${unit.length}，零 API）

| 用例 | 断言 | 结果 | 详情 |
|---|---|---|---|
${unitRows}

## Part B：真实 LLM（${bpass}/${partB.length}；Prompt Tokens ${totalPrompt}，Completion Tokens ${totalCompletion}）

| 场景 | 策略 | 每轮成本 | 结果 |
|---|---|---|---|
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
  console.log("[day26] Part A：Mock 单测开始");
  const unit = await runUnitTests();
  for (const c of unit) console.log(`[day26] ${c.pass ? "PASS" : "FAIL"} ${c.id} ${c.descr}`);
  if (unit.some((c) => !c.pass)) throw new Error("Part A 单测未全通过，停止");

  console.log("[day26] Part B：真实 LLM 对比开始");
  const partB = await runPartB();
  for (const r of partB) console.log(`[day26] ${r.pass ? "PASS" : "FAIL"} ${r.id} ${r.title}: ${r.note}`);

  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs");
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, "day26-agent-memory.md");
  writeFileSync(outFile, buildMarkdown(unit, partB), "utf-8");
  console.log(`[day26] 已写入 ${outFile}`);
}

main().catch((err) => {
  console.error("[day26] 失败：", err);
  process.exit(1);
});
