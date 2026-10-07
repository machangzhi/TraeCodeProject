/**
 * Day 38：Metadata 设计与过滤
 *
 * 学习点：
 *   - 为 Chunk 设计丰富的 Metadata
 *   - 基于 Metadata 的过滤检索
 *   - 过滤 + 向量检索的组合
 *
 * 实验设计：
 *   1. 重新入库，为每个 chunk 加上丰富 metadata：
 *      - file, heading, level, category（前端框架）, tags
 *   2. 实现带 filter 的 query：先按 metadata 过滤，再向量排序
 *   3. 测试：只在 vue 文档中检索、只在 react 文档中检索
 *
 * 运行：cd server && npx tsx src/experiments/day38-metadata-filter.ts
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

// ---------------- 带 Metadata 的 VectorStore ----------------

interface StoreItem {
  id: string;
  document: string;
  embedding: number[];
  metadata: {
    file: string;
    heading: string;
    level: number;
    category: string;   // 分类：vue / react
    tags: string[];     // 标签
  };
}

type MetadataFilter = Partial<StoreItem["metadata"]>;

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
  clear(): void { this.items = []; this.persist(); }
  count(): number { return this.items.length; }

  // 带过滤的查询：先按 metadata 过滤，再向量排序
  query(queryEmbedding: number[], nResults: number, filter?: MetadataFilter) {
    let candidates = this.items;
    if (filter) {
      candidates = candidates.filter((item) => {
        for (const [key, value] of Object.entries(filter)) {
          if (value === undefined) continue;
          const itemVal = (item.metadata as any)[key];
          if (Array.isArray(value)) {
            // tags 过滤：item 的 tags 包含任一 filter 的 tag 即匹配
            if (!value.some((v) => (itemVal as string[]).includes(v))) return false;
          } else {
            if (itemVal !== value) return false;
          }
        }
        return true;
      });
    }
    const scored = candidates.map((item) => ({
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

// ---------------- 结构化切分（复用 Day 37） ----------------

function chunkByHeadings(md: string, maxChunkSize: number = 800) {
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

function parseMarkdown(md: string): string {
  const codeBlocks: string[] = [];
  let text = md.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match.replace(/^```\w*\n?/, "").replace(/\n?```$/, ""));
    return `\x00CODE${codeBlocks.length - 1}\x00`;
  });
  text = text.replace(/^#{1,6}\s+/gm, "").replace(/^[-*]\s+/gm, "").replace(/^\d+\.\s+/gm, "").replace(/[*_]{1,3}/g, "");
  text = text.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

// 根据文件名推断 category 和 tags
function inferMetadata(file: string): { category: string; tags: string[] } {
  const name = file.toLowerCase();
  if (name.includes("vue3")) return { category: "vue", tags: ["vue3", "composition-api", "proxy"] };
  if (name.includes("vue2")) return { category: "vue", tags: ["vue2", "options-api", "defineproperty"] };
  if (name.includes("react")) return { category: "react", tags: ["react", "hooks", "jsx"] };
  return { category: "other", tags: [] };
}

// ---------------- 主实验 ----------------

async function main() {
  console.log("=== Day 38：Metadata 设计与过滤 ===\n");

  const store = new LocalVectorStore(STORE_FILE);
  store.clear();

  // 1. 入库：带丰富 metadata
  const files = readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md"));
  const allItems: StoreItem[] = [];

  for (const file of files) {
    const raw = readFileSync(join(DOCS_DIR, file), "utf-8");
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
        metadata: {
          file,
          heading: s.heading,
          level: s.level,
          category,
          tags,
        },
      });
    }
  }
  store.add(allItems);
  console.log(`入库 ${store.count()} 个 chunk（含 category/tags metadata）\n`);

  // 2. 展示 metadata
  console.log("=== Chunk Metadata ===\n");
  for (const item of allItems) {
    console.log(`  [${item.metadata.file} > ${item.metadata.heading}]`);
    console.log(`    category=${item.metadata.category}, tags=[${item.metadata.tags.join(", ")}]`);
  }

  // 3. 带过滤的检索
  console.log(`\n=== 带 Metadata 过滤的检索 ===\n`);

  const testQuery = "响应式原理是什么？";
  const qVec = await embed(testQuery);

  // 不过滤
  const r1 = store.query(qVec, 3);
  console.log(`  查询："${testQuery}"（不过滤）`);
  r1.forEach((r, i) => console.log(`    ${i + 1}. ${r.metadata.file} > ${r.metadata.heading} (dist=${r.distance.toFixed(4)})`));

  // 只看 vue
  const r2 = store.query(qVec, 3, { category: "vue" });
  console.log(`\n  查询："${testQuery}"（category=vue）`);
  r2.forEach((r, i) => console.log(`    ${i + 1}. ${r.metadata.file} > ${r.metadata.heading} (dist=${r.distance.toFixed(4)})`));

  // 只看 react
  const r3 = store.query(qVec, 3, { category: "react" });
  console.log(`\n  查询："${testQuery}"（category=react）`);
  r3.forEach((r, i) => console.log(`    ${i + 1}. ${r.metadata.file} > ${r.metadata.heading} (dist=${r.distance.toFixed(4)})`));

  // 按 tag 过滤
  const r4 = store.query(qVec, 3, { tags: ["proxy"] });
  console.log(`\n  查询："${testQuery}"（tags 包含 proxy）`);
  r4.forEach((r, i) => console.log(`    ${i + 1}. ${r.metadata.file} > ${r.metadata.heading} (dist=${r.distance.toFixed(4)})`));

  console.log(`\n=== 结论 ===`);
  console.log(`  Metadata 过滤可以缩小检索范围，提升精准度。`);
  console.log(`  场景：用户明确问"Vue"相关问题时，只在 category=vue 的文档中检索。`);
  console.log(`  也可以用 tags 做更细粒度的过滤（如只看含 proxy 标签的 chunk）。`);
}

main().catch((e) => { console.error(e); process.exit(1); });
