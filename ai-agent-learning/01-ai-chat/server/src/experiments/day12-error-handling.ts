/**
 * Day 12：错误处理 —— 让 LLM 调用在各种失败路径下"可恢复、可观测、可降级"
 *
 * 覆盖计划中的五类错误：
 *   1. JSON 解析失败      2. LLM 输出格式错误（Schema 不合法）
 *   3. API 超时           4. API 错误（4xx / 5xx / 429 / 连接失败）
 *   5. 空响应（choices 空 / content 为 null）
 *
 * 错误处理框架（三层）：
 *   ① 分类 classify()：把 SDK 抛出的错误映射为带 retryable 标记的错误类型
 *   ② 网络重试 withNetworkRetry()：仅重试可恢复错误，指数退避 + jitter，
 *      429 优先尊重 Retry-After；关闭 SDK 自带重试，由本层统一控制
 *   ③ 结构化恢复 robustAnalyze()：响应健全性检查 → finish_reason=length
 *      检测（加大 max_tokens）→ JSON parse → Zod 校验（错误回喂修复），
 *      超过恢复轮数则降级，给调用方友好的 fallback 结果
 *
 * 测试策略（重点）：
 * - mock fetch 注入 OpenAI client，确定性触发 11 个场景，零成本、可重复
 * - 真实 API 只跑 4 个烟雾场景，验证对真实 SDK 错误的分类
 *
 * 运行：npx tsx src/experiments/day12-error-handling.ts
 * 输出：01-ai-chat/docs/day12-error-handling.md
 */
import "../env";
import OpenAI, {
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
} from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ============ 输出契约（沿用 Day 11）============
const RequirementSpecSchema = z
  .object({
    module: z.string(),
    pages: z.array(z.string()),
    components: z.array(z.string()),
    api: z.array(z.string()),
    risks: z.array(z.string()),
  })
  .strict();

type RequirementSpec = z.infer<typeof RequirementSpecSchema>;

const SYSTEM_PROMPT = `你是一名资深软件需求分析师。只输出一个 JSON 对象，不要输出解释或 markdown 代码块：
{
  "module": "核心模块名称",
  "pages": ["涉及的前端页面"],
  "components": ["关键 UI 组件"],
  "api": ["需要的后端接口"],
  "risks": ["实现风险或待澄清问题"]
}
只允许包含这五个字段。`;

// ============ ① 错误分类 ============
type ErrorKind =
  | "timeout" // 超时
  | "connection_error" // 连接失败/DNS/拒绝连接
  | "rate_limit" // 429
  | "server_error" // 5xx
  | "auth_error" // 401
  | "permission_denied" // 403
  | "bad_request" // 400
  | "not_found" // 404
  | "conflict" // 409
  | "unprocessable" // 422
  | "empty_response" // choices 缺失
  | "empty_content" // content 为 null/空串
  | "truncated" // finish_reason=length
  | "json_parse" // JSON.parse 失败
  | "schema_invalid" // Zod 校验失败
  | "unknown";

interface ErrorInfo {
  kind: ErrorKind;
  retryable: boolean;
  originName: string; // SDK 原始错误构造名
  status?: number;
  message: string;
  retryAfterMs?: number;
}

// Retry-After 两种形式：delta-seconds（"2"）或 HTTP-date
function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds)) return asSeconds * 1000;
  const asDate = Date.parse(value) - Date.now();
  if (Number.isFinite(asDate) && asDate >= 0 && asDate < 60_000) return asDate;
  return undefined;
}

