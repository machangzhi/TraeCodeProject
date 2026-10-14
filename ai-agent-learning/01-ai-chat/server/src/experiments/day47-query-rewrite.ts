/**
 * Day 47：Query Rewrite —— 用户原始问题 → LLM改写 → Search Query
 *
 * 学习点：
 *   - 检索前先"把问题变成检索式"：补全省略的实体/技术名词、展开缩写、删寒暄
 *   - 动机来自 Day 43 根因——本地英文 embedding 对"缺实体锚点"的中文短问句排序崩塌：
 *     「响应式原理是什么？」缺 Vue/Vue2/Vue3/defineProperty/Proxy 锚点词，gold 被压到全库第 5
 *   - 改写只作用于检索（Embedding / Rerank 用 searchQuery），回答仍用用户原始问题，
 *     避免改写丢失用户意图（C5 那种长铺垫问题尤其要注意）
 *
 * 实验设计（唯一变量 = 检索用查询是否经过 LLM 改写，测试集复用 Day 43~46 的 7 用例）：
 *   Part 0 改写（真实 LLM）：逐用例 口语问题 → LLM → 检索式，记录改写前后文本与 token 用量
 *   Part A 零成本取证（确定性）：原始查询 vs 改写查询各自的 embedding，全库 9 chunk 排名，
 *          看 gold 的向量排名是否被"提上来"（Day 43 的病根是否被治）
 *   Part B 真实对比（LLM）：2 档配置 × 7 用例，链路固定为 K=3 + Rerank（Day 46 现状基线）
 *          - 不改写（原问题）
 *          - 改写后检索式
 *          记录判分、实际 sources、噪声数与 token 估算
 *
 * 运行：npx tsx src/experiments/day47-query-rewrite.ts
 * 输出：docs/day47-query-rewrite.md 的数据部分
 */
import "../env";
import { pipeline, type Tensor } from "@xenova/transformers";
import { LocalVectorStore, ingestDocuments, ragQuery } from "../rag/rag";
import { lexicalRerank } from "../rag/rerank";
import { rewriteQuery, type RewriteResult } from "../rag/rewrite";

const RERANK_TOPN = 20; // 与 Day 46 一致；本库仅 9 chunk，实际等于全库（规模警告见报告）

interface CaseSpec {
  id: string;
  question: string;
  gold: { file: string; heading: string }[];
  goldMode: "any" | "all";
  expect: RegExp[];
  expectMode: "any" | "all";
  isControl?: boolean;
}

// 测试集：复用 Day 43/44/45/46 用例集
const CASES: CaseSpec[] = [
  {
    id: "C1",
    question: "响应式原理是什么？",
    gold: [
      { file: "vue2.md", heading: "响应式原理" },
      { file: "vue3.md", heading: "响应式原理" },
    ],
    goldMode: "any",
    expect: [/Proxy/i, /defineProperty/i],
    expectMode: "any",
  },
  {
    id: "C2",
    question: "Vue3 的响应式系统是基于什么实现的？",
    gold: [{ file: "vue3.md", heading: "响应式原理" }],
    goldMode: "all",
    expect: [/Proxy/i],
    expectMode: "all",
  },
  {
    id: "C3",
    question: "Vue2 和 Vue3 的响应式原理有什么区别？",
    gold: [
      { file: "vue2.md", heading: "响应式原理" },
      { file: "vue3.md", heading: "响应式原理" },
    ],
    goldMode: "all",
    expect: [/defineProperty/i, /Proxy/i],
    expectMode: "all",
  },
  {
    id: "C4",
    question: "React 是怎么把状态变化反映到页面上的？",
    gold: [{ file: "react.md", heading: "渲染机制" }],
    goldMode: "all",
    expect: [/(虚拟\s*DOM|Virtual\s*DOM|diff)/i],
    expectMode: "all",
  },
  {
    id: "C5",
    question:
      "我们团队准备把一个老项目从 Vue2 升级到 Vue3，担心响应式这块有兼容问题，想先了解 Vue3 的响应式底层实现和 Vue2 有什么本质不同，能详细说说吗？",
    gold: [
      { file: "vue2.md", heading: "响应式原理" },
      { file: "vue3.md", heading: "响应式原理" },
    ],
    goldMode: "all",
    expect: [/defineProperty/i, /Proxy/i],
    expectMode: "all",
  },
  {
    id: "C6",
    question: "Vue 组件的生命周期钩子有哪些？",
    gold: [
      { file: "vue2.md", heading: "生命周期" },
      { file: "vue3.md", heading: "生命周期" },
    ],
    goldMode: "any",
    expect: [/mounted|created|onMounted|beforeCreate/i],
    expectMode: "any",
  },
  {
    id: "C7",
    question: "今天上海的天气怎么样？",
    gold: [],
    goldMode: "any",
    expect: [],
    expectMode: "any",
    isControl: true,
  },
];

