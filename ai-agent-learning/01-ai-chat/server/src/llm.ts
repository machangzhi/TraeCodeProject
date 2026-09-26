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

/**
 * 调用 LLM 并返回模型回复的文本。
 * @param messages 完整的对话历史数组（含 system / user / assistant）
 * @returns 模型回复内容字符串
 */
export async function chat(messages: ChatMessage[]): Promise<string> {
  // TODO(Day2·你来写)：
  // 1. 调用 client.chat.completions.create(...)
  //    传入 model: process.env.MODEL_CHAT（默认 "deepseek-chat"）和 messages
  const response = await client.chat.completions.create({
    model: process.env.MODEL_CHAT || "deepseek-chat",
    messages,
  });
  // 2. 从返回值中取出 choices[0].message.content 返回
  return response.choices[0].message.content || "";
  // 提示：返回值类型是 ChatCompletion，content 可能为 null，需要兜底成空字符串 ""
}

/**
 * Day4：流式调用 LLM。
 * stream: true 后，返回值从“一次性给全部”变成异步可迭代对象（AsyncIterable），
 * 每次迭代拿到一个 chunk，新产生的文字在 choices[0].delta.content 里。
 */
export async function* chatStream(
  messages: ChatMessage[],
): AsyncGenerator<string> {
  const stream = await client.chat.completions.create({
    model: process.env.MODEL_CHAT || "deepseek-chat",
    messages,
    stream: true,
  });
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}