function classify(err: unknown): ErrorInfo {
  const originName = (err as { constructor?: { name: string } })?.constructor?.name ?? "Unknown";
  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof APIConnectionTimeoutError) {
    return { kind: "timeout", retryable: true, originName, message: message || "请求超时" };
  }
  if (err instanceof RateLimitError) {
    return {
      kind: "rate_limit",
      retryable: true,
      originName,
      status: 429,
      message,
      retryAfterMs: parseRetryAfter(err.headers?.["retry-after"] ?? undefined),
    };
  }
  if (err instanceof AuthenticationError) {
    return { kind: "auth_error", retryable: false, originName, status: 401, message };
  }
  if (err instanceof PermissionDeniedError) {
    return { kind: "permission_denied", retryable: false, originName, status: 403, message };
  }
  if (err instanceof BadRequestError) {
    return { kind: "bad_request", retryable: false, originName, status: 400, message };
  }
  if (err instanceof InternalServerError) {
    return { kind: "server_error", retryable: true, originName, status: err.status, message };
  }
  if (err instanceof APIConnectionError) {
    return { kind: "connection_error", retryable: true, originName, message };
  }
  if (err instanceof APIError) {
    const status = err.status;
    const kind: ErrorKind =
      status === 404 ? "not_found"
        : status === 409 ? "conflict"
          : status === 422 ? "unprocessable"
            : status !== undefined && status >= 500 ? "server_error"
              : "bad_request";
    return {
      kind,
      retryable: status !== undefined && status >= 500,
      originName,
      status,
      message,
    };
  }
  // 未被 SDK 包装的裸 AbortError（防御性兜底）
  if ((err as { name?: string })?.name === "AbortError") {
    return { kind: "timeout", retryable: true, originName, message };
  }
  return { kind: "unknown", retryable: false, originName, message };
}

// ============ ② 网络重试 ============
interface RetryPolicy {
  maxRetries: number;
  timeoutMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

interface AttemptLog {
  attempt: number;
  result: "error" | "ok";
  kind?: ErrorKind;
  originName?: string;
  status?: number;
  waitedMs: number;
}

type RetryResult<T> =
  | { ok: true; value: T; attempts: AttemptLog[] }
  | { ok: false; error: ErrorInfo; attempts: AttemptLog[] };

async function withNetworkRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
): Promise<RetryResult<T>> {
  const attempts: AttemptLog[] = [];

  for (let attempt = 1; attempt <= policy.maxRetries + 1; attempt++) {
    try {
      const value = await fn();
      attempts.push({ attempt, result: "ok", waitedMs: 0 });
      return { ok: true, value, attempts };
    } catch (err) {
      const info = classify(err);

      if (!info.retryable || attempt > policy.maxRetries) {
        attempts.push({
          attempt,
          result: "error",
          kind: info.kind,
          originName: info.originName,
          status: info.status,
          waitedMs: 0,
        });
        return { ok: false, error: info, attempts };
      }

      // 等待时长：429 优先 Retry-After；否则指数退避 + 0.5~1.0 jitter（防重试风暴）
      const exp = info.kind === "rate_limit" && info.retryAfterMs !== undefined
        ? info.retryAfterMs
        : Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
      const waitedMs = Math.floor(exp * (0.5 + Math.random() * 0.5));
      attempts.push({
        attempt,
        result: "error",
        kind: info.kind,
        originName: info.originName,
        status: info.status,
        waitedMs,
      });
      await sleep(waitedMs);
    }
  }
  throw new Error("unreachable");
}

