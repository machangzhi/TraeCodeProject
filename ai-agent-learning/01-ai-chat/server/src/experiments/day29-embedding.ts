/**
 * Day 29：Embedding
 *
 * 学习点：
 *   - 文本 → Embedding Model → 向量（浮点数数组）
 *   - 语义相近的文本向量距离通常更近（余弦相似度更高）
 *   - embedding 结果落本地缓存，同文本不重复计算
 *
 * 模型选型（Day 29 决策）：
 *   DeepSeek 当前（2026）只提供 chat 模型，无 embedding 端点。
 *   选择本地模型 Xenova/all-MiniLM-L6-v2（384 维），理由：
 *     1. 零 API 成本，符合成本纪律
 *     2. 无需额外 API Key，开箱即用
 *     3. 模型仅 ~80MB，首次下载后本地缓存
 *     4. 语义检索任务上效果足够（RAG 入门够用）
 *
 * 实验设计：
 *   1. 加载本地 embedding 模型，对 5 句文本生成向量
 *   2. 验证缓存：同一文本第二次调用不重新计算
 *   3. 预告 Day 30：计算两两余弦相似度，验证语义相近 → 向量更近
 *
 * 运行：cd server && npx tsx src/experiments/day29-embedding.ts
 * 缓存：server/data/embedding-cache.json（向量缓存）+ ~/.cache/huggingface（模型缓存）
 */
import "../env";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { pipeline, env, type Tensor } from "@xenova/transformers";

// 关闭远程模型下载进度日志的噪声
env.allowLocalModels = true as any;
env.allowRemoteModels = true as any;
// 使用国内镜像下载模型（huggingface.co 直连超时）
env.remoteHost = "https://hf-mirror.com";

const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
const CACHE_DIR = join(process.cwd(), "data");
const CACHE_FILE = join(CACHE_DIR, "embedding-cache.json");

// ---------------- 向量缓存（避免重复计算） ----------------

type Cache = Record<string, number[]>;

function loadCache(): Cache {
  if (!existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as Cache;
  } catch {
    return {};
  }
}

function saveCache(cache: Cache): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
}

// ---------------- Embedding 封装（带缓存 + 单例模型） ----------------

let embedder: Awaited<ReturnType<typeof pipeline>> | null = null;
let computeCount = 0;
let cacheHits = 0;

async function getEmbedder() {
  if (!embedder) {
    console.log(`  正在加载本地模型 ${EMBED_MODEL}（首次运行需下载约 80MB）...`);
    embedder = await pipeline("feature-extraction", EMBED_MODEL);
    console.log(`  模型加载完成\n`);
  }
  return embedder;
}

async function embed(text: string): Promise<number[]> {
  const cache = loadCache();
  if (text in cache) {
    cacheHits++;
    return cache[text];
  }
  computeCount++;
  const extractor = await getEmbedder();
  // feature-extraction 返回 Tensor [1, seq_len, dim]，mean pooling 后为 [dim]
  const output = (await extractor(text, { pooling: "mean", normalize: true } as any)) as Tensor;
  // output.data 是 Float32Array
  const vec = Array.from(output.data);
  cache[text] = vec;
  saveCache(cache);
  return vec;
}

// ---------------- 工具函数 ----------------

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("向量维度不一致");
  let dot = 0;
  let normA = 0;
  let normB = 0;
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
  console.log(`Embedding 模型：${EMBED_MODEL}（本地）`);
  console.log(`向量缓存：${CACHE_FILE}\n`);

  // 5 句文本：含两组语义相近的句子，用于验证"语义相近 → 向量更近"
  const texts = [
    "Vue2 组件开发使用 Options API",
    "Vue3 组件开发推荐使用 Composition API",
    "React 组件开发使用 Hooks",
    "今天北京天气晴朗，气温 22 度",
    "上海今天多云，最高气温 24 度",
  ];

  console.log("=== 第一步：生成 5 句文本的向量 ===\n");
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    const v = await embed(t);
    vectors.push(v);
    const preview = v.slice(0, 5).map((x) => x.toFixed(4)).join(", ");
    console.log(`  [${i + 1}] 维度=${v.length} 前5维=[${preview}, ...]`);
    console.log(`      "${t}"`);
  }

  console.log(`\n=== 第二步：验证缓存（同文本不重复计算） ===\n`);
  const beforeCompute = computeCount;
  const beforeHits = cacheHits;
  // 再次嵌入同样的 5 句，应全部命中缓存
  for (const t of texts) await embed(t);
  console.log(`  首轮：计算 ${beforeCompute} 次，缓存命中 ${beforeHits} 次`);
  console.log(`  次轮：计算 ${computeCount - beforeCompute} 次，缓存命中 ${cacheHits - beforeHits} 次`);
  console.log(`  ✅ ${cacheHits - beforeHits === texts.length ? "全部命中缓存，零重复计算" : "❌ 缓存未生效"}`);

  console.log(`\n=== 第三步：语义相近性预验证（为 Day 30 铺路） ===\n`);
  console.log("  两两余弦相似度矩阵（已 L2 归一化，余弦 = 点积）：\n");
  const header = "        " + texts.map((_, i) => `   #${i + 1}   `).join("");
  console.log(header);
  for (let i = 0; i < texts.length; i++) {
    const row = [`  #${i + 1}  `];
    for (let j = 0; j < texts.length; j++) {
      const sim = cosineSimilarity(vectors[i], vectors[j]);
      row.push(sim.toFixed(4).padStart(8));
    }
    console.log(row.join(" "));
  }

  const vueVue = cosineSimilarity(vectors[0], vectors[1]);
  const vueReact = cosineSimilarity(vectors[0], vectors[2]);
  const weatherWeather = cosineSimilarity(vectors[3], vectors[4]);
  const vueWeather = cosineSimilarity(vectors[0], vectors[3]);

  console.log(`\n  核心假设验证：`);
  console.log(`    Vue2 vs Vue3      = ${vueVue.toFixed(4)}（同框架不同版本）`);
  console.log(`    Vue2 vs React     = ${vueReact.toFixed(4)}（不同框架）`);
  console.log(`    北京 vs 上海       = ${weatherWeather.toFixed(4)}（同主题天气）`);
  console.log(`    Vue2 vs 北京天气   = ${vueWeather.toFixed(4)}（跨主题）`);
  console.log(`  预期：Vue2-Vue3 > Vue2-React，北京-上海 > Vue2-天气`);

  const ok = vueVue > vueReact && weatherWeather > vueWeather;
  console.log(`  ${ok ? "✅ 语义相近的文本向量确实更近" : "⚠️  结果不完全符合预期，需检查"}`);

  console.log(`\n=== 成本统计 ===\n`);
  const totalChars = texts.reduce((s, t) => s + t.length, 0);
  console.log(`  模型计算次数：${computeCount}`);
  console.log(`  缓存命中次数：${cacheHits}`);
  console.log(`  总字符数：${totalChars}`);
  console.log(`  向量维度：${vectors[0].length}`);
  console.log(`  API 花费：¥0（本地模型，零 API 成本）`);
  console.log(`  缓存文件已保存至 data/embedding-cache.json`);

  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
