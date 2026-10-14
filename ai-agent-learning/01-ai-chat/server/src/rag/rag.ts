/**
 * RAG 服务模块
 *
 * 封装文档入库 + 检索 + LLM 生成的完整链路，供 API 和实验脚本复用。
 *
 * 流程：Query → Embedding → 过滤检索 Top K → 拼装 Context → LLM → Answer + Sources
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { pipeline, env, type Tensor } from "@xenova/transformers";
import { chat, type ChatMessage } from "../llm";

env.allowLocalModels = true as any;
env.allowRemoteModels = true as any;
env.remoteHost = "https://hf-mirror.com";

const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
const CACHE_FILE = join(process.cwd(), "data", "embedding-cache.json");
const STORE_FILE = join(process.cwd(), "data", "vector-store.json");
const DOCS_DIR = join(process.cwd(), "data", "docs");

// ---------------- Embedding ----------------

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

// ---------------- VectorStore ----------------

export interface ChunkMetadata {
  file: string;
  heading: string;
  level: number;
  category: string;
  tags: string[];
}

interface StoreItem {
  id: string;
  document: string;
  embedding: number[];
  metadata: ChunkMetadata;
}

type MetadataFilter = Partial<ChunkMetadata>;

export class LocalVectorStore {
  private items: StoreItem[] = [];
  constructor(private filePath: string = STORE_FILE) { this.load(); }
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
  clear(): void { this.items = []; this.persist(); }
  count(): number { return this.items.length; }
  // Day 39：只暴露 id + metadata（不含向量），供知识库列表接口聚合使用
  list(): { id: string; metadata: ChunkMetadata }[] {
    return this.items.map((i) => ({ id: i.id, metadata: i.metadata }));
  }

  query(queryEmbedding: number[], nResults: number, filter?: MetadataFilter) {
    let candidates = this.items;
    if (filter) {
      candidates = candidates.filter((item) => {
        for (const [key, value] of Object.entries(filter)) {
          if (value === undefined) continue;
          const itemVal = (item.metadata as any)[key];
          if (Array.isArray(value)) {
            if (!value.some((v) => (itemVal as string[]).includes(v))) return false;
          } else {
            if (itemVal !== value) return false;
          }
        }
        return true;
      });
    }
    const scored = candidates.map((item) => ({
      id: item.id,
      document: item.document,
      metadata: item.metadata,
      distance: 1 - cosineSimilarity(queryEmbedding, item.embedding),
    }));
    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, nResults);
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------------- Markdown 解析 + 结构化切分 ----------------

export function parseMarkdown(md: string): string {
  const codeBlocks: string[] = [];
  let text = md.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match.replace(/^```\w*\n?/, "").replace(/\n?```$/, ""));
    return `\x00CODE${codeBlocks.length - 1}\x00`;
  });
  text = text.replace(/^#{1,6}\s+/gm, "").replace(/^[-*]\s+/gm, "").replace(/^\d+\.\s+/gm, "").replace(/[*_]{1,3}/g, "");
  text = text.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export function chunkByHeadings(md: string, maxChunkSize: number = 800) {
  const lines = md.split("\n");
  const sections: { heading: string; content: string; level: number }[] = [];
  let currentHeading = "";
  let currentLevel = 0;
  let currentContent: string[] = [];
  const flush = () => {
    const content = currentContent.join("\n").trim();
    if (content) sections.push({ heading: currentHeading || "(无标题)", content, level: currentLevel });
    currentContent = [];
  };
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (m) { flush(); currentLevel = m[1].length; currentHeading = m[2].trim(); }
    else currentContent.push(line);
  }
  flush();
  return sections;
}

function inferMetadata(file: string): { category: string; tags: string[] } {
  const name = file.toLowerCase();
  if (name.includes("vue3")) return { category: "vue", tags: ["vue3", "composition-api", "proxy"] };
  if (name.includes("vue2")) return { category: "vue", tags: ["vue2", "options-api", "defineproperty"] };
  if (name.includes("react")) return { category: "react", tags: ["react", "hooks", "jsx"] };
  return { category: "other", tags: [] };
}

// ---------------- 入库 ----------------

export async function ingestDocuments(docsDir: string = DOCS_DIR): Promise<{ count: number; files: string[] }> {
  const store = new LocalVectorStore();
  store.clear();

  const files = readdirSync(docsDir).filter((f) => f.endsWith(".md"));
  const allItems: StoreItem[] = [];

  for (const file of files) {
    const raw = readFileSync(join(docsDir, file), "utf-8");
    const sections = chunkByHeadings(raw);
    const { category, tags } = inferMetadata(file);

    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      const content = parseMarkdown(s.content);
      if (!content) continue;
      const embedding = await embed(content);
      allItems.push({
        id: `${file}#${i}`,
        document: content,
        embedding,
        metadata: { file, heading: s.heading, level: s.level, category, tags },
      });
    }
  }
  store.add(allItems);
  return { count: store.count(), files };
}

// ---------------- 知识库列表 / 上传（Day 39） ----------------

export interface DocumentInfo {
  file: string;
  category: string;
  chunkCount: number;
  headings: string[];
}

/** 知识库列表：按文件聚合向量库中的 chunk（chunk 数与标题列表），供前端展示 */
export function listDocuments(): DocumentInfo[] {
  const store = new LocalVectorStore();
  const byFile = new Map<string, DocumentInfo>();
  for (const item of store.list()) {
    const { file, heading, category } = item.metadata;
    const info = byFile.get(file) ?? { file, category, chunkCount: 0, headings: [] };
    info.chunkCount += 1;
    if (heading && !info.headings.includes(heading)) info.headings.push(heading);
    byFile.set(file, info);
  }
  return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
}

