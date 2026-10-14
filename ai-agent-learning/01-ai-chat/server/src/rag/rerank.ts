/**
 * Rerank 模块（Day 46）
 *
 * 分工：
 *   粗排 Vector Search 负责"找得到"——先把召回面放宽（TopN，N 远大于最终要用的 K）；
 *   精排 Rerank 负责"排得准"——对 N 条逐条和 query 做精细相关性打分，重新排序后取 TopK 送 LLM。
 *
 * 生产实现是交叉编码器（cross-encoder，如 bge-reranker / Cohere Rerank / Jina Rerank）：
 *   把 query 与文档拼在一起过一次模型，能捕捉双塔（bi-encoder）把整段压成单向量时丢掉的细粒度交互。
 *
 * 本日无真实 Rerank API，按计划先用 Mock 打分器（字符二元组 Dice 词重合度）占位，保证链路完整；
 * 之后替换真实模型只需换一个 RerankFn 实现，调用方（ragQuery）不用改。
 */

export interface RerankDoc {
  id: string;
  document: string;
}

/** 打分器契约：输入 query + 候选文档，返回与候选等长的相关性分数（越大越相关） */
export type RerankFn = (query: string, docs: RerankDoc[]) => Promise<number[]> | number[];

/** 字符二元组（bigram）集合：中文不需要分词器也能大致捕捉局部字词组合 */
function toBigrams(text: string): Set<string> {
  const chars = text.replace(/\s+/g, "").split("");
  const grams = new Set<string>();
  for (let i = 0; i < chars.length - 1; i++) grams.add(chars[i] + chars[i + 1]);
  return grams;
}

/**
 * Mock 打分器：字符二元组 Dice 系数（词重合度）
 *   score = 2|A∩B| / (|A|+|B|)，A=query bigram 集、B=文档 bigram 集，取值 [0,1]
 * 局限：只奖励字面重合，不认识同义改述——这正是它只能占位、真机必须换 cross-encoder 的原因。
 */
export const lexicalRerank: RerankFn = (query, docs) => {
  const q = toBigrams(query);
  return docs.map((d) => {
    const doc = toBigrams(d.document);
    let inter = 0;
    for (const g of q) if (doc.has(g)) inter++;
    const denom = q.size + doc.size;
    return denom === 0 ? 0 : (2 * inter) / denom;
  });
};

/** 重排：按分数降序，同分保持原（向量）顺序（稳定排序），返回重排后的下标序列 */
export function rerankOrder(scores: number[]): number[] {
  return scores
    .map((score, index) => ({ score, index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.index);
}