const REFUSAL = /无法回答|无法确定|没有相关|不包含|未提及|无法提供|无相关信息|未检索到/;

let embedder: Awaited<ReturnType<typeof pipeline>> | null = null;
async function getQueryVec(q: string): Promise<number[]> {
  if (!embedder) embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  const out = (await embedder(q, { pooling: "mean", normalize: true } as any)) as Tensor;
  return Array.from(out.data);
}

/** 判分：库内问题"开头即拒答"算错；control 出现拒答措辞算对（与 Day 44/45/46 定稿一致） */
function judge(spec: CaseSpec, answer: string): boolean {
  const refused = REFUSAL.test(answer);
  if (spec.isControl) return refused;
  if (REFUSAL.test(answer.slice(0, 40))) return false;
  return spec.expectMode === "all"
    ? spec.expect.every((re) => re.test(answer))
    : spec.expect.some((re) => re.test(answer));
}

function estimateTokens(text: string): number {
  let units = 0;
  for (const ch of text) units += ch.charCodeAt(0) > 127 ? 1 : 0.3;
  return Math.ceil(units) + 4;
}

function clip(text: string, n = 44): string {
  const one = text.replace(/\n/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

async function main(): Promise<void> {
  console.log("===== Day 47：Query Rewrite（原始问题 → LLM 改写 → 检索式） =====\n");

  const ingest = await ingestDocuments();
  console.log(`入库：${ingest.files.join(", ")} → ${ingest.count} chunks\n`);

  const store = new LocalVectorStore();
  const nonControl = CASES.filter((c) => !c.isControl);

  // 全库 chunk 正文索引（同一 file#heading 的正文与查询无关，建一次即可）
  const docByKey = new Map<string, string>();
  for (const item of store.query(await getQueryVec("占位查询"), 999)) {
    docByKey.set(`${item.metadata.file}#${item.metadata.heading}`, item.document);
  }

  // ---------- Part 0：LLM 改写（真实调用） ----------
  console.log("----- Part 0：LLM 改写（口语问题 → 检索式） -----");
  console.log("| 用例 | 原始问题 | 改写后检索式 | 结果 |");
  console.log("|---|---|---|---|");
  const rewrites = new Map<string, RewriteResult>();
  let rwSuccess = 0;
  let rwPromptTokens = 0;
  let rwCompletionTokens = 0;
  let rwEstimate = 0;

  for (const c of CASES) {
    const r = await rewriteQuery(c.question);
    rewrites.set(c.id, r);
    if (r.rewritten) rwSuccess += 1;
    if (r.usage) {
      rwPromptTokens += r.usage.prompt_tokens;
      rwCompletionTokens += r.usage.completion_tokens;
    }
    rwEstimate += estimateTokens(c.question) + estimateTokens(r.searchQuery) + 260; // 260≈system 提示词开销
    console.log(
      `| ${c.id} | ${clip(c.question, 34)} | ${r.searchQuery} | ${r.rewritten ? "✅ 改写" : "❌ 回退原问题"} |`,
    );
  }
  console.log(
    `\n⇒ 改写调用 ${CASES.length} 次，成功 ${rwSuccess}/${CASES.length}；` +
      `usage（成功那次）：prompt ${rwPromptTokens} / completion ${rwCompletionTokens}\n`,
  );

  // 报告取数辅助：只跑改写段（避免为拿全量改写文本重跑 Part B 的付费调用）
  if (process.env.DAY47_PART0_ONLY === "1") return;

  // ---------- Part A：gold 向量排名变化（零成本） ----------
  console.log("----- Part A：gold 的向量排名（原始查询 vs 改写查询，全库范围内） -----");
  console.log("| 用例 | gold chunk: 原查询排名 → 改写后排名 | 最佳名次 原始→改写 |");
  console.log("|---|---|---|");
  let top3Before = 0;
  let top3After = 0;
  let top5Before = 0;
  let top5After = 0;

  for (const c of CASES) {
    const r = rewrites.get(c.id)!;
    const allBefore = store.query(await getQueryVec(c.question), 999);
    const allAfter = store.query(await getQueryVec(r.searchQuery), 999);

    if (c.gold.length === 0) {
      console.log(`| ${c.id} | （库外对照，无 gold） | — |`);
      continue;
    }

    const pairs = c.gold.map((g) => {
      const ib = allBefore.findIndex((a) => a.metadata.file === g.file && a.metadata.heading === g.heading);
      const ia = allAfter.findIndex((a) => a.metadata.file === g.file && a.metadata.heading === g.heading);
      return { g, before: ib + 1, after: ia + 1 };
    });

    const bestBefore = Math.min(...pairs.map((p) => p.before));
    const bestAfter = Math.min(...pairs.map((p) => p.after));

    if (bestBefore <= 3) top3Before += 1;
    if (bestAfter <= 3) top3After += 1;
    if (bestBefore <= 5) top5Before += 1;
    if (bestAfter <= 5) top5After += 1;

    console.log(
      `| ${c.id} | ${pairs.map((p) => `${p.g.file}#${p.g.heading}: ${p.before} → ${p.after}`).join("<br>")} | ${bestBefore} → ${bestAfter} |`,
    );
  }

  console.log(
    `\n⇒ 库内 ${nonControl.length} 个用例：gold 落在**向量 Top3** 的 ${top3Before} 个 → 改写后 ${top3After} 个；` +
      `落在 Top5 的 ${top5Before} 个 → ${top5After} 个\n`,
  );

  // ---------- Part B：真实对比 ----------
  console.log("----- Part B：真实对比（2 档配置 × 7 用例，K=3 + Rerank N20） -----");
  const CFGS = [
    { name: "不改写（原问题）", useRewrite: false },
    { name: "改写后检索式", useRewrite: true },
  ];

  const matrixRows: string[] = [];
  let answerTokens = 0;

  for (const cfg of CFGS) {
    console.log(`\n### 配置：${cfg.name}`);
    let ok = 0;
    let calls = 0;
    let noiseSum = 0;
    const per: string[] = [];

    for (const c of CASES) {
      const searchQuery = cfg.useRewrite ? rewrites.get(c.id)!.searchQuery : undefined;
      const r = await ragQuery(c.question, {
        topK: 3,
        rerank: lexicalRerank,
        rerankTopN: RERANK_TOPN,
        searchQuery,
      });
      const good = judge(c, r.answer);
      if (good) ok += 1;
      if (r.matched) {
        calls += 1;
        const goldSet = new Set(c.gold.map((g) => `${g.file}#${g.heading}`));
        const ctx = r.sources
          .map((s, i) => `[${i + 1}] (来源: ${s.file} - ${s.heading}) ${docByKey.get(`${s.file}#${s.heading}`) ?? ""}`)
          .join("\n\n");
        answerTokens += estimateTokens(ctx) + estimateTokens(c.question) + 150;
        noiseSum += r.sources.filter((s) => !goldSet.has(`${s.file}#${s.heading}`)).length;
      }
      console.log(
        `  ${c.id}: ${good ? "✅" : "❌"} sources=[${r.sources.map((s) => `${s.file}#${s.heading}${typeof s.rerankScore === "number" ? `(${s.rerankScore.toFixed(2)})` : ""}`).join(", ") || "无"}]`,
      );
      console.log(`      ${r.answer.replace(/\n/g, " ").slice(0, 120)}`);
      per.push(`${c.id}=${good ? "✅" : "❌"}`);
    }
    console.log(`  小结：${cfg.name} → 正确 ${ok}/${CASES.length}，LLM 调用 ${calls} 次，平均噪声 ${(noiseSum / CASES.length).toFixed(2)}`);
    matrixRows.push(`| ${cfg.name} | ${per.join(" | ")} | ${ok}/${CASES.length} | ${calls} | ${(noiseSum / CASES.length).toFixed(2)} |`);
  }

  console.log("\n--- 报告用 Part B 矩阵 ---");
  console.log("| 配置 | C1 | C2 | C3 | C4 | C5 | C6 | C7 | 正确率 | LLM 调用 | 平均噪声 |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const row of matrixRows) console.log(row);

  console.log(
    `\nDay 47 token 估算：改写（精确 usage ${rwPromptTokens + rwCompletionTokens}，含 system 折算 ≈${rwEstimate}）` +
      ` + Part B 回答（字符估算 ≈${answerTokens}）；合计按字符口径 ≈${rwEstimate + answerTokens} tokens`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
