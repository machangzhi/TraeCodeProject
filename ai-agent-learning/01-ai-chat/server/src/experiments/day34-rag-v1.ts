/**
 * Day 34：RAG 第一版
 *
 * 流程：Question → Retrieval → Context → LLM → Answer
 *
 * 学习点：
 *   - RAG 的完整链路：检索 → 拼装上下文 → 调 LLM 生成
 *   - Prompt 工程：如何把检索结果喂给 LLM
 *   - 带溯源的回答：返回 answer + sources
 *
 * 实验设计：
 *   1. 用户提问
 *   2. 从向量库检索 Top 3 chunks
 *   3. 拼装 System Prompt（含检索到的上下文）+ User Prompt（问题）
 *   4. 调用 LLM 生成回答
 *   5. 返回回答 + 来源文档
 *
 * 运行：cd server && npx tsx src/experiments/day34-rag-v1.ts
 */
import "../env";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { pipeline, env, type Tensor } from "@xenova/transformers";
import { chat, type ChatMessage } from "../llm";

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

// ---------------- LocalVectorStore ----------------

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

// ---------------- RAG ----------------

interface RAGResult {
  answer: string;
  sources: { file: string; chunkIndex: number; distance: number }[];
}

async function rag(question: string, topK: number = 3): Promise<RAGResult> {
  // 1. Embedding 查询
  const qVec = await embed(question);

  // 2. 检索 Top K
  const store = new LocalVectorStore(STORE_FILE);
  const results = store.query(qVec, topK);

  // 3. 拼装上下文
  const context = results
    .map((r, i) => `[${i + 1}] (来源: ${r.metadata.file}) ${r.document}`)
    .join("\n\n");

  // 4. 构造 Prompt
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `你是一个基于知识库的问答助手。请严格根据下面提供的参考资料回答用户的问题。
如果参考资料中没有相关信息，请直接说"根据现有知识库无法回答该问题"，不要编造答案。
回答时请注明引用的来源编号。

参考资料：
${context}`,
    },
    { role: "user", content: question },
  ];

  // 5. 调用 LLM
  const answer = await chat(messages);

  // 6. 返回回答 + 来源
  return {
    answer,
    sources: results.map((r) => ({
      file: r.metadata.file as string,
      chunkIndex: r.metadata.chunkIndex as number,
      distance: r.distance,
    })),
  };
}

// ---------------- 主实验 ----------------

async function main() {
  console.log("=== Day 34：RAG 第一版 ===\n");

  const questions = [
    "Vue3 的响应式原理是什么？",
    "React 怎么管理状态？",
    "Vue2 组件怎么定义？",
    "今天天气怎么样？", // 知识库中没有的问题
  ];

  for (const q of questions) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`  问题：${q}`);
    console.log(`${"=".repeat(60)}`);

    const result = await rag(q, 3);

    console.log(`\n  回答：\n${result.answer}\n`);
    console.log(`  来源：`);
    for (const s of result.sources) {
      console.log(`    - ${s.file}#${s.chunkIndex} (distance=${s.distance.toFixed(4)})`);
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ✅ RAG 第一版完成`);
  console.log(`${"=".repeat(60)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
