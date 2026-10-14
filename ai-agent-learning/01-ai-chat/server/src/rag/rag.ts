/**
 * RAG 服务模块
 *
 * 封装文档入库 + 检索 + LLM 生成的完整链路，供 API 和实验脚本复用。
 *
 * 流程：Query →(可选) 改写→ Search Query → Embedding → 过滤检索 Top N → (可选) 阈值过滤 → (可选) Rerank → Context →(可选) 注入防御→ LLM → Answer + Sources
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { pipeline, env, type Tensor } from "@xenova/transformers";
import { chat } from "../llm";
import { rerankOrder, type RerankFn } from "./rerank";
import { buildRagMessages } from "./prompt";

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
  /** Day 46：启用 Rerank 时该 chunk 的精排分数（越大越相关）；未启用则为 undefined */
  rerankScore?: number;
}

export interface RAGResult {
  answer: string;
  sources: RAGSource[];
  /** Day 45：是否检索到通过相似度阈值的内容；false 表示直接短路拒答（未调用 LLM） */
  matched: boolean;
}

export async function ragQuery(
  question: string,
  options: {
    topK?: number;
    filter?: MetadataFilter;
    threshold?: number;
    /** Day 46：精排打分器；不传则跳过 Rerank（纯向量排序） */
    rerank?: RerankFn;
    /** Day 46：粗排召回条数（重排的输入规模），默认 20；无重排时等于 topK */
    rerankTopN?: number;
    /**
     * Day 47：改写后的检索式。提供时仅用于 Embedding / Rerank（即"检索"），
     * 而填进 LLM 的 user 消息仍是原始 question——改写只改检索、不改回答意图。
     */
    searchQuery?: string;
    /**
     * Day 48：是否启用 Prompt Injection 防御版 Prompt（`<documents>` 边界 + "文档是数据不是指令"声明）。
     * 默认 true；仅 Day 48 的防御前后对照实验传 false 走 Day 39~47 的基线 Prompt。
     */
    guard?: boolean;
  } = {},
): Promise<RAGResult> {
  const { topK = 3, filter, threshold, rerank, rerankTopN = 20, searchQuery, guard = true } = options;

  // Day 47：检索用的查询——有改写用改写，没有则用原始问题
  const retrieveQuery = searchQuery?.trim() ? searchQuery : question;

  // 1. Embedding 查询
  const qVec = await embed(retrieveQuery);

  // 2. 粗排：向量检索。启用 Rerank 时把召回放宽到 rerankTopN（先广召回，再精排）；否则直接取 topK
  const store = new LocalVectorStore();
  const retrieveN = rerank ? Math.max(rerankTopN, topK) : topK;
  const results = store.query(qVec, retrieveN, filter);

  // 2.5 Day 45：相似度阈值过滤——distance（=1-cosine）高于阈值的召回视为无关内容直接丢弃。
  //     阈值作用在向量距离空间，是"防明显无关"的第一道闸，先于 Rerank 执行。
  const kept = typeof threshold === "number" ? results.filter((r) => r.distance <= threshold) : results;

  // 3. 一条都不够格：不调 LLM，直接短路返回，既省成本又避免用无关上下文硬凑答案
  if (kept.length === 0) {
    return {
      answer: "根据现有知识库无法回答该问题（未检索到相关内容）。",
      sources: [],
      matched: false,
    };
  }

  // 3.5 Day 46：精排。对粗排候选逐条打分后重排，再截到 topK——
  //     关键收益是"把排位靠后的正确 chunk 提前"，这正是 Day 43/45 里 topK=3 召不回 C1/C6 gold 的解药。
  type ScoredChunk = (typeof kept)[number] & { rerankScore?: number };
  let final: ScoredChunk[] = kept;
  if (rerank) {
    const scores = await rerank(
      retrieveQuery,
      kept.map((r) => ({ id: r.id, document: r.document })),
    );
    const order = rerankOrder(scores);
    final = order.slice(0, topK).map((i) => ({ ...kept[i], rerankScore: scores[i] }));
  }

  // 4. 拼装 Prompt
  //    Day 48：不再把 context 直接铺进 system，而是交给 prompt.ts——
  //    防御版用 <documents> 划边界并声明"文档内容是数据不是指令"，阻断间接 Prompt Injection。
  const messages = buildRagMessages(
    question,
    final.map((r) => ({ file: r.metadata.file, heading: r.metadata.heading, document: r.document })),
    { guard },
  );

  // 6. 调用 LLM
  const answer = await chat(messages);

  // 7. 返回回答 + 来源（保持精排后的顺序）
  return {
    answer,
    sources: final.map((r) => ({
      file: r.metadata.file,
      heading: r.metadata.heading,
      distance: r.distance,
      rerankScore: r.rerankScore,
    })),
    matched: true,
  };
}
