/**
 * Day 31：向量库选型 + Chroma 本地环境
 *
 * 学习点：
 *   - 向量库选型：Chroma（本地嵌入式，零运维）vs pgvector（需 PostgreSQL + Docker）
 *   - 向量库核心操作：add / query / count / persistence
 *   - Docker 迷你技能：docker run / logs / stop（记录命令）
 *
 * 选型决策：
 *   - 原计划用 Chroma，但 chromadb JS 客户端仅支持连接远程服务器，不支持嵌入式持久化
 *   - Docker 未安装，无法起 Chroma Server
 *   - 因此实现一个 LocalVectorStore（模拟 Chroma 接口），理解向量库底层原理
 *   - 后续 Day 109 Docker 编排时可切换到真正的 Chroma Server
 *
 * 实验设计：
 *   1. 实现 LocalVectorStore：内存存储 + JSON 持久化 + Cosine Top K
 *   2. 写入 Day 30 的 6 段文档（自带本地 embedding）
 *   3. 执行查询，验证召回
 *   4. 验证持久化：重启后数据仍在
 *
 * 运行：cd server && npx tsx src/experiments/day31-chroma.ts
 * 数据：server/data/vector-store.json（已 gitignore）
 */
import "../env";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { pipeline, env, type Tensor } from "@xenova/transformers";

env.allowLocalModels = true as any;
env.allowRemoteModels = true as any;
env.remoteHost = "https://hf-mirror.com";

const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
const CACHE_FILE = join(process.cwd(), "data", "embedding-cache.json");
const STORE_FILE = join(process.cwd(), "data", "vector-store.json");

// ---------------- Embedding 封装（复用 Day 29） ----------------

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

// ---------------- 本地向量存储（模拟 Chroma 接口） ----------------

interface StoreItem {
  id: string;
  document: string;
  embedding: number[];
  metadata: Record<string, unknown>;
}

class LocalVectorStore {
  private items: StoreItem[] = [];
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    if (existsSync(this.filePath)) {
      try {
        this.items = JSON.parse(readFileSync(this.filePath, "utf-8")) as StoreItem[];
      } catch {
        this.items = [];
      }
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
      if (idx >= 0) this.items[idx] = item;
      else this.items.push(item);
    }
    this.persist();
  }

  count(): number {
    return this.items.length;
  }

  query(queryEmbedding: number[], nResults: number): { ids: string[]; documents: string[]; distances: number[] } {
    const scored = this.items.map((item) => ({
      id: item.id,
      document: item.document,
      distance: 1 - cosineSimilarity(queryEmbedding, item.embedding), // 距离 = 1 - 相似度
    }));
    scored.sort((a, b) => a.distance - b.distance);
    const top = scored.slice(0, nResults);
    return {
      ids: top.map((t) => t.id),
      documents: top.map((t) => t.document),
      distances: top.map((t) => t.distance),
    };
  }

  clear(): void {
    this.items = [];
    this.persist();
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
  const docs = [
    { id: "vue2", text: "Vue2 组件使用 Options API，通过 data、methods、computed 选项定义组件逻辑，响应式系统基于 Object.defineProperty。" },
    { id: "vue3", text: "Vue3 组件推荐使用 Composition API，通过 setup 函数和 ref、reactive 定义响应式数据，响应式系统基于 Proxy。" },
    { id: "react", text: "React 组件使用函数组件和 Hooks（useState、useEffect），通过虚拟 DOM diff 实现高效更新，状态管理依赖单向数据流。" },
    { id: "weather", text: "今天北京天气晴朗，气温 22 摄氏度，空气质量优，适合户外活动。" },
    { id: "cooking", text: "这道菜的做法是先将食材切好，热锅冷油，爆香葱姜蒜，再放入主料翻炒，最后调味出锅。" },
    { id: "sports", text: "昨晚的足球比赛非常精彩，主队在补时阶段绝杀对手，球迷欢呼雀跃。" },
  ];

  console.log("=== Step 1：初始化 LocalVectorStore ===\n");
  const store = new LocalVectorStore(STORE_FILE);
  store.clear(); // 保证实验可重复
  console.log(`  存储文件：${STORE_FILE}`);

  console.log("\n=== Step 2：写入文档 ===\n");
  const items: StoreItem[] = [];
  for (const d of docs) {
    items.push({
      id: d.id,
      document: d.text,
      embedding: await embed(d.text),
      metadata: { category: d.id },
    });
  }
  store.add(items);
  console.log(`  已写入 ${store.count()} 条文档`);

  console.log("\n=== Step 3：语义查询（Top 3，distance = 1 - cosine） ===\n");
  const queries = [
    "Vue3 的响应式原理是什么？",
    "React 如何管理状态？",
    "怎么做出好吃的菜？",
  ];

  for (const q of queries) {
    const qVec = await embed(q);
    const result = store.query(qVec, 3);
    console.log(`  查询："${q}"`);
    console.log(`    Top3：${result.ids.map((id, i) => `${id}(${result.distances[i].toFixed(4)})`).join(" > ")}`);
  }

  console.log("\n=== Step 4：验证持久化（新建 Store 读取） ===\n");
  const store2 = new LocalVectorStore(STORE_FILE);
  const count2 = store2.count();
  console.log(`  新建 Store 读取，文档数：${count2}`);
  console.log(`  ${count2 === docs.length ? "✅ 数据持久化成功" : "❌ 数据丢失"}`);

  console.log("\n=== 选型对比 ===\n");
  console.log("  方案              | 运维成本 | 适用场景");
  console.log("  ----------------- | -------- | ------------------------");
  console.log("  LocalVectorStore  | 零运维   | 学习/原型/小规模（本项目当前）");
  console.log("  Chroma Embedded   | 零运维   | Python 生态（JS 客户端不支持）");
  console.log("  Chroma Server     | 需 Docker | 中等规模，多客户端");
  console.log("  pgvector          | 需 PG+Docker | 大规模，已有 PG 基础设施");
  console.log("\n  本项目当前用 LocalVectorStore（自研，零依赖）。");
  console.log("  Week 16 学 Docker 后可切换到 Chroma Server 或 pgvector。");

  console.log("\n=== Docker 迷你技能（记录，当前未安装） ===\n");
  console.log("  起 Chroma 容器：docker run -d -p 8000:8000 --name chroma chromadb/chroma");
  console.log("  看日志：        docker logs chroma");
  console.log("  停容器：        docker stop chroma");
  console.log("  删容器：        docker rm chroma");
  console.log("  注：当前环境未安装 Docker Desktop，以上命令仅文档化。");

  if (count2 !== docs.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
