/**
 * Day 44：TopK 实验 —— 用同一批问题量化 K 的取舍
 *
 * 学习点：
 *   - TopK 同时决定两件事：召回（K 太小漏掉正确 chunk）与信噪比（K 太大塞进无关 chunk）
 *   - 召回命中率@K 与答案正确率@K 是两个不同指标：命中不等于答对
 *   - 用数据回答"K 取几"，而不是凭感觉（为 Day 49 评测集打底）
 *
 * 实验设计（唯一变量 = TopK ∈ {1,3,5,10}，测试集与链路代码固定）：
 *   测试集复用 Day 43 的 7 个用例（6 个库内 + 1 个库外对照），gold 与期望答案不变。
 *   Part A 召回（零成本，确定性）
 *     - 每用例×K 的召回命中：正确 chunk 是否落在 Top K 内
 *     - 噪声数：召回里非 gold 的 chunk 数（信噪比）
 *     - 召回距离分布：K 越大是否拖入越多弱匹配
 *   Part B 答案正确率（真实 LLM）
 *     - 每用例×K 用真实 Top K 上下文生成回答并判分
 *     - 记录真实 usage（prompt/completion tokens），按 K 汇总成本
 *
 * 运行：npx tsx src/experiments/day44-topk-experiment.ts
 * 输出：docs/day44-topk-experiment.md 的数据部分
 */
import "../env";
import { pipeline, type Tensor } from "@xenova/transformers";
import { LocalVectorStore, ingestDocuments } from "../rag/rag";
import { chatComplete } from "../llm";

const KS = [1, 3, 5, 10];

interface CaseSpec {
  id: string;
  question: string;
  gold: { file: string; heading: string }[];
  goldMode: "any" | "all";
  expect: RegExp[];
  expectMode: "any" | "all";
  isControl?: boolean;
}

// 测试集：复用 Day 43 用例集（同一批问题贯穿所有 K，保证可比）
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

const REFUSAL = /无法回答|无法确定|没有相关|不包含|未提及|无法提供|无相关信息/;

let embedder: Awaited<ReturnType<typeof pipeline>> | null = null;
async function getQueryVec(q: string): Promise<number[]> {
  if (!embedder) embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  const out = (await embedder(q, { pooling: "mean", normalize: true } as any)) as Tensor;
  return Array.from(out.data);
}

type ChatParams = Parameters<typeof chatComplete>[0];

/** 30s 超时（chatComplete 内置）+ 最多 3 次重试，单条失败隔离 */
async function callLLM(messages: ChatParams): Promise<{ answer: string; pt: number; ct: number }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { message, usage } = await chatComplete(messages);
      return { answer: message.content || "", pt: usage.prompt_tokens, ct: usage.completion_tokens };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function buildSystem(context: string): string {
  return `你是一个基于知识库的问答助手。请严格根据下面提供的参考资料回答用户的问题。
如果参考资料中没有相关信息，请直接说"根据现有知识库无法回答该问题"，不要编造答案。
回答时请注明引用的来源编号，如 [1]。

参考资料：
${context}`;
}

/**
 * 判分器 v2：
 *   - control：出现拒答措辞即正确
 *   - 库内问题：只有「开头就是拒答」才算答错（避免把带"未提及XX"这类补充说明的正常回答误杀）
 *   - 其余按期望正则判定
 * 两轮校准记录：v1 无守卫 → C5 K=1 的拒答复述了两种实现名被判 ✅（假阳性）；
 *              v1 加"任意位置出现拒答即错" → C1 K=10 / C6 K=5 的正常回答因含补充说明被判 ❌（假阴性）。
 */
function judge(spec: CaseSpec, answer: string): { ok: boolean; refused: boolean; matched: string[] } {
  const refused = REFUSAL.test(answer);
  const refusedAtStart = REFUSAL.test(answer.slice(0, 40));
  const matched = spec.expect.filter((re) => re.test(answer)).map((re) => re.source);
  if (spec.isControl) return { ok: refused, refused, matched };
  if (refusedAtStart) return { ok: false, refused, matched };
  const ok =
    spec.expectMode === "all" ? spec.expect.every((re) => re.test(answer)) : spec.expect.some((re) => re.test(answer));
  return { ok, refused, matched };
}

