/**
 * Day 22：Agent Loop —— 显式的 while (!finished) 自主循环
 *
 * Day 15-20 的编排循环已经能让模型多步调用工具，但那只是脚本里的一个 for。
 * 今天把它正式抽象为 Agent 的运行核心：
 *
 *   while (!finished) {
 *     LLM 决策 → 是否需要工具？
 *     需要：执行 Tool → 把 Result 回传 → 继续循环
 *     不需要：finished = true，输出最终答案
 *   }
 *
 * 三个学习点：
 *   1. finished 由模型自己决定——它不再发起 tool_calls 就是任务完成信号；
 *   2. 每一轮结构化为 AgentStep（模型旁白/思考 + 工具执行结果），完整可检查；
 *   3. 循环必须有安全出口（今天放临时上限，Day 24 正式实现 MAX_ITERATIONS=10）。
 *
 * 复用：Day 19/20 的 ToolRegistry 与四个工具（calculator/time/weather/search）。
 *
 * 运行：npx tsx src/experiments/day22-agent-loop.ts
 * 输出：01-ai-chat/docs/day22-agent-loop.md
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
 // ① 工具执行体（沿用 Day 16-20 实现）
// ###################################################################

class ToolExecError extends Error {}

// ---- Calculator：递归下降安全求值，无 eval ----
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

// ---- Weather（Mock 快照）----
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

// ---- Search（Mock 固定结果）----
const MOCK_SEARCH: { pattern: RegExp; title: string; snippet: string }[] = [
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
 // ② ToolRegistry（Day 19/20 成果复用）
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
      description: "获取时区当前时间/日期。询问时间、日期时调用。",
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
      description: "查询城市天气（温度、状况、降水量）。问天气/气温时调用。",
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
      description: "搜索实时信息（股价、新闻等）。常识问题不要调用。",
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
 // ③ Agent Loop —— 今天的核心
// ###################################################################

interface ToolExecution {
  callId: string;
  name: string;
  args: string;
  ok: boolean;
  output: unknown;
  failedStage?: FailStage;
}

interface AgentStep {
  /** 第几轮（从 1 开始，等于 LLM 调用序号） */
  iteration: number;
  /** tool_calls = 本轮发起了工具调用；final = 模型给出最终答复，循环结束 */
  kind: "tool_calls" | "final";
  /** 模型在这轮的文字内容：调工具时是"旁白/思考"，final 轮是最终答案 */
  assistantContent: string | null;
  toolExecutions: ToolExecution[];
}

type StopReason = "finished" | "safety_limit";

