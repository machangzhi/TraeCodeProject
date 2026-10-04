/**
 * Day 27：Agent 核心循环（事件化版本）
 *
 * 汇集 Day 22-26 的全部成果，专为前端思考链 UI 事件化：
 *   - Day 22：显式 while 循环，无 tool_calls 即终止（终止权交给模型）
 *   - Day 24：MAX_ITERATIONS=10 硬上限 + 去 tools 强制收尾软着陆
 *   - Day 25：LLM 调用失败循环层重试 3 次，错误 JSON 回喂
 *   - Day 26：支持传入历史消息（Memory 由前端会话历史提供，full 策略）
 *
 * 事件流（SSE 推给前端，驱动思考链时间线）：
 *   thinking    模型每轮决策时的自然语言叙述（可能没有）
 *   tool_call   发起工具调用（工具名 + 参数）
 *   tool_result 工具返回（成功/失败 + 耗时）
 *   answer      最终答复（Markdown）
 *   done        统计收尾（stopReason/轮数/工具次数/tokens）
 */
import type OpenAI from "openai";
import type { ChatMessage } from "../llm";
import { chatComplete } from "../llm";
import { ToolRegistry } from "./registry";
import { makeAgentTools } from "./tools";

export const MAX_ITERATIONS = 10;

export const AGENT_SYSTEM_PROMPT =
  "你是 AI Agent 助手，可以使用 calculator / get_current_time / get_weather 三个工具。" +
  "需要精确计算或实时信息时必须调用对应工具，不要心算或编造；" +
  "每次决定调用工具前，用一两句话简短说明你的思考；" +
  "天气数据为 Mock 模拟数据时须向用户说明；无依赖的调用可并行；" +
  "信息足够后用中文作答。";

export type AgentEvent =
  | { type: "thinking"; content: string }
  | { type: "tool_call"; name: string; args: string }
  | { type: "tool_result"; name: string; ok: boolean; output: unknown; elapsedMs: number }
  | { type: "answer"; content: string }
  | { type: "done"; stopReason: string; iterations: number; toolCalls: number; promptTokens: number; completionTokens: number };

type LLMResponse = {
  message: OpenAI.Chat.ChatCompletionMessage;
  usage: { prompt_tokens: number; completion_tokens: number };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RunAgentOptions {
  /** 用户最新输入 */
  input: string;
  /** 历史对话（仅 user/assistant 文本，由前端会话提供；Memory 语义 = full 策略） */
  history?: ChatMessage[];
  /** 每个事件回调（SSE 写出） */
  onEvent: (e: AgentEvent) => void;
  /** LLM 重试间隔（默认 2000ms；测试可置 0） */
  llmRetryBackoffMs?: number;
}

/**
 * 跑完整个 Agent 任务，通过 onEvent 推送过程事件。
 * 永不抛出：所有失败都变成 answer 事件（如实告知失败）+ done 事件。
 */
export async function runAgentStream(opts: RunAgentOptions): Promise<void> {
  const registry = new ToolRegistry();
  for (const t of makeAgentTools()) registry.register(t);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: AGENT_SYSTEM_PROMPT },
    ...(opts.history ?? []).map((m) => ({ role: m.role, content: m.content }) as OpenAI.Chat.ChatCompletionMessageParam),
    { role: "user", content: opts.input },
  ];

  const stats = { iterations: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0 };

  const emitLLMErrorAnswer = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    opts.onEvent({
      type: "answer",
      content: `抱歉，Agent 运行失败：${msg}。请稍后重试。`,
    });
    opts.onEvent({ type: "done", stopReason: "error", iterations: stats.iterations, toolCalls: stats.toolCalls, promptTokens: stats.promptTokens, completionTokens: stats.completionTokens });
  };

  /** 带重试的一次 LLM 调用（Day 25：循环层重试 3 次） */
  const callLLMWithRetry = async (tools?: OpenAI.Chat.Completions.ChatCompletionTool[]): Promise<LLMResponse> => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await chatComplete(messages, tools ? { tools } : {});
      } catch (err) {
        lastErr = err;
        if (attempt < 3) await sleep(opts.llmRetryBackoffMs ?? 2000);
      }
    }
    throw lastErr;
  };

  try {
    let finished = false;
    while (!finished) {
      const resp = await callLLMWithRetry(registry.definitions());
      stats.iterations += 1;
      stats.promptTokens += resp.usage.prompt_tokens;
      stats.completionTokens += resp.usage.completion_tokens;
      const msg = resp.message;
      const calls = msg.tool_calls ?? [];

      // 模型叙述 → thinking 事件（思考链第一环）
      if (msg.content && msg.content.trim()) {
        opts.onEvent({ type: "thinking", content: msg.content.trim() });
      }

      // 出口一：不再要求工具 → 自主收尾
      if (calls.length === 0) {
        const answer = msg.content ?? "";
        opts.onEvent({ type: "answer", content: answer });
        opts.onEvent({ type: "done", stopReason: "finished", iterations: stats.iterations, toolCalls: stats.toolCalls, promptTokens: stats.promptTokens, completionTokens: stats.completionTokens });
        finished = true;
        break;
      }

      messages.push(msg);
      for (const call of calls) {
        const started = Date.now();
        opts.onEvent({ type: "tool_call", name: call.function.name, args: call.function.arguments });
        const r = registry.execute(call.function.name, call.function.arguments);
        stats.toolCalls += 1;
        const output = r.ok ? r.data : { error: r.error, stage: r.stage };
        opts.onEvent({ type: "tool_result", name: call.function.name, ok: r.ok, output, elapsedMs: Date.now() - started });
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
      }

      // 出口二：硬上限 → 去 tools 强制收尾（Day 24）
      if (stats.iterations >= MAX_ITERATIONS) {
        messages.push({
          role: "user",
          content: `[system] 已达到最大迭代次数（${MAX_ITERATIONS}）。请基于以上已获取的信息直接给出最终中文答复。`,
        });
        const fin = await callLLMWithRetry();
        stats.promptTokens += fin.usage.prompt_tokens;
        stats.completionTokens += fin.usage.completion_tokens;
        const answer = (fin.message.content ?? "").trim();
        opts.onEvent({ type: "answer", content: answer || `[Agent 已达到最大迭代次数（${MAX_ITERATIONS}），任务未完成，已强制停止。]` });
        opts.onEvent({ type: "done", stopReason: "max_iterations", iterations: stats.iterations, toolCalls: stats.toolCalls, promptTokens: stats.promptTokens, completionTokens: stats.completionTokens });
        finished = true;
      }
    }
  } catch (err) {
    emitLLMErrorAnswer(err);
  }
}