// ============ JSON 解析（容错提取）============
function tryParse(raw: string): unknown | null {
  try {
    return JSON.parse(raw.trim());
  } catch {
    const fence = raw.trim().match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) {
      try {
        return JSON.parse(fence[1].trim());
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ============ ③ 结构化恢复调用 ============
interface RecoveryPolicy extends RetryPolicy {
  maxRounds: number;
  maxTokens: number;
}

interface RecoveryStage {
  round: number;
  event: ErrorKind | "success";
  detail: string;
}

type RecoveryResult =
  | {
      outcome: "success";
      data: RequirementSpec;
      stages: RecoveryStage[];
      totalCalls: number;
      elapsedMs: number;
    }
  | {
      outcome: "fallback";
      fallbackKind: ErrorKind;
      stages: RecoveryStage[];
      totalCalls: number;
      elapsedMs: number;
    };

async function robustAnalyze(
  client: OpenAI,
  userText: string,
  policy: RecoveryPolicy,
): Promise<RecoveryResult> {
  const stages: RecoveryStage[] = [];
  let extraMessages: ChatCompletionMessageParam[] = [];
  let maxTokens = policy.maxTokens;
  let totalCalls = 0;
  const startedAt = Date.now();

  for (let round = 1; round <= policy.maxRounds; round++) {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userText },
      ...extraMessages,
    ];

    const net = await withNetworkRetry(
      () =>
        client.chat.completions.create(
          {
            model: process.env.MODEL_CHAT || "deepseek-chat",
            messages,
            temperature: 0,
            response_format: { type: "json_object" },
            max_tokens: maxTokens,
          },
          // maxRetries 属 RequestOptions：关闭 SDK 重试，由 withNetworkRetry 统一控制
          { timeout: policy.timeoutMs, maxRetries: 0 },
        ),
      policy,
    );
    totalCalls += net.attempts.length;

    // 网络层预算耗尽 → 无法靠"换说法"恢复，直接降级
    if (!net.ok) {
      stages.push({
        round,
        event: net.error.kind,
        detail: `网络层 ${net.attempts.length} 次尝试后仍失败：${net.error.message} → 降级`,
      });
      return {
        outcome: "fallback",
        fallbackKind: net.error.kind,
        stages,
        totalCalls,
        elapsedMs: Date.now() - startedAt,
      };
    }

    const resp = net.value;
    const choice = resp.choices[0];

    // —— 响应健全性检查 ——
    if (resp.choices.length === 0) {
      stages.push({ round, event: "empty_response", detail: "响应体 choices 为空数组" });
      extraMessages = [
        { role: "user", content: "你的上一次响应为空，请重新输出符合要求的 JSON 对象。" },
      ];
      continue;
    }
    const content = choice.message.content;
    if (content === null || content.trim() === "") {
      stages.push({
        round,
        event: "empty_content",
        detail: `content 为空（finish_reason=${choice.finish_reason}）`,
      });
      extraMessages = [
        { role: "user", content: "你的上一次响应内容为空，请重新输出 JSON 对象。" },
      ];
      continue;
    }
    if (choice.finish_reason === "length") {
      const nextMaxTokens = Math.min(maxTokens * 4, 4096);
      stages.push({
        round,
        event: "truncated",
        detail: `finish_reason=length，输出 ${content.length} 字符半截 JSON；下一轮 max_tokens ${maxTokens}→${nextMaxTokens}`,
      });
      maxTokens = nextMaxTokens;
      extraMessages = [
        { role: "user", content: "你上一次输出的 JSON 不完整，请输出完整的 JSON 对象。" },
      ];
      continue;
    }

    // —— 语法层 ——
    const parsed = tryParse(content);
    if (parsed === null) {
      stages.push({
        round,
        event: "json_parse",
        detail: "JSON.parse 失败：输出是散文/解释文字而非 JSON",
      });
      extraMessages = [
        { role: "assistant", content },
        {
          role: "user",
          content: "你上一次的输出不是合法 JSON，请只输出符合格式的 JSON 对象，不要解释。",
        },
      ];
      continue;
    }

    // —— 语义结构层 ——
    const checked = RequirementSpecSchema.safeParse(parsed);
    if (!checked.success) {
      const errs = checked.error.issues.map(
        (i) => `${i.path.join(".") || "(根)"}: ${i.message}`,
      );
      stages.push({ round, event: "schema_invalid", detail: errs.join("；") });
      extraMessages = [
        { role: "assistant", content },
        { role: "user", content: `上一次输出不符合契约：${errs.join("；")} 请输出修正后的 JSON。` },
      ];
      continue;
    }

    stages.push({
      round,
      event: "success",
      detail: "请求成功，JSON 语法与 Schema 均通过",
    });
    return {
      outcome: "success",
      data: checked.data,
      stages,
      totalCalls,
      elapsedMs: Date.now() - startedAt,
    };
  }

  stages.push({
    round: policy.maxRounds + 1,
    event: "unknown",
    detail: `达到最大恢复轮数 ${policy.maxRounds}，降级处理`,
  });
  return {
    outcome: "fallback",
    fallbackKind: "unknown",
    stages,
    totalCalls,
    elapsedMs: Date.now() - startedAt,
  };
}

// ============ Mock fetch：确定性地制造各种失败 ============
type MockStep =
  | {
      type: "error";
      status: number;
      message?: string;
      headers?: Record<string, string>;
    }
  | { type: "hang" } // 挂住直到 SDK 超时 abort
  | { type: "json"; value: unknown; finishReason?: string };

function chatCompletionBody(value: unknown, finishReason = "stop") {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: 0,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: typeof value === "string" ? value : JSON.stringify(value) },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

// mock 原始 message 的辅助（content=null 等非标准内容专用）
function chatCompletionBodyRaw(message: unknown, finishReason: string) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: 0,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeMockFetch(script: MockStep[]): typeof fetch {
  let index = 0;
  return async (input, init) => {
    const step = script[Math.min(index, script.length - 1)];
    index++;
    const signal = init?.signal;

    if (step.type === "hang") {
      return new Promise((_resolve, reject) => {
        const timer = setTimeout(() => {}, 600_000);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          // name 必须是 AbortError，SDK 才会包装为 APIConnectionTimeoutError
          reject(Object.assign(new Error("Request timed out"), { name: "AbortError" }));
        });
      });
    }

    if (step.type === "error") {
      const body = {
        error: {
          message: step.message ?? `mock HTTP ${step.status}`,
          type: step.status === 429 ? "requests_api_limit_exceeded" : "server_error",
          code: null,
          param: null,
        },
      };
      return new Response(JSON.stringify(body), {
        status: step.status,
        headers: { "content-type": "application/json", ...(step.headers ?? {}) },
      });
    }

    return new Response(JSON.stringify(chatCompletionBody(step.value, step.finishReason)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function mockClient(script: MockStep[]): OpenAI {
  return new OpenAI({
    apiKey: "mock-key",
    baseURL: "https://mock.local/v1",
    maxRetries: 0,
    fetch: makeMockFetch(script),
  });
}

// 恢复场景第二轮统一返回的合法 JSON
const VALID_SPEC: RequirementSpec = {
  module: "演示模块",
  pages: ["页面A"],
  components: ["组件A"],
  api: ["接口A"],
  risks: ["风险A"],
};

// ============ 场景定义 ============
interface ScenarioResult {
  id: string;
  title: string;
  layer: "mock-network" | "mock-recovery" | "real";
  trigger: string;
  finalEvent: ErrorKind | "success";
  outcome: "success" | "fallback";
  totalCalls: number;
  waitedMs: number;
  elapsedMs: number;
  stages: RecoveryStage[];
  data?: RequirementSpec | null;
}

// 纯网络层场景（只验证 withNetworkRetry + classify）
async function runNetworkScenario(
  id: string,
  title: string,
  layer: ScenarioResult["layer"],
  trigger: string,
  client: OpenAI,
  policy: RetryPolicy,
): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const result = await withNetworkRetry(
    () =>
      client.chat.completions.create(
        {
          model: "mock-model",
          messages: [{ role: "user", content: "ping" }],
        },
        { timeout: policy.timeoutMs, maxRetries: 0 },
      ),
    policy,
  );
  const elapsedMs = Date.now() - startedAt;
  return {
    id,
    title,
    layer,
    trigger,
    finalEvent: result.ok ? "success" : result.error.kind,
    outcome: result.ok ? "success" : "fallback",
    totalCalls: result.attempts.length,
    waitedMs: result.attempts.reduce((n, a) => n + a.waitedMs, 0),
    elapsedMs,
    stages: [],
  };
}

async function runRecoveryScenario(
  id: string,
  title: string,
  layer: ScenarioResult["layer"],
  trigger: string,
  client: OpenAI,
  userText: string,
  policy: RecoveryPolicy,
): Promise<ScenarioResult> {
  const result = await robustAnalyze(client, userText, policy);
  return {
    id,
    title,
    layer,
    trigger,
    finalEvent: result.outcome === "success" ? "success" : result.fallbackKind,
    outcome: result.outcome,
    totalCalls: result.totalCalls,
    waitedMs: 0,
    elapsedMs: result.elapsedMs,
    stages: result.stages,
    data: result.outcome === "success" ? result.data : null,
  };
}

// 快速策略（mock 场景不值得等待真实退避）
const FAST: RetryPolicy = { maxRetries: 2, timeoutMs: 30_000, baseDelayMs: 20, maxDelayMs: 200 };

async function runAllScenarios(): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];

  // ---- M1：500 ×2 后成功 ----
  results.push(
    await runNetworkScenario(
      "M1",
      "连续两次 500 后成功",
      "mock-network",
      "mock 依次返回 500 / 500 / 200",
      mockClient([
        { type: "error", status: 500 },
        { type: "error", status: 500 },
        { type: "json", value: VALID_SPEC },
      ]),
      FAST,
    ),
  );

  // ---- M2：429 + Retry-After: 0 ----
  results.push(
    await runNetworkScenario(
      "M2",
      "429 限流（Retry-After: 0）后成功",
      "mock-network",
      "mock 返回 429 且 Retry-After: 0，再返回 200",
      mockClient([
        { type: "error", status: 429, headers: { "retry-after": "0" } },
        { type: "json", value: VALID_SPEC },
      ]),
      FAST,
    ),
  );

  // ---- M3：持续 429，预算耗尽降级 ----
  results.push(
    await runNetworkScenario(
      "M3",
      "持续 429，重试预算耗尽降级",
      "mock-network",
      "mock 恒定返回 429（Retry-After: 0）",
      mockClient([{ type: "error", status: 429, headers: { "retry-after": "0" } }]),
      FAST,
    ),
  );

  // ---- M4：401 不重试 ----
  results.push(
    await runNetworkScenario(
      "M4",
      "401 鉴权失败，立即失败不重试",
      "mock-network",
      "mock 返回 401",
      mockClient([{ type: "error", status: 401 }]),
      FAST,
    ),
  );

  // ---- M5：400 不重试 ----
  results.push(
    await runNetworkScenario(
      "M5",
      "400 参数错误，立即失败不重试",
      "mock-network",
      "mock 返回 400",
      mockClient([{ type: "error", status: 400 }]),
      FAST,
    ),
  );

  // ---- M6：choices 空数组（需要非标准 body，用内联 fetch 构造）----
  const m6Client = new OpenAI({
    apiKey: "mock-key",
    baseURL: "https://mock.local/v1",
    maxRetries: 0,
    fetch: (() => {
      let first = true;
      return async () => {
        if (first) {
          first = false;
          return new Response(
            JSON.stringify({ choices: [], usage: { total_tokens: 1 } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify(chatCompletionBody(VALID_SPEC)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
    })(),
  });
  results.push(
    await runRecoveryScenario(
      "M6",
      "空响应：choices 为空数组",
      "mock-recovery",
      "mock 首次返回 {choices: []}，二次正常",
      m6Client,
      "做个登录",
      { ...FAST, maxRounds: 4, maxTokens: 512 },
    ),
  );

  // ---- M7：content 为 null（同样需要非标准 body）----
  const m7Client = new OpenAI({
    apiKey: "mock-key",
    baseURL: "https://mock.local/v1",
    maxRetries: 0,
    fetch: (() => {
      let first = true;
      return async () => {
        if (first) {
          first = false;
          return new Response(
            JSON.stringify(
              chatCompletionBodyRaw({ role: "assistant", content: null }, "stop"),
            ),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify(chatCompletionBody(VALID_SPEC)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
    })(),
  });
  results.push(
    await runRecoveryScenario(
      "M7",
      "空内容：content 为 null",
      "mock-recovery",
      "mock 首次 content=null/finish_reason=stop，二次正常",
      m7Client,
      "做个登录",
      { ...FAST, maxRounds: 4, maxTokens: 512 },
    ),
  );

  // ---- M8：挂死 → 超时（验证快速失败）----
  results.push(
    await runNetworkScenario(
      "M8",
      "请求挂死触发超时（快速失败，不陪等）",
      "mock-network",
      "mock hang；timeout=50ms，maxRetries=3，baseDelay=10",
      mockClient([{ type: "hang" }]),
      { maxRetries: 3, timeoutMs: 50, baseDelayMs: 10, maxDelayMs: 80 },
    ),
  );

  // ---- M9：半截 JSON（length）→ 加大 max_tokens ----
  results.push(
    await runRecoveryScenario(
      "M9",
      "JSON 截断：finish_reason=length",
      "mock-recovery",
      "首次返回半截 JSON/finish_reason=length（max_tokens=8），二次正常",
      mockClient([
        { type: "json", value: '{"module":"登录","pages"', finishReason: "length" },
        { type: "json", value: VALID_SPEC },
      ]),
      "做个登录",
      { ...FAST, maxRounds: 4, maxTokens: 8 },
    ),
  );

  // ---- M10：散文输出 → JSON parse 失败 ----
  results.push(
    await runRecoveryScenario(
      "M10",
      "LLM 输出散文：JSON.parse 失败",
      "mock-recovery",
      "首次返回中文解释（finish_reason=stop），二次正常",
      mockClient([
        { type: "json", value: "抱歉，我无法直接为你生成需求方案，建议你先明确业务目标。" },
        { type: "json", value: VALID_SPEC },
      ]),
      "做个登录",
      { ...FAST, maxRounds: 4, maxTokens: 512 },
    ),
  );

  // ---- M11：Schema 不合法（module 为数字）→ 回喂修复 ----
  results.push(
    await runRecoveryScenario(
      "M11",
      "Schema 不合法：字段类型错误",
      "mock-recovery",
      '首次返回 {"module":123,...}，错误回喂后二次正常',
      mockClient([
        {
          type: "json",
          value: { module: 123, pages: [], components: [], api: [], risks: [] },
        },
        { type: "json", value: VALID_SPEC },
      ]),
      "做个登录",
      { ...FAST, maxRounds: 4, maxTokens: 512 },
    ),
  );

  // ============ 真实 API 烟雾场景 ============
  const realClient = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: process.env.DEEPSEEK_BASE_URL,
    maxRetries: 0,
  });

  // ---- R1：真实超时 ----
  results.push(
    await runNetworkScenario(
      "R1",
      "真实 API：10ms 超时",
      "real",
      "timeout=10ms，maxRetries=1（真实 DeepSeek）",
      realClient,
      { maxRetries: 1, timeoutMs: 10, baseDelayMs: 20, maxDelayMs: 100 },
    ),
  );

  // ---- R2：真实 400（不存在的模型）----
  const r2Started = Date.now();
  let r2: ScenarioResult;
  try {
    await realClient.chat.completions.create(
      {
        model: "no-such-model-xyz",
        messages: [{ role: "user", content: "ping" }],
      },
      { timeout: 30_000, maxRetries: 0 },
    );
    r2 = {
      id: "R2",
      title: "真实 API：不存在的模型",
      layer: "real",
      trigger: "model=no-such-model-xyz",
      finalEvent: "success",
      outcome: "success",
      totalCalls: 1,
      waitedMs: 0,
      elapsedMs: Date.now() - r2Started,
      stages: [],
    };
  } catch (err) {
    const info = classify(err);
    r2 = {
      id: "R2",
      title: "真实 API：不存在的模型",
      layer: "real",
      trigger: "model=no-such-model-xyz",
      finalEvent: info.kind,
      outcome: "fallback",
      totalCalls: 1,
      waitedMs: 0,
      elapsedMs: Date.now() - r2Started,
      stages: [],
    };
  }
  results.push(r2);

  // ---- R3：真实截断恢复 ----
  results.push(
    await runRecoveryScenario(
      "R3",
      "真实 API：截断 JSON 自动恢复",
      "real",
      "max_tokens=8 强制 length，第二轮自动加大（真实 DeepSeek）",
      realClient,
      "做个登录",
      {
        maxRetries: 2,
        timeoutMs: 30_000,
        baseDelayMs: 20,
        maxDelayMs: 200,
        maxRounds: 4,
        maxTokens: 8,
      },
    ),
  );

  // ---- R4：真实正常基线 ----
  results.push(
    await runRecoveryScenario(
      "R4",
      "真实 API：正常基线",
      "real",
      "max_tokens=512，标准一轮成功（真实 DeepSeek）",
      realClient,
      "我要做银行自助终端账户查询功能",
      {
        maxRetries: 2,
        timeoutMs: 30_000,
        baseDelayMs: 20,
        maxDelayMs: 200,
        maxRounds: 4,
        maxTokens: 512,
      },
    ),
  );

  return results;
}

// ============ 报告 ============
function buildMarkdown(results: ScenarioResult[]): string {
  const date = new Date().toISOString().slice(0, 10);

  const layerName: Record<ScenarioResult["layer"], string> = {
    "mock-network": "mock 网络层",
    "mock-recovery": "mock 恢复层",
    real: "真实 API",
  };

  const overviewRows = results
    .map(
      (r) =>
        `| ${r.id} | ${layerName[r.layer]} | ${r.title} | \`${r.trigger}\` | ${r.finalEvent} | ${r.outcome === "success" ? "✅ 成功" : "⚠️ 降级"} | ${r.totalCalls} | ${r.waitedMs} | ${r.elapsedMs} |`,
    )
    .join("\n");

  // 恢复层场景的阶段详情
  const recoverySections = results
    .filter((r) => r.stages.length > 0)
    .map((r) => {
      const stageLines = r.stages
        .map(
          (s) =>
            `- 轮次 ${s.round}：**${s.event === "success" ? "success" : s.event}** — ${s.detail}`,
        )
        .join("\n");
      let dataBlock = "";
      if (r.outcome === "success" && r.data) {
        dataBlock = `\n\n最终数据：\n\n\`\`\`json\n${JSON.stringify(r.data, null, 2)}\n\`\`\``;
      }
      return `### ${r.id}：${r.title}

触发：${r.trigger}

${stageLines}${dataBlock}`;
    })
    .join("\n\n");

  return `# Day 12：错误处理实验

> 日期：${date}
> 模型：mock fetch（零成本）+ ${process.env.MODEL_CHAT || "deepseek-chat"}（真实烟雾场景）
> 任务：验证 LLM 结构化调用在超时 / API 错误 / 限流 / 空响应 / 截断 / 非法 JSON / Schema 错误下的恢复与降级

## 错误处理决策矩阵

| 错误类型 | 识别方式 | 可重试 | 处理策略 |
|---|---|---|---|
| 超时 | \`APIConnectionTimeoutError\` | ✅ | 指数退避重试，预算耗尽降级 |
| 连接失败 | \`APIConnectionError\`（DNS/拒连） | ✅ | 指数退避重试 |
| 429 限流 | \`RateLimitError\` | ✅ | 优先按 \`Retry-After\` 等待，否则退避 |
| 5xx | \`InternalServerError\` | ✅ | 指数退避重试 |
| 401 鉴权 | \`AuthenticationError\` | ❌ | 立即失败，告警/检查 Key |
| 403 权限 | \`PermissionDeniedError\` | ❌ | 立即失败 |
| 400/404/409/422 | \`BadRequestError\` 等 | ❌ | 立即失败，修参数/代码（重试无意义） |
| choices 空 / content null | 响应健全性检查 | ✅（恢复轮） | 重新请求 |
| finish_reason=length | 截断检测 | ✅（恢复轮） | max_tokens ×4 后重发 |
| JSON.parse 失败 | 语法检查 | ✅（恢复轮，限次数） | 带格式提示重试 |
| Zod Schema 失败 | Schema 校验 | ✅（恢复轮，限次数） | 错误清单回喂修复 |
| 未知错误 | 兜底 | ❌ | 降级 + 记录原始错误名 |

关键工程点：**SDK 自带重试（默认 2 次）被显式关闭（maxRetries: 0），重试策略由应用层统一控制**，
否则错误分类、等待时长和调用次数都会被 SDK 黑盒接管，无法观测和测试。

## 场景总览

| # | 层 | 场景 | 触发方式 | 最终分类 | 结局 | API 调用次数 | 退避等待合计(ms) | 耗时(ms) |
|---|---|---|---|---|---|---|---|---|
${overviewRows}

---

## 恢复链路详情

${recoverySections}

---

## 分析与学习笔记

<!-- 实验运行后人工补充 -->
`;
}

async function main() {
  const results = await runAllScenarios();
  for (const r of results) {
    console.log(
      `[day12] ${r.id} ${r.title}: ${r.outcome}（calls=${r.totalCalls}, elapsed=${r.elapsedMs}ms）`,
    );
  }

  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs");
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, "day12-error-handling.md");
  writeFileSync(outFile, buildMarkdown(results), "utf-8");
  console.log(`[day12] 结果已写入 ${outFile}`);
}

main().catch((err) => {
  console.error("[day12] 实验失败：", err);
  process.exit(1);
});
