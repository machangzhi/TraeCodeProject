/**
 * Keyword Search 模块（Day 48）
 *
 * 分工（与向量检索互补，不是替代）：
 *   Vector Search 把整段压成一个向量，擅长"语义相近"（复述、同义改写），
 *   但对精确术语（API 名、驼峰标识符）不稳定——Day 43 病根就是中文短问句缺锚点时向量排序崩塌；
 *   Keyword Search 只认字面重合，精确术语一查一个准，但换个说法（"数据一变界面就更新"）就全空。
 *   两者一互补，正好覆盖对方的盲区 → Hybrid Search。
 *
 * 本模块两个零件：
 *   1. KeywordIndex：字符/词混合分词的 BM25 打分（中文用二元组，无需分词器）
 *   2. rrfFuse：Reciprocal Rank Fusion，把"向量排名"和"关键词排名"合成一路——
 *      只吃名次不吃分数，因为 BM25 分数与 cosine 距离尺度不可比，直接加权是错的。
 */
import { rerankOrder } from "./rerank";

export interface KeywordDoc {
  id: string;
  document: string;
}

/**
 * 混合分词：ASCII 词（含数字/下划线，覆盖 Proxy、onMounted、setState 这类标识符）
 * + 中文连续段切成二元组（无分词器也能捕捉"响应式""生命周期"这类字面词）。
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  for (const m of lower.matchAll(/[a-z0-9_]+/g)) tokens.push(m[0]);
  for (const m of lower.matchAll(/[\u4e00-\u9fa5]+/g)) {
    const seg = m[0];
    if (seg.length === 1) {
      tokens.push(seg);
      continue;
    }
    for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2));
  }
  return tokens;
}

const K1 = 1.5;
const B = 0.75;

/**
 * BM25 倒排索引：建一次索引，多次打分。
 *   score(q, d) = Σ_t idf(t) · (tf · (k1+1)) / (tf + k1 · (1 - b + b · |d| / avgdl))
 * idf 用"词在多少篇文档出现"的逆对数——越罕见的术语（如 onMounted）权重越高，
 * 这正是精确术语检索能压过向量的原因。
 */
export class KeywordIndex {
  private docTokens: Map<string, number>[] = [];
  private lengths: number[] = [];
  private df = new Map<string, number>();
  private avgdl = 0;

  constructor(private docs: KeywordDoc[]) {
    for (const doc of docs) {
      const tokens = tokenize(doc.document);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      this.docTokens.push(tf);
      this.lengths.push(tokens.length);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    const total = this.lengths.reduce((s, n) => s + n, 0);
    this.avgdl = this.lengths.length ? total / this.lengths.length : 0;
  }

  /** 对全部文档打分，返回与 docs 同序的分数（无字面重合为 0） */
  scores(query: string): number[] {
    const qTokens = new Set(tokenize(query));
    const n = this.docs.length;
    return this.docTokens.map((tf, i) => {
      let score = 0;
      for (const t of qTokens) {
        const f = tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const len = this.lengths[i];
        score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (len / (this.avgdl || 1)))));
      }
      return score;
    });
  }

  /** 关键词排名（只保留有字面重合的文档，按分数降序、同分保持原序） */
  ranking(query: string): number[] {
    const scores = this.scores(query);
    return rerankOrder(scores).filter((i) => scores[i] > 0);
  }
}

/**
 * RRF（Reciprocal Rank Fusion）：多路排名融合的事实标准。
 *   fused(d) = Σ_r 1 / (k + rank_r(d))，rank 从 1 起，k 默认 60（越大越平权，抑制任一路霸榜）
 * 只用名次不用分数，天然回避了"BM25 分数 4.2 与 cosine 0.7 怎么加权"这个没法回答的问题。
 */
export function rrfFuse(rankings: number[][], k = 60): number[] {
  const fused = new Map<number, number>();
  for (const ranking of rankings) {
    ranking.forEach((docIndex, pos) => {
      fused.set(docIndex, (fused.get(docIndex) ?? 0) + 1 / (k + pos + 1));
    });
  }
  return [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([docIndex]) => docIndex);
}
