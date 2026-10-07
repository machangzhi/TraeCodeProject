/**
 * Day 32：Document 入库
 *
 * 流程：Markdown → Chunk → Embedding → Vector DB
 *
 * 学习点：
 *   - 文档解析：从 Markdown 提取纯文本
 *   - Chunk 策略：固定长度 + Overlap（防止语义被切断）
 *   - 入库：每个 chunk 生成 embedding 后写入向量库
 *
 * 实验设计：
 *   1. 读取 data/docs/ 下的 3 个 Markdown 文件（vue2/vue3/react）
 *   2. 解析 Markdown 为纯文本（去除代码块标记但保留内容）
 *   3. 按固定长度（500 字符）+ overlap（50 字符）切分
 *   4. 每个 chunk 生成 embedding，写入 LocalVectorStore
 *   5. 统计：文档数、chunk 数、总 token
 *
 * 运行：cd server && npx tsx src/experiments/day32-document-ingestion.ts
 */
import "../env";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { pipeline, env, type Tensor } from "@xenova/transformers";

env.allowLocalModels = true as any;
env.allowRemoteModels = true as any;
env.remoteHost = "https://hf-mirror.com";

const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
const CACHE_FILE = join(process.cwd(), "data", "embedding-cache.json");
const STORE_FILE = join(process.cwd(), "data", "vector-store.json");
const DOCS_DIR = join(process.cwd(), "data", "docs");

const CHUNK_SIZE = 500;  // 每个 chunk 的字符数
const CHUNK_OVERLAP = 50; // 相邻 chunk 的重叠字符数

// ---------------- Embedding 封装 ----------------

type Cache = Record<string, number[]>;
function loadCache(): Cache {
  if (!existsSync(CACHE_FILE)) return {};
  try { return JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as Cache; } catch { return {}; }
}
function saveCache(c: Cache): void {
  if (!existsSync(join(process.cwd(), "data"))) mkdirSync(join(process.cwd(), "data"), { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2), "utf-8");
}
let embedder: Awaited<ReturnType<typeof pipeline>> | null = null;
async function embed(text: string): Promise<number[]> {
  const cache = loadCache();
  if (text in cache) return cache[text];
  if (!embedder) embedder = await pipeline("feature-extraction", EMBED_MODEL);
  const output = (await embedder(text, { pooling: "mean", normalize: true } as any)) as Tensor;
  const vec = Array.from(output.data);
  cache[text] = vec;
  saveCache(cache);
  return vec;
}

// ---------------- 本地向量存储（复用 Day 31） ----------------

interface StoreItem { id: string; document: string; embedding: number[]; metadata: Record<string, unknown>; }

class LocalVectorStore {
  private items: StoreItem[] = [];
  constructor(private filePath: string) { this.load(); }
  private load(): void {
    if (existsSync(this.filePath)) {
      try { this.items = JSON.parse(readFileSync(this.filePath, "utf-8")) as StoreItem[]; } catch { this.items = []; }
    }
  }
  private persist(): void {
    const dir = join(this.filePath, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.items, null, 2), "utf-8");
  }
  add(items: StoreItem[]): void {
    for (const item of items) {
      const idx = this.items.findIndex((i) => i.id === item.id);
      if (idx >= 0) this.items[idx] = item; else this.items.push(item);
    }
    this.persist();
  }
  count(): number { return this.items.length; }
  clear(): void { this.items = []; this.persist(); }
}

// ---------------- Markdown 解析 ----------------

function parseMarkdown(md: string): string {
  // 去除代码块标记（```）但保留代码内容
  let text = md.replace(/```[\s\S]*?```/g, (match) => {
    return match.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
  });
  // 去除标题标记 #
  text = text.replace(/^#{1,6}\s+/gm, "");
  // 去除列表标记 - * 1.
  text = text.replace(/^[-*]\s+/gm, "");
  text = text.replace(/^\d+\.\s+/gm, "");
  // 去除加粗/斜体标记
  text = text.replace(/[*_]{1,3}/g, "");
  // 合并多余空行
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

// ---------------- Chunk 切分 ----------------

function chunkText(text: string, size: number, overlap: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = end - overlap;
  }
  return chunks.filter((c) => c.length > 0);
}

// ---------------- 主实验 ----------------

async function main() {
  console.log("=== Day 32：Document 入库 ===\n");

  // 1. 读取所有 Markdown 文件
  const files = readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md"));
  console.log(`发现 ${files.length} 个 Markdown 文件：${files.join(", ")}`);

  const store = new LocalVectorStore(STORE_FILE);
  store.clear();

  let totalChunks = 0;
  const allItems: StoreItem[] = [];

  for (const file of files) {
    const filePath = join(DOCS_DIR, file);
    const raw = readFileSync(filePath, "utf-8");
    const text = parseMarkdown(raw);
    const chunks = chunkText(text, CHUNK_SIZE, CHUNK_OVERLAP);

    console.log(`\n  📄 ${file}`);
    console.log(`     原文 ${raw.length} 字符 → 解析后 ${text.length} 字符 → ${chunks.length} 个 chunk`);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = await embed(chunk);
      allItems.push({
        id: `${file}#${i}`,
        document: chunk,
        embedding,
        metadata: { file, chunkIndex: i, totalChunks: chunks.length },
      });
    }
    totalChunks += chunks.length;
  }

  store.add(allItems);

  console.log(`\n=== 入库统计 ===`);
  console.log(`  文档数：${files.length}`);
  console.log(`  Chunk 数：${totalChunks}`);
  console.log(`  Chunk 大小：${CHUNK_SIZE} 字符，Overlap：${CHUNK_OVERLAP} 字符`);
  console.log(`  向量库文档数：${store.count()}`);
  console.log(`  存储文件：${STORE_FILE}`);
  console.log(`\n  ✅ 文档入库完成`);

  // 打印每个 chunk 的预览
  console.log(`\n=== Chunk 预览 ===`);
  for (const item of allItems) {
    const preview = item.document.slice(0, 60).replace(/\n/g, " ");
    console.log(`  [${item.id}] ${preview}...`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
