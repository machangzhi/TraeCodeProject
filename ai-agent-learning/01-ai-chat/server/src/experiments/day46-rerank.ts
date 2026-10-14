/**
 * Day 46：Rerank —— Vector Search → Top N → Rerank → Top K
 *
 * 学习点：
 *   - 粗排（向量召回）负责"找得到"，精排（Rerank）负责"排得准"：先把召回放宽到 N，再重排取 K
 *   - Day 43/45 的病根是"正确 chunk 被噪声压在下面"（C1 gold 排全库第 5、距离 0.800 > 噪声 0.554），
 *     水平切一刀的阈值治不了纵向排序错位，Rerank 才是解药：把正确 chunk 提到前面
 *   - 本日无真实 Rerank API，按计划用 Mock 打分器（字符二元组 Dice 词重合度）占位保证链路完整，
 *     真机应换 cross-encoder（bge-reranker / Cohere / Jina），接口已按可插拔设计
 *
 * 实验设计（唯一变量 = 是否 Rerank，测试集复用 Day 43/44/45 的 7 用例）：
 *   Part A 零成本（确定性，不调 LLM）
 *     - 全库 9 chunk 对每个用例：向量排名 vs 重排后排名，看 gold 是否被"提上来"
 *     - 汇总：库内 6 用例中 gold 落在 Top3 / Top5 的数量（重排前 vs 后）
 *   Part B 真实对比（LLM）：4 档配置 × 7 用例
 *     - 无重排 K=3（Day 44 的劣势基线）/ 重排 N20→3 / 无重排 K=5 / 重排 N20→5
 *     - 记录判分、真实送入的 sources（含重排分数）、LLM 调用次数与 token 估算
 *
 * 运行：npx tsx src/experiments/day46-rerank.ts
 * 输出：docs/day46-rerank.md 的数据部分
 */
import "../env";
import { pipeline, type Tensor } from "@xenova/transformers";
import { LocalVectorStore, ingestDocuments, ragQuery } from "../rag/rag";
import { lexicalRerank, rerankOrder } from "../rag/rerank";

const RERANK_TOPN = 20; // 计划要求 Top 20；本库仅 9 chunk，实际等于全库（规模警告见报告）

interface CaseSpec {
  id: string;
  question: string;
  gold: { file: string; heading: string }[];
  goldMode: "any" | "all";
  expect: RegExp[];
  expectMode: "any" | "all";
  isControl?: boolean;
}

// 测试集：复用 Day 43/44/45 用例集
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

/** 判分：库内问题"开头即拒答"算错；control 出现拒答措辞算对（与 Day 44/45 定稿一致） */
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

/** 把分数序列转成 1-based 名次（稳定排序，同分按原序） */
function toRanks(scores: number[]): number[] {
  const ranks = new Array<number>(scores.length).fill(0);
  rerankOrder(scores).forEach((idx, i) => {
    ranks[idx] = i + 1;
  });
  return ranks;
}