interface AgentRunResult {
  userInput: string;
  answer: string;
  steps: AgentStep[];
  iterations: number;
  toolCallCount: number;
  stopReason: StopReason;
  promptTokens: number;
  completionTokens: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callLLM(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  attempt = 1,
): Promise<OpenAI.Chat.ChatCompletion> {
  try {
    return await client.chat.completions.create(
      { model: MODEL, messages, temperature: 0, tools: registry.definitions() },
      { timeout: 30_000, maxRetries: 0 },
    );
  } catch (err) {
    if (attempt >= 3) throw err;
    console.warn(`[day22] 网络错误（第 ${attempt} 次），2s 后重试`);
    await sleep(2000);
    return callLLM(messages, attempt + 1);
  }
}

/**
 * 临时安全上限：while 循环必须有兜底，防止异常情况下无限运行。
 * Day 24 将正式实现 MAX_ITERATIONS = 10 及相应的错误处理。
 */
const TEMP_SAFETY_LIMIT = 8;

async function runAgent(userInput: string): Promise<AgentRunResult> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "你是一个可以使用工具的 AI 助手。需要精确计算或实时信息（时间、天气、股价）时调用对应工具，不要心算或编造；工具返回 Mock 数据须说明。一轮可并行调用多个无依赖的工具；拿到足够信息后直接用中文作答，不要重复调用。",
    },
    { role: "user", content: userInput },
  ];

  const steps: AgentStep[] = [];
  let answer = "";
  let stopReason: StopReason = "safety_limit";
  let iteration = 0;
  let promptTokens = 0;
  let completionTokens = 0;

  let finished = false;
  while (!finished) {
    iteration += 1;

    // ---- LLM 决策 ----
    const resp = await callLLM(messages);
    promptTokens += resp.usage?.prompt_tokens ?? 0;
    completionTokens += resp.usage?.completion_tokens ?? 0;

    const msg = resp.choices[0].message;
    const calls = msg.tool_calls ?? [];

    // ---- 判断：没有新的工具调用 → 任务结束 ----
    if (calls.length === 0) {
      finished = true;
      stopReason = "finished";
      answer = msg.content ?? "";
      steps.push({
        iteration, kind: "final",
        assistantContent: msg.content, toolExecutions: [],
      });
      break;
    }

    // ---- 执行：逐个调用工具并回传结果 ----
    messages.push(msg);
    const executions: ToolExecution[] = [];
    for (const call of calls) {
      const r = registry.execute(call.function.name, call.function.arguments);
      const output = r.ok
        ? r.data
        : {
            error: r.error,
            stage: r.stage,
            ...("details" in r && r.details ? { details: r.details } : {}),
          };
      const content = JSON.stringify(output);
      executions.push({
        callId: call.id, name: call.function.name,
        args: call.function.arguments, ok: r.ok, output,
        ...(r.ok ? {} : { failedStage: r.stage }),
      });
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }

    steps.push({
      iteration, kind: "tool_calls",
      assistantContent: msg.content, toolExecutions: executions,
    });

    // ---- 安全出口（Day 24 正式化）----
    if (iteration >= TEMP_SAFETY_LIMIT) {
      finished = true;
      answer = "[Agent 达到临时安全上限，被迫停止]";
    }
  }

  return {
    userInput, answer, steps, iterations: iteration,
    toolCallCount: steps.reduce((n, s) => n + s.toolExecutions.length, 0),
    stopReason, promptTokens, completionTokens,
  };
}

// ###################################################################
 // ④ 场景与判分
// ###################################################################

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

/** 工具序列摘要，如 "get_weather → calculator" */
function toolSequence(run: AgentRunResult): string {
  return run.steps
    .filter((s) => s.kind === "tool_calls")
    .map((s) => s.toolExecutions.map((e) => e.name).join("+"))
    .join(" → ");
}

interface ScenarioSpec {
  id: string;
  title: string;
  text: string;
  judge: (run: AgentRunResult) => { pass: boolean; note: string };
}

