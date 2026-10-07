/**
 * Day 33：Retrieval
 *
 * 流程：Query → Embedding → Vector Search → Top K
 *
 * 学习点：
 *   - 检索的完整链路：查询向量化 → 相似度计算 → Top K 排序
 *   - Top K 参数对召回质量的影响
 *   - 召回结果的展示：文档内容 + 距离 + 来源
 *
 * 实验设计：
 *   1. 加载 Day 32 入库的向量库（6 个 chunk）
 *   2. 对 4 个查询分别检索 Top 3 / Top 5
 *   3. 分析召回结果的相关性
 *   4. 对比不同 K 值的召回差异
 *
 * 运行：cd server && npx tsx src/experiments/day33-retrieval.ts
 */
import "../env";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { pipeline, env, type Tensor } from "@xenova/transformers";

env.allowLocalModels = true as any;
env.allowRemoteModels = true as any;
env.remoteHost = "https://hf-mirror.com";

const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
const CACHE_FILE = join(process.cwd(), "data", "embedding-cache.json");
const STORE_FILE = join(process.cwd(), "data", "vector-store.json");

// ---------------- Embedding ----------------

type Cache = Record<string, number[]>;
function loadCache(): Cache {
  if (!existsSync(CACHE_FILE)) return {};
  try { return JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as Cache; } catch { return {}; }
}
let embedder: Awaited<ReturnType<typeof pipeline>> | null = null;
async function embed(text: string): Promise<number[]> {
  const cache = loadCache();
  if (text in cache) return cache[text];
  if (!embedder) embedder = await pipeline("feature-extraction", EMBED_MODEL);
  const output = (await embedder(text, { pooling: "mean", normalize: true } as any)) as Tensor;
  return Array.from(output.data);
}

// ---------------- LocalVectorStore（只读） ----------------

interface StoreItem { id: string; document: string; embedding: number[]; metadata: Record<string, unknown>; }

class LocalVectorStore {
  private items: StoreItem[] = [];
  constructor(private filePath: string) { this.load(); }
  private load(): void {
    if (existsSync(this.filePath)) {
      try { this.items = JSON.parse(readFileSync(this.filePath, "utf-8")) as StoreItem[]; } catch { this.items = []; }
    }
  }
  count(): number { return this.items.length; }
  query(queryEmbedding: number[], nResults: number): { id: string; document: string; metadata: Record<string, unknown>; distance: number }[] {
    const scored = this.items.map((item) => ({
      ...item,
      distance: 1 - cosineSimilarity(queryEmbedding, item.embedding),
    }));
    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, nResults);
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------------- 主实验 ----------------

async function main() {
  const store = new LocalVectorStore(STORE_FILE);
  console.log(`=== Day 33：Retrieval ===\n`);
  console.log(`向量库文档数：${store.count()}\n`);

  const queries = [
    { text: "Vue3 的响应式原理是什么？", expect: "vue3" },
    { text: "Vue2 和 Vue3 响应式有什么区别？", expect: "vue3" },
    { text: "React 怎么管理状态？", expect: "react" },
    { text: "Vue2 组件怎么定义？", expect: "vue2" },
  ];

  console.log("=== Top 3 检索 ===\n");
  for (const q of queries) {
    const qVec = await embed(q.text);
    const results = store.query(qVec, 3);
    console.log(`  查询："${q.text}"`);
    console.log(`  期望来源：${q.expect}`);
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const file = (r.metadata.file as string)?.replace(".md", "");
      const preview = r.document.slice(0, 50).replace(/\n/g, " ");
      const marker = file === q.expect ? "🎯" : "  ";
      console.log(`  ${marker} ${i + 1}. [${file}] distance=${r.distance.toFixed(4)} | ${preview}...`);
    }
    const topFile = (results[0].metadata.file as string)?.replace(".md", "");
    const hit = topFile === q.expect;
    console.log(`  ${hit ? "✅ Top1 命中" : "❌ Top1 未命中"}\n`);
  }

  console.log("=== Top K 对比（K=1/3/5） ===\n");
  const testQuery = "Vue3 的响应式原理是什么？";
  const qVec = await embed(testQuery);
  for (const k of [1, 3, 5]) {
    const results = store.query(qVec, k);
    const files = results.map((r) => (r.metadata.file as string)?.replace(".md", ""));
    const hitVue3 = files.includes("vue3");
    console.log(`  K=${k}: ${files.join(", ")} | 包含 vue3: ${hitVue3 ? "✅" : "❌"}`);
  }

  console.log(`\n=== 分析 ===`);
  console.log(`  K 越大，召回率越高（包含正确文档的概率越大），但噪声也越多。`);
  console.log(`  K 太小可能漏召回，K 太大浪费 LLM context。`);
  console.log(`  生产环境通常 K=3~5，后续 Day 44 会系统实验最优 K 值。`);
}

main().catch((e) => { console.error(e); process.exit(1); });