async function main(): Promise<void> {
  console.log("===== Day 44：TopK 实验（K = 1 / 3 / 5 / 10） =====\n");

  const ingest = await ingestDocuments();
  console.log(`入库：${ingest.files.join(", ")} → ${ingest.count} chunks\n`);

  const store = new LocalVectorStore();
  const nonControl = CASES.filter((c) => !c.isControl);

  // 每个用例的查询向量算一次
  const qVecs = new Map<string, number[]>();
  for (const c of CASES) qVecs.set(c.id, await getQueryVec(c.question));

  interface Cell {
    hit: boolean | null; // 召回命中（control 为 null）
    noise: number | null; // 非 gold 的召回数
    avgDist: number; // 召回平均距离
    minDist: number; // 召回最近距离
    correct: boolean; // 答案正确
    answer: string;
    matched: string[];
    refused: boolean;
    pt: number;
    ct: number;
  }
  const grid = new Map<string, Map<number, Cell>>();

  console.log("----- Part A：召回（零成本） -----");
  console.log("| 用例 | K=1 命中/噪声 | K=3 命中/噪声 | K=5 命中/噪声 | K=10 命中/噪声 |");
  console.log("|---|---|---|---|---|");

  for (const c of CASES) {
    const qVec = qVecs.get(c.id)!;
    const all = store.query(qVec, 999);
    const goldIds = c.gold
      .map((g) => all.find((a) => a.metadata.file === g.file && a.metadata.heading === g.heading)?.id)
      .filter((x): x is string => Boolean(x));

    const row: string[] = [];
    const cells = new Map<number, Cell>();
    for (const K of KS) {
      const top = all.slice(0, K);
      const hitCount = goldIds.filter((id) => top.some((t) => t.id === id)).length;
      const hit = c.isControl
        ? null
        : c.goldMode === "all"
          ? hitCount === goldIds.length
          : hitCount > 0;
      const noise = c.isControl ? null : top.length - hitCount;
      const avgDist = top.reduce((s, t) => s + t.distance, 0) / top.length;
      const minDist = top[0].distance;
      cells.set(K, { hit, noise, avgDist, minDist, correct: false, answer: "", matched: [], refused: false, pt: 0, ct: 0 });
      row.push(`${hit === null ? "—" : hit ? "✅" : "❌"}/${noise === null ? "—" : noise}`);
    }
    grid.set(c.id, cells);
    console.log(`| ${c.id} | ${row.join(" | ")} |`);
  }

  console.log("\n召回明细（Top K 内的 chunk）：");
  for (const c of CASES) {
    const qVec = qVecs.get(c.id)!;
    const all = store.query(qVec, 999);
    for (const K of KS) {
      const top = all.slice(0, K);
      console.log(
        `  ${c.id} K=${K}: ${top.map((t) => `${t.metadata.file}#${t.metadata.heading}(${t.distance.toFixed(3)})`).join(", ")}`,
      );
    }
  }

  console.log("\n----- Part B：答案正确率（真实 LLM） -----");
  let totalPt = 0;
  let totalCt = 0;
  let calls = 0;

  for (const c of CASES) {
    const qVec = qVecs.get(c.id)!;
    const all = store.query(qVec, 999);
    for (const K of KS) {
      const top = all.slice(0, K);
      const context = top
        .map((r, i) => `[${i + 1}] (来源: ${r.metadata.file} - ${r.metadata.heading}) ${r.document}`)
        .join("\n\n");
      const messages = [
        { role: "system" as const, content: buildSystem(context) },
        { role: "user" as const, content: c.question },
      ] as ChatParams;
      const { answer, pt, ct } = await callLLM(messages);
      calls += 1;
      totalPt += pt;
      totalCt += ct;
      const cell = grid.get(c.id)!.get(K)!;
      const j = judge(c, answer);
      cell.correct = j.ok;
      cell.answer = answer;
      cell.matched = j.matched;
      cell.refused = j.refused;
      cell.pt = pt;
      cell.ct = ct;
      console.log(
        `  ${c.id} K=${K}: ${cell.correct ? "✅" : "❌"} (pt=${pt}, ct=${ct}, 命中=${j.matched.join("|") || "无"}, 含拒答措辞=${j.refused}) ${answer.replace(/\n/g, " ").slice(0, 70)}`,
      );
    }
  }

  // 汇总
  console.log("\n===== 汇总 =====");
  console.log("| K | 召回命中率 | 答案正确率 | 平均噪声数 | 召回平均距离 | prompt tokens | completion tokens |");
  console.log("|---|---|---|---|---|---|---|");
  const summaryRows: string[] = [];
  for (const K of KS) {
    const hitN = nonControl.filter((c) => grid.get(c.id)!.get(K)!.hit === true).length;
    const correctN = CASES.filter((c) => grid.get(c.id)!.get(K)!.correct).length;
    const noiseAvg =
      nonControl.reduce((s, c) => s + (grid.get(c.id)!.get(K)!.noise ?? 0), 0) / nonControl.length;
    const distAvg = CASES.reduce((s, c) => s + grid.get(c.id)!.get(K)!.avgDist, 0) / CASES.length;
    const pt = CASES.reduce((s, c) => s + grid.get(c.id)!.get(K)!.pt, 0);
    const ct = CASES.reduce((s, c) => s + grid.get(c.id)!.get(K)!.ct, 0);
    const line = `| ${K} | ${hitN}/${nonControl.length} | ${correctN}/${CASES.length} | ${noiseAvg.toFixed(2)} | ${distAvg.toFixed(3)} | ${pt} | ${ct} |`;
    summaryRows.push(line);
    console.log(line);
  }

  console.log(`\nLLM 调用：${calls} 次`);
  console.log(`真实 tokens：prompt ${totalPt} / completion ${totalCt}（合计 ${totalPt + totalCt}）`);

  // 给报告的对比表
  console.log("\n--- 报告用 答案正确率矩阵 ---");
  console.log("| 用例 | K=1 | K=3 | K=5 | K=10 | 召回命中(首个包含 gold 的 K) |");
  console.log("|---|---|---|---|---|---|");
  for (const c of CASES) {
    const cells = grid.get(c.id)!;
    const firstHitK = c.isControl ? "—" : (KS.find((K) => cells.get(K)!.hit) ?? "从未");
    console.log(
      `| ${c.id} | ${cells.get(1)!.correct ? "✅" : "❌"} | ${cells.get(3)!.correct ? "✅" : "❌"} | ${cells.get(5)!.correct ? "✅" : "❌"} | ${cells.get(10)!.correct ? "✅" : "❌"} | ${firstHitK} |`,
    );
  }

  console.log("\n--- 报告用 关键回答原文（完整） ---");
  for (const id of ["C1", "C5", "C6", "C7"]) {
    const cells = grid.get(id)!;
    for (const K of KS) {
      console.log(`\n[${id} K=${K}] 判分=${cells.get(K)!.correct ? "✅" : "❌"} 命中=${cells.get(K)!.matched.join("|") || "无"}`);
      console.log(cells.get(K)!.answer.replace(/\n/g, " "));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