const scenarios: ScenarioSpec[] = [
  {
    id: "A1",
    title: "单步·时间（2 轮结束）",
    text: "现在几点了？",
    judge: (run) => {
      if (run.stopReason !== "finished") return { pass: false, note: "未正常结束" };
      const gold = getCurrentTime();
      const m = run.answer.match(/(\d{1,2})[:：](\d{2})/);
      if (!m) return { pass: false, note: `未给时间，gold≈${gold.hourMinute}` };
      const given = Number(m[1]) * 60 + Number(m[2]);
      const g = Number(gold.hourMinute.slice(0, 2)) * 60 + Number(gold.hourMinute.slice(3, 5));
      const ok = Math.abs(given - g) <= 1;
      return {
        pass: ok && run.iterations === 2,
        note: `${ok ? "时间正确" : "时间错"}（gold=${gold.hourMinute}，答复=${m[0]}）；序列：${toolSequence(run)}；iterations=${run.iterations}`,
      };
    },
  },
  {
    id: "A2",
    title: "链式·天气→条件计算",
    text: "我在深圳，现在多少度？如果气温超过 25 度，再帮我算一下：3 件 199 元的商品打 85 折，一共多少钱？",
    judge: (run) => {
      const gold = calculate("199*0.85*3"); // gold 同源
      const hasTemp = answerHas(run.answer, 27);
      const hasTotal = answerHas(run.answer, Number(gold.toFixed(2)), 0.02);
      const seq = toolSequence(run);
      const chainOk = /get_weather → calculator/.test(seq);
      return {
        pass: hasTemp && hasTotal && chainOk,
        note: `深圳27°C 命中=${hasTemp}；总价 gold=${gold.toFixed(2)} 命中=${hasTotal}；链式序列：${seq}；iterations=${run.iterations}`,
      };
    },
  },
  {
    id: "A3",
    title: "链式·搜索→计算（差额+百分比）",
    text: "特斯拉股价相比上一交易日收盘价，涨了多少美元？涨幅百分之多少？",
    judge: (run) => {
      const goldDiff = calculate("252.14-240.50");
      const goldPct = calculate("(252.14-240.50)/240.50*100");
      const d = answerHas(run.answer, Number(goldDiff.toFixed(2)), 0.02);
      const p = answerHas(run.answer, Number(goldPct.toFixed(2)), 0.05);
      return {
        pass: d && p,
        note: `差额 gold=${goldDiff.toFixed(2)} 命中=${d}；涨幅 gold=${goldPct.toFixed(2)}% 命中=${p}；序列：${toolSequence(run)}；iterations=${run.iterations}`,
      };
    },
  },
  {
    id: "A4",
    title: "调用前语义拦截·虚构地点（零调用）",
    text: "帮我查一下火星基地的天气。",
    judge: (run) => {
      // 模型在语义层识别出"火星基地不是真实城市"，不调用工具直接解释——合理行为
      const zeroCall = run.toolCallCount === 0;
      const explains = /火星/.test(run.answer) && /没有|无法|查不到|不存在|气象|大气/.test(run.answer);
      return {
        pass: zeroCall && explains && run.stopReason === "finished",
        note: `零调用=${zeroCall}；答复解释火星无气象站=${explains}；stopReason=${run.stopReason}（调用门前拦截，非错误穿透）`,
      };
    },
  },
  {
    id: "A5",
    title: "零工具·常识（1 轮结束）",
    text: "水在标准大气压下的沸点是多少？",
    judge: (run) => ({
      pass: answerHas(run.answer, 100) && run.iterations === 1 && run.toolCallCount === 0,
      note: `gold=100°C；iterations=${run.iterations}；工具调用=${run.toolCallCount}`,
    }),
  },
  {
    id: "A6",
    title: "并行·天气+搜索（同轮两工具）",
    text: "顺便问两个事：深圳现在多少度？苹果（AAPL）股价多少美元？",
    judge: (run) => {
      const t1 = answerHas(run.answer, 27);
      const t2 = answerHas(run.answer, 227.73);
      const firstRoundParallel =
        run.steps[0]?.kind === "tool_calls" && run.steps[0].toolExecutions.length === 2;
      return {
        pass: t1 && t2 && firstRoundParallel,
        note: `深圳27°C 命中=${t1}；AAPL 227.73 命中=${t2}；首轮并行=${firstRoundParallel}；序列：${toolSequence(run)}`,
      };
    },
  },
  {
    id: "A7",
    title: "错误穿透·真实地名但 Mock 未覆盖",
    text: "重庆现在天气怎么样？多少度？",
    judge: (run) => {
      // 重庆是真实城市，模型应正常发起调用；工具 execute 失败后错误穿透，模型如实转述
      const hasErrorExec = run.steps.some((s) =>
        s.toolExecutions.some((e) => !e.ok && e.failedStage === "execute"),
      );
      const acknowledges = /未知|无法|查不到|不支持|覆盖|没有该|暂未/.test(run.answer);
      return {
        pass: hasErrorExec && acknowledges && run.stopReason === "finished",
        note: `get_weather execute 失败=${hasErrorExec}；答复转述失败=${acknowledges}；stopReason=${run.stopReason}；序列：${toolSequence(run)}；iterations=${run.iterations}`,
      };
    },
  },
];

