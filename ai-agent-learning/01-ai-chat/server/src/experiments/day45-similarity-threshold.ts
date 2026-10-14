/**
 * Day 45：Similarity Threshold —— 用阈值拦住"无关内容"
 *
 * 学习点：
 *   - TopK 决定"最多取几条"，Threshold 决定"够不够格留下"；两者是正交的两道闸
 *   - 阈值过滤后若一条都不剩，应直接短路拒答（不调 LLM）——省成本且不拿无关上下文硬凑
 *   - 阈值是召回/精度的取舍旋钮：太松拦不住噪声，太紧会拦掉"弱匹配但有答案"的内容
 *
 * 实验设计（唯一变量 = threshold，测试集与 topK 固定为 Day 44 的甜点 K=5）：
 *   测试集复用 Day 43/44 的 7 个用例（6 库内 + 1 库外对照）。
 *   Part A 阈值扫描（零成本，确定性）
 *     - 对 T ∈ {0.40 … 0.80} 逐档计算：保住 gold 的用例数、平均保留 chunk 数、库外用例是否被拦
 *     - 距离分布对照表：gold 最近距离 vs 最近非 gold 距离（暴露两者是否重叠）
 *   Part B 真实对比（LLM）
 *     - 两档配置：无阈值 vs threshold=0.7，同 topK=5，逐用例判分
 *     - 记录 matched / 短路次数（省下的 LLM 调用）、回答原文、token 估算
 *
 * 运行：npx tsx src/experiments/day45-similarity-threshold.ts
 * 输出：docs/day45-similarity-threshold.md 的数据部分
 */
import "../env";
import { pipeline, type Tensor } from "@xenova/transformers";
import { LocalVectorStore, ingestDocuments, ragQuery } from "../rag/rag";

const TOPK = 5;
const TS = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];

interface CaseSpec {
  id: string;
  question: string;
  gold: { file: string; heading: string }[];
  goldMode: "any" | "all";
  expect: RegExp[];
  expectMode: "any" | "all";
  isControl?: boolean;
}

// 测试集：复用 Day 43/44 用例集
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

/** 判分：库内问题"开头即拒答"算错；control 出现拒答措辞算对（与 Day 44 定稿一致） */
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

