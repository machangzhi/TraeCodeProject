/**
 * Query Rewrite 模块（Day 47）
 *
 * 检索质量的第一道工序：用户的口语化问题 → LLM 改写 → 检索式（Search Query）。
 *
 * 动机（Day 43 结论）：本地 embedding 模型对"缺实体锚点"的短问句排序会崩塌——
 * 「响应式原理是什么？」缺少 Vue/Vue2/Vue3/defineProperty/Proxy 等锚点词，
 * 导致正确的 chunk 被无关 chunk 压到全库第 5 名。改写的作用就是把这些锚点补回查询里，
 * 让向量检索能把正确的 chunk 拉回来。
 *
 * 注意：只改写"用于检索"的查询，最终喂给 LLM 生成答案的仍是用户原始问题
 * （ragQuery 里 question 与 searchQuery 分离），避免改写丢失用户意图。
 */
import { chatComplete } from "../llm";

const SYSTEM_PROMPT = `你是检索查询改写助手。把用户的问题改写为更适合向量检索的检索式，要求：
1. 补全省略的实体与技术名词（例：「响应式原理是什么？」应补充 Vue、Vue2、Vue3、defineProperty、Proxy、双向绑定等锚点词）。
2. 展开缩写、补充同义词与关键术语。
3. 删除寒暄、背景铺垫等与检索无关的内容，只保留核心检索意图。
4. 不要回答问题，只输出检索式本身；用中文，控制在 20~60 字。
只返回 JSON，格式：{"query": "改写后的检索式"}`;

export interface RewriteResult {
  /** 用于检索的查询；改写失败时回退为原始问题 */
  searchQuery: string;
  /** false 表示改写失败（LLM 报错或输出非法），已回退为原始问题 */
  rewritten: boolean;
  /** 供成本核算；失败时为 undefined */
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/** 容错解析：先整体 JSON.parse，失败再抓第一个 {...} 片段 */
function extractQuery(text: string): string | null {
  const readQuery = (s: string): string | null => {
    try {
      const obj = JSON.parse(s) as { query?: unknown };
      return typeof obj.query === "string" && obj.query.trim() ? obj.query.trim() : null;
    } catch {
      return null;
    }
  };
  return readQuery(text.trim()) ?? readQuery(text.match(/\{[\s\S]*\}/)?.[0] ?? "");
}

/**
 * 改写查询：失败隔离——单次异常或解析失败重试，仍失败则回退原始问题（不阻塞检索）。
 */
export async function rewriteQuery(question: string, attempts = 2): Promise<RewriteResult> {
  for (let i = 0; i < attempts; i++) {
    try {
      const { message, usage } = await chatComplete([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: question },
      ]);
      const q = extractQuery(message.content ?? "");
      if (q) return { searchQuery: q, rewritten: true, usage };
    } catch {
      // 单次失败继续重试，全部失败则回退
    }
  }
  return { searchQuery: question, rewritten: false };
}