// ###################################################################
 // ⑤ 报告
// ###################################################################

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

function buildMarkdown(results: { spec: ScenarioSpec; run: AgentRunResult; pass: boolean; note: string }[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;

  const summaryRows = results
    .map((r) =>
      `| ${r.spec.id} | ${r.spec.title} | ${r.run.iterations} | ${r.run.toolCallCount} | ${r.run.stopReason === "finished" ? "✅" : "⚠️"} | ${truncate(toolSequence(r.run) || "零调用", 60)} | ${r.pass ? "✅" : "❌"} |`,
    )
    .join("\n");

  const promptTokens = results.reduce((n, r) => n + r.run.promptTokens, 0);
  const completionTokens = results.reduce((n, r) => n + r.run.completionTokens, 0);

  const details = results
    .map(({ spec, run, note, pass }) => {
      const stepBlocks = run.steps
        .map((s) => {
          const head =
            s.kind === "final"
              ? `  - 第 ${s.iteration} 轮 · FINAL（模型结束循环）`
              : `  - 第 ${s.iteration} 轮 · TOOL_CALLS`;
          const narration = s.kind === "tool_calls" && s.assistantContent?.trim()
            ? `\n    模型旁白：${truncate(s.assistantContent.trim(), 160)}`
            : "";
          const execs = s.toolExecutions
            .map((e) => {
              const out = truncate(JSON.stringify(e.output), 240);
              return `      ${e.ok ? "✓" : "✗"} ${e.name} \`${e.args}\` → \`${out}\`${e.failedStage ? ` [${e.failedStage}]` : ""}`;
            })
            .join("\n");
          return `${head}${narration}${execs ? `\n${execs}` : ""}`;
        })
        .join("\n");

      return `## ${spec.id}：${spec.title}

- 判分：${pass ? "✅" : "❌"} ${note}
- 用户输入：${spec.text}
- 执行轨迹（${run.iterations} 轮 LLM，${run.toolCallCount} 次工具调用，stopReason=${run.stopReason}）：
${stepBlocks}
- 最终答复：

\`\`\`text
${run.answer.trim()}
\`\`\``;
    })
    .join("\n\n---\n\n");

  return `# Day 22：Agent Loop —— while (!finished) 自主循环

> 日期：${date}
> 模型：${MODEL}（temperature=0）
> 工具：calculator / get_current_time / get_weather（Mock）/ search（Mock）

## 总览

- 场景通过：${passed}/${total}
- Prompt Tokens ${promptTokens}，Completion Tokens ${completionTokens}
- 循环结束条件：模型不再发起 tool_calls（finished）；另有临时安全上限 ${TEMP_SAFETY_LIMIT}（Day 24 正式化）

## 场景汇总

| 场景 | 说明 | LLM 轮数 | 工具次数 | 正常结束 | 工具序列 | 结果 |
|---|---|---|---|---|---|---|
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
  const results: { spec: ScenarioSpec; run: AgentRunResult; pass: boolean; note: string }[] = [];

  for (const spec of scenarios) {
    console.log(`[day22] === ${spec.id} ${spec.title} ===`);
    const run = await runAgent(spec.text);
    const j = spec.judge(run);
    results.push({ spec, run, pass: j.pass, note: j.note });
    console.log(`[day22]   pass=${j.pass} iterations=${run.iterations} tools=${run.toolCallCount} stop=${run.stopReason}`);
  }

  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs");
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, "day22-agent-loop.md");
  writeFileSync(outFile, buildMarkdown(results), "utf-8");
  console.log(`[day22] 结果已写入 ${outFile}`);
}

main().catch((err) => {
  console.error("[day22] 实验失败：", err);
  process.exit(1);
});