async function main(): Promise<void> {
  console.log("===== Day 45：Similarity Threshold（topK 固定为 5） =====\n");

  const ingest = await ingestDocuments();
  console.log(`入库：${ingest.files.join(", ")} → ${ingest.count} chunks\n`);

  const store = new LocalVectorStore();
  const nonControl = CASES.filter((c) => !c.isControl);

  // ---------- 距离分布对照 ----------
  const allRanking = new Map<string, ReturnType<typeof store.query>>();
  for (const c of CASES) allRanking.set(c.id, store.query(await getQueryVec(c.question), 999));

  console.log("----- Part A-1：距离分布（gold vs 非 gold） -----");
  console.log("| 用例 | gold 最近距离 | 最近非 gold 距离 | 谁更近 |");
  console.log("|---|---|---|---|");
  let overlap = 0;
  for (const c of CASES) {
    const all = allRanking.get(c.id)!;
    const goldIds = c.gold
      .map((g) => all.find((a) => a.metadata.file === g.file && a.metadata.heading === g.heading)?.id)
      .filter((x): x is string => Boolean(x));
    const gold = all.filter((a) => goldIds.includes(a.id));
    const noise = all.filter((a) => !goldIds.includes(a.id) && a.metadata.file);
    const goldMin = gold.length ? Math.min(...gold.map((g) => g.distance)) : Infinity;
    const noiseMin = noise.length ? Math.min(...noise.map((n) => n.distance)) : Infinity;
    const goldCloser = goldMin < noiseMin;
    if (!goldCloser && c.gold.length > 0) overlap += 1;
    console.log(
      `| ${c.id} | ${gold.length ? goldMin.toFixed(3) : "—"} | ${noiseMin === Infinity ? "—" : noiseMin.toFixed(3)} | ${c.gold.length === 0 ? "（库外）" : goldCloser ? "gold 更近" : "**gold 更远**"} |`,
    );
  }
  console.log(`\n⇒ gold 比最近非 gold 更远的用例数：${overlap}（这些用例无论阈值取多少都无法"只留 gold 不留噪声"）\n`);

  // ---------- 阈值扫描 ----------
  console.log("----- Part A-2：阈值扫描（topK=5 基础上再按 T 过滤） -----");
  console.log("| T | 保住 gold 的用例 | 平均保留 chunk 数 | 平均噪声数 | C7 库外是否被拦 |");
  console.log("|---|---|---|---|---|");
  for (const T of TS) {
    let goldKept = 0;
    let keptTotal = 0;
    let noiseTotal = 0;
    for (const c of nonControl) {
      const all = allRanking.get(c.id)!;
      const top = all.slice(0, TOPK);
      const kept = top.filter((t) => t.distance <= T);
      const goldIds = c.gold
        .map((g) => all.find((a) => a.metadata.file === g.file && a.metadata.heading === g.heading)?.id)
        .filter((x): x is string => Boolean(x));
      const goldInKept = goldIds.filter((id) => kept.some((k) => k.id === id)).length;
      const allGoldKept = c.goldMode === "all" ? goldInKept === goldIds.length : goldInKept > 0;
      if (allGoldKept) goldKept += 1;
      keptTotal += kept.length;
      noiseTotal += kept.length - goldInKept;
    }
    const c7all = allRanking.get("C7")!;
    const c7min = c7all.slice(0, TOPK)[0].distance;
    const c7Blocked = c7min > T;
    console.log(
      `| ${T.toFixed(2)} | ${goldKept}/${nonControl.length} | ${(keptTotal / nonControl.length).toFixed(2)} | ${(noiseTotal / nonControl.length).toFixed(2)} | ${c7Blocked ? "✅ 拦截（零成本拒答）" : "❌ 仍会调 LLM"} |`,
    );
  }

  // ---------- Part B：真实对比 ----------
  console.log("\n----- Part B：真实对比（无阈值 vs threshold=0.7） -----");
  const configs: { name: string; threshold?: number }[] = [
    { name: "无阈值", threshold: undefined },
    { name: "threshold=0.7", threshold: 0.7 },
  ];
  let totalPtEst = 0;
  let totalCtEst = 0;
  const l4Matrix: string[] = [];

  for (const cfg of configs) {
    console.log(`\n### 配置：${cfg.name}`);
    let ok = 0;
    let calls = 0;
    const per: string[] = [];
    for (const c of CASES) {
      const r = await ragQuery(c.question, { topK: TOPK, threshold: cfg.threshold });
      if (r.matched) {
        calls += 1;
        const context = r.sources
          .map((s, i) => `[${i + 1}] (来源: ${s.file} - ${s.heading})`)
          .join("\n\n");
        totalPtEst += estimateTokens(context) + estimateTokens(c.question) + 120;
        totalCtEst += estimateTokens(r.answer);
      }
      const good = judge(c, r.answer);
      if (good) ok += 1;
      const tag = r.matched ? "" : "（短路·未调 LLM）";
      console.log(
        `  ${c.id}: ${good ? "✅" : "❌"} matched=${r.matched}${tag} sources=[${r.sources.map((s) => `${s.file}#${s.heading}`).join(", ") || "无"}]`,
      );
      console.log(`      ${r.answer.replace(/\n/g, " ").slice(0, 110)}`);
      per.push(`${c.id}=${good ? "✅" : "❌"}`);
    }
    console.log(`  小结：${cfg.name} → 答案正确 ${ok}/${CASES.length}，实际 LLM 调用 ${calls} 次`);
    l4Matrix.push(`| ${cfg.name} | ${per.join(" | ")} | ${ok}/${CASES.length} | ${calls} |`);
  }

  console.log("\n--- 报告用 Part B 矩阵 ---");
  console.log("| 配置 | C1 | C2 | C3 | C4 | C5 | C6 | C7 | 正确率 | LLM 调用 |");
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  for (const row of l4Matrix) console.log(row);

  console.log(`\nDay 45 真实 token 估算：prompt ≈${totalPtEst} / completion ≈${totalCtEst}（按字符估算，非精确）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