async function main(): Promise<void> {
  console.log("===== Day 46：Rerank（向量 TopN → 精排 → TopK） =====\n");

  const ingest = await ingestDocuments();
  console.log(`入库：${ingest.files.join(", ")} → ${ingest.count} chunks\n`);

  const store = new LocalVectorStore();
  const nonControl = CASES.filter((c) => !c.isControl);

  // 每个用例的全库排序（含 document 正文），供 Part A 与 token 估算复用
  const allRanking = new Map<string, ReturnType<typeof store.query>>();
  for (const c of CASES) allRanking.set(c.id, store.query(await getQueryVec(c.question), 999));

  const lookupDoc = (caseId: string, file: string, heading: string): string =>
    allRanking.get(caseId)!.find((a) => a.metadata.file === file && a.metadata.heading === heading)
      ?.document ?? "";

  // ---------- Part A：gold 排名变化（零成本） ----------
  console.log("----- Part A：gold 的向量排名 vs 重排后排名（全库范围内） -----");
  console.log("| 用例 | gold chunk: 向量排名 → 重排排名（分数） | 最佳名次 向量→重排 | 向量Top1 | 重排Top1 |");
  console.log("|---|---|---|---|---|");
  let top3Before = 0;
  let top3After = 0;
  let goldTop5Before = 0;

  for (const c of CASES) {
    const all = allRanking.get(c.id)!;
    const scores = (await lexicalRerank(
      c.question,
      all.map((a) => ({ id: a.id, document: a.document })),
    )) as number[];
    const ranks = toRanks(scores);

    const goldIdx = c.gold
      .map((g) => all.findIndex((a) => a.metadata.file === g.file && a.metadata.heading === g.heading))
      .filter((i) => i >= 0);

    const detail =
      goldIdx.length === 0
        ? "（库外对照，无 gold）"
        : goldIdx
            .map(
              (gi) =>
                `${all[gi].metadata.file}#${all[gi].metadata.heading}: ${gi + 1} → ${ranks[gi]}（${scores[gi].toFixed(3)}）`,
            )
            .join("<br>");
    const bestBefore = goldIdx.length ? Math.min(...goldIdx.map((x) => x + 1)) : Infinity;
    const bestAfter = goldIdx.length ? Math.min(...goldIdx.map((x) => ranks[x])) : Infinity;

    if (goldIdx.length > 0) {
      if (bestBefore <= 3) top3Before += 1;
      if (bestAfter <= 3) top3After += 1;
      if (bestBefore <= 5) goldTop5Before += 1;
    }

    console.log(
      `| ${c.id} | ${detail} | ${bestBefore === Infinity ? "—" : `${bestBefore} → ${bestAfter}`} | ${all[0].metadata.file}#${all[0].metadata.heading} | ${all[ranks.indexOf(1)].metadata.file}#${all[ranks.indexOf(1)].metadata.heading} |`,
    );
  }

  console.log(
    `\n⇒ 库内 ${nonControl.length} 个用例：gold 落在**向量 Top3** 的 ${top3Before} 个 → 重排后 **Top3** 的 ${top3After} 个；gold 落在向量 Top5 的 ${goldTop5Before} 个\n`,
  );

  // ---------- Part B：真实对比 ----------
  console.log("----- Part B：真实对比（4 档配置 × 7 用例） -----");
  const CFGS = [
    { name: "无重排 K=3", topK: 3, rerank: false },
    { name: `重排 N${RERANK_TOPN}→3`, topK: 3, rerank: true },
    { name: "无重排 K=5", topK: 5, rerank: false },
    { name: `重排 N${RERANK_TOPN}→5`, topK: 5, rerank: true },
  ];

  const matrixRows: string[] = [];
  const summary: { name: string; ok: number; calls: number; noise: number; tokens: number }[] = [];

  for (const cfg of CFGS) {
    console.log(`\n### 配置：${cfg.name}`);
    let ok = 0;
    let calls = 0;
    let noiseSum = 0;
    let tokenSum = 0;
    const per: string[] = [];

    for (const c of CASES) {
      const r = await ragQuery(c.question, {
        topK: cfg.topK,
        rerank: cfg.rerank ? lexicalRerank : undefined,
        rerankTopN: RERANK_TOPN,
      });
      const good = judge(c, r.answer);
      if (good) ok += 1;
      if (r.matched) {
        calls += 1;
        const goldSet = new Set(c.gold.map((g) => `${g.file}#${g.heading}`));
        const ctx = r.sources
          .map((s, i) => `[${i + 1}] (来源: ${s.file} - ${s.heading}) ${lookupDoc(c.id, s.file, s.heading)}`)
          .join("\n\n");
        tokenSum += estimateTokens(ctx) + estimateTokens(c.question) + 150;
        noiseSum += r.sources.filter((s) => !goldSet.has(`${s.file}#${s.heading}`)).length;
      }
      console.log(
        `  ${c.id}: ${good ? "✅" : "❌"} sources=[${r.sources.map((s) => `${s.file}#${s.heading}${typeof s.rerankScore === "number" ? `(${s.rerankScore.toFixed(2)})` : ""}`).join(", ") || "无"}]`,
      );
      console.log(`      ${r.answer.replace(/\n/g, " ").slice(0, 120)}`);
      per.push(`${c.id}=${good ? "✅" : "❌"}`);
    }
    console.log(`  小结：${cfg.name} → 正确 ${ok}/${CASES.length}，LLM 调用 ${calls} 次，平均噪声 ${(noiseSum / CASES.length).toFixed(2)}，prompt 估算 ≈${tokenSum} tokens`);
    matrixRows.push(`| ${cfg.name} | ${per.join(" | ")} | ${ok}/${CASES.length} | ${calls} | ${(noiseSum / CASES.length).toFixed(2)} | ≈${tokenSum} |`);
    summary.push({ name: cfg.name, ok, calls, noise: noiseSum / CASES.length, tokens: tokenSum });
  }

  console.log("\n--- 报告用 Part B 矩阵 ---");
  console.log("| 配置 | C1 | C2 | C3 | C4 | C5 | C6 | C7 | 正确率 | LLM 调用 | 平均噪声 | prompt 估算 |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const row of matrixRows) console.log(row);

  console.log(`\nDay 46 真实 token 估算：合计 prompt ≈${summary.reduce((a, s) => a + s.tokens, 0)}（4 档 × 14 次有效调用，按字符估算，非精确）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
