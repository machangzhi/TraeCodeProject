import OpenAI from "openai";

/**
 * 创建一个 OpenAI 兼容的客户端实例。
 * 注意：DeepSeek 完全兼容 OpenAI 协议，所以这里只改 baseURL 就能用。
 */
const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL,
});

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// Day6：Token 限制。模型无状态，每轮都要把完整历史发给 API，
// 历史越长 prompt token 越多 —— 既烧费用又会撞 context window 上限。
// 这里在调用前按预算从最新往回保留消息，丢头的旧消息。
// 估算规则（不用精确 tokenizer，偏保守即可）：中文按 1 token/字，
// ASCII（英文/数字/符号）按 0.3 token/字符，再 +4 覆盖 role 等元数据开销。
const MAX_HISTORY_TOKENS = Number(process.env.MAX_HISTORY_TOKENS) || 8000;

function estimateTokens(msg: ChatMessage): number {
  let units = 0;
  for (const ch of msg.content) {
    // 非 ASCII（中文、全角标点等）按 1 token 计，ASCII 按 0.3 计
    units += ch.charCodeAt(0) > 127 ? 1 : 0.3;
  }
  return Math.ceil(units) + 4;
}

/**
 * 按 token 预算截断历史：system 消息永远保留，其余从最新往回装，
 * 装不下就丢更早的。最后一条用户消息（本轮提问）即使超预算也必须保留。
 */
export function trimHistory(
  messages: ChatMessage[],
  maxTokens: number = MAX_HISTORY_TOKENS,
): ChatMessage[] {
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");

  let budget = maxTokens - system.reduce((s, m) => s + estimateTokens(m), 0);
  const kept: ChatMessage[] = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const t = estimateTokens(rest[i]);
    if (t > budget && kept.length > 0) break;
    budget -= t;
    kept.unshift(rest[i]);
  }
  const dropped = rest.length - kept.length;
  if (dropped > 0) {
    console.log(`[trimHistory] 超出 token 预算，丢弃最早 ${dropped} 条消息`);
  }
  return [...system, ...kept];
}

/**
 * 调用 LLM 并返回模型回复的文本。
 * @param messages 完整的对话历史数组（含 system / user / assistant）
 * @returns 模型回复内容字符串
 */
export async function chat(messages: ChatMessage[]): Promise<string> {
  const trimmed = trimHistory(messages);
  console.log(
    `[llm] chat 请求：${messages.length} 条消息 → 截断后 ${trimmed.length} 条，估算 prompt ${trimmed.reduce((s, m) => s + estimateTokens(m), 0)} tokens`,
  );
  const response = await client.chat.completions.create({
    model: process.env.MODEL_CHAT || "deepseek-chat",
    messages: trimmed,
  });
  return response.choices[0].message.content || "";
}

/**
 * Day4：流式调用 LLM。
 * stream: true 后，返回值从“一次性给全部”变成异步可迭代对象（AsyncIterable），
 * 每次迭代拿到一个 chunk，新产生的文字在 choices[0].delta.content 里。
 */
export async function* chatStream(
  messages: ChatMessage[],
): AsyncGenerator<string> {
  const trimmed = trimHistory(messages);
  console.log(
    `[llm] stream 请求：${messages.length} 条消息 → 截断后 ${trimmed.length} 条，估算 prompt ${trimmed.reduce((s, m) => s + estimateTokens(m), 0)} tokens`,
  );
  const stream = await client.chat.completions.create({
    model: process.env.MODEL_CHAT || "deepseek-chat",
    messages: trimmed,
    stream: true,
  });
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}