/** 文件名消毒：只保留中英文、数字、点、下划线、连字符，防止路径穿越写出 docs 目录 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const safe = base.replace(/[^\w.\-\u4e00-\u9fa5]/g, "_").replace(/^\.+/, "");
  return safe || `upload-${Date.now()}.md`;
}

/**
 * 上传文档：写入 data/docs 后全量重新入库（已入库内容命中 embedding 缓存，只有新 chunk 会计算）
 */
export async function addDocument(
  filename: string,
  content: string,
): Promise<{ file: string; count: number }> {
  if (!existsSync(DOCS_DIR)) mkdirSync(DOCS_DIR, { recursive: true });
  const file = sanitizeFilename(filename);
  writeFileSync(join(DOCS_DIR, file), content, "utf-8");
  const result = await ingestDocuments();
  return { file, count: result.count };
}

// ---------------- RAG 查询 ----------------

export interface RAGSource {
  file: string;
  heading: string;
  distance: number;
}

export interface RAGResult {
  answer: string;
  sources: RAGSource[];
}

export async function ragQuery(
  question: string,
  options: { topK?: number; filter?: MetadataFilter } = {},
): Promise<RAGResult> {
  const { topK = 3, filter } = options;

  // 1. Embedding 查询
  const qVec = await embed(question);

  // 2. 检索 Top K
  const store = new LocalVectorStore();
  const results = store.query(qVec, topK, filter);

  // 3. 拼装上下文
  const context = results
    .map((r, i) => `[${i + 1}] (来源: ${r.metadata.file} - ${r.metadata.heading}) ${r.document}`)
    .join("\n\n");

  // 4. 构造 Prompt
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `你是一个基于知识库的问答助手。请严格根据下面提供的参考资料回答用户的问题。
如果参考资料中没有相关信息，请直接说"根据现有知识库无法回答该问题"，不要编造答案。
回答时请注明引用的来源编号，如 [1]。

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
      file: r.metadata.file,
      heading: r.metadata.heading,
      distance: r.distance,
    })),
  };
}
