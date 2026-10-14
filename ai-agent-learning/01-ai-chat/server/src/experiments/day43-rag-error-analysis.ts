/**
 * Day 43：RAG 问题分析 —— 「知识库明明有答案，Agent 却答错」的逐层定位
 *
 * 学习点：
 *   - 错误案例要能稳定复现（固定知识库 + 固定问题 → 稳定错误），不能靠"感觉不对"
 *   - 把 RAG 链路拆成 4 段逐层取证：Chunk → Embedding → Retrieval → Prompt
 *   - 根因是"第一个真正失败的层"，不是"最先看到症状的那层"
 *
 * 实验设计（唯一变量 = 问题本身，知识库与链路代码固定不动）：
 *   Part A 零成本：用真实 chunkByHeadings 演示「答案被切到两个 chunk」的检测器，
 *                  并用一个同段落正例证明检测器不是"永远报警"
 *   Part B 真实运行：
 *     B0 入库（9 chunks，embedding 全命中缓存 ¥0）
 *     B1~B7 每个用例做 4 层取证：
 *       L1 Chunk     : 期望答案文本是否真的落在某个 chunk 里
 *       L2 Embedding : 正确 chunk 在全量距离排序里排第几（暴露向量模型排序偏差）
 *       L3 Retrieval : 实际 topK=3 是否召回正确 chunk
 *       L4 Prompt    : 真实 ragQuery 的回答是否正确
 *     若 L4 失败 → oracle 测试（只把正确 chunk 喂给 LLM）：
 *       能答对 → 问题在上游（Retrieval/Embedding）；答错 → 问题在 Prompt/LLM
 *
 * 运行：npx tsx src/experiments/day43-rag-error-analysis.ts
 * 输出：docs/day43-rag-error-analysis.md 的数据部分
 */
import "../env";
import { pipeline, type Tensor } from "@xenova/transformers";
import {
  LocalVectorStore,
  chunkByHeadings,
  ingestDocuments,
  ragQuery,
} from "../rag/rag";
import { chat, type ChatMessage } from "../llm";

// ============================================================
// Part A：Chunk 层检测器（零成本，真实代码）
// ============================================================

interface Section {
  heading: string;
  content: string;
  level: number;
}

/** 检测器：给定 chunk 列表与"答案必备短语"，判断答案是否被切裂到多个 chunk */
function checkSpan(
  sections: Section[],
  phrases: string[],
): { covered: boolean; singleChunk: boolean; chunks: number } {
  const covered = phrases.every((p) => sections.some((s) => s.content.includes(p)));
  const singleChunk = sections.some((s) => phrases.every((p) => s.content.includes(p)));
  const chunks = sections.filter((s) => phrases.some((p) => s.content.includes(p))).length;
  return { covered, singleChunk, chunks };
}

function runPartA(): void {
  console.log("===== Part A：Chunk 层检测器（零成本） =====");

  // A1 反例：答案被两个 H2 小节切开，任一 chunk 都答不全
  const splitDoc = [
    "# 组件规范",
    "",
    "## 命名",
    "组件文件统一使用 PascalCase 命名。",
    "",
    "## 后缀",
    "组件名必须以 View 结尾。",
    "",
  ].join("\n");
  const splitSections = chunkByHeadings(splitDoc).map((s) => ({ ...s }));
  const splitReq = ["PascalCase", "以 View 结尾"];
  const r1 = checkSpan(splitSections, splitReq);
  console.log(`A1 答案跨 2 个 chunk 的文档切出 ${splitSections.length} 段：${splitSections.map((s) => s.heading).join(" / ")}`);
  console.log(`   检测结果：库里存在=${r1.covered}，单 chunk 内完整=${r1.singleChunk}，命中 chunk 数=${r1.chunks}`);
  console.log(`   → ${r1.covered && !r1.singleChunk ? "已识别为 Chunk 层失败：答案存在但被切裂" : "检测器异常"}`);

  // A2 正例：同一 H2 小节内答全，检测器不应误报
  const wholeDoc = [
    "# 组件规范",
    "",
    "## 命名与后缀",
    "组件文件统一使用 PascalCase 命名，且组件名必须以 View 结尾。",
    "",
  ].join("\n");
  const wholeSections = chunkByHeadings(wholeDoc).map((s) => ({ ...s }));
  const r2 = checkSpan(wholeSections, splitReq);
  console.log(`A2 同段落正例切出 ${wholeSections.length} 段`);
  console.log(`   检测结果：库里存在=${r2.covered}，单 chunk 内完整=${r2.singleChunk}，命中 chunk 数=${r2.chunks}`);
  console.log(`   → ${r2.singleChunk ? "正确判定：单 chunk 内完整，不报警" : "检测器误报"}`);
  console.log("");
}

// ============================================================
// Part B：逐层定位
// ============================================================

interface CaseSpec {
  id: string;
  question: string;
  /** 正确 chunk（file + heading），control 用例为空 */
  gold: { file: string; heading: string }[];
  goldMode: "any" | "all";
  /** 答案必须命中的正则 */
  expect: RegExp[];
  expectMode: "any" | "all";
  /** 库外问题：期望拒答，不做 gold 检索 */
  isControl?: boolean;
}

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

function estimateTokens(text: string): number {
  let units = 0;
  for (const ch of text) units += ch.charCodeAt(0) > 127 ? 1 : 0.3;
  return Math.ceil(units) + 4;
}

/** 与 rag.ts 完全一致的 system 模板，用于成本估算 */
function buildSystem(context: string): string {
  return `你是一个基于知识库的问答助手。请严格根据下面提供的参考资料回答用户的问题。
如果参考资料中没有相关信息，请直接说"根据现有知识库无法回答这个问题"，不要编造答案。
回答时请注明引用的来源编号，如 [1]。

参考资料：
${context}`;
}

interface LayerResult {
  l1: boolean | null; // Chunk
  l2: number | null; // Embedding：正确 chunk 的排名（1 = 最近）
  l3: boolean | null; // Retrieval
  l4: boolean | null; // Prompt
  root: string;
  answer: string;
  retrieved: string[];
  goldRankDetail: string;
  oracle?: { ok: boolean; answer: string };
}

async function main(): Promise<void> {
  runPartA();

  console.log("===== Part B：逐层定位（真实运行） =====\n");

  const ingest = await ingestDocuments();
  console.log(`B0 入库：${ingest.files.join(", ")} → ${ingest.count} chunks\n`);

  const store = new LocalVectorStore();
  let promptTokensEst = 0;
  let completionTokensEst = 0;
  let llmCalls = 0;

  const results: { spec: CaseSpec; r: LayerResult }[] = [];

  for (const spec of CASES) {
    console.log(`----- ${spec.id}：${spec.question} -----`);

    // 真实回答（L4）
    const qVecResult = await ragQuery(spec.question, { topK: 3 });
    llmCalls += 1;
    // 用一次大 K 查询拿到全量距离排序（复用给 L1/L2/L3）
    const all = store.query(await getQueryVec(spec.question), 999);

    // L1 Chunk：期望答案文本是否落在某个 chunk 里
    let l1: boolean | null = null;
    let l2: number | null = null;
    let l3: boolean | null = null;
    let goldRankDetail = "—";
    const retrieved = qVecResult.sources.map((s) => `${s.file}#${s.heading}(${s.distance.toFixed(3)})`);

    if (!spec.isControl) {
      const goldItems = spec.gold
        .map((g) => all.find((a) => a.metadata.file === g.file && a.metadata.heading === g.heading))
        .filter((x): x is (typeof all)[number] => Boolean(x));

      // L1：期望短语是否全部出现在正确 chunk 的文档里
      const goldDocs = goldItems.map((g) => g.document).join("\n");
      l1 =
        spec.expectMode === "all"
          ? spec.expect.every((re) => re.test(goldDocs))
          : spec.expect.some((re) => re.test(goldDocs));

      // L2：正确 chunk 在全量排序里的最好排名
      const ranks = goldItems.map((g) => all.findIndex((a) => a.id === g.id) + 1).filter((r) => r > 0);
      l2 = ranks.length ? Math.min(...ranks) : null;
      const best = goldItems.sort((a, b) => a.distance - b.distance)[0];
      goldRankDetail =
        best && all[0]
          ? `gold 最近为 ${best.metadata.file}#${best.metadata.heading} 距离=${best.distance.toFixed(4)}，Top1=${all[0].metadata.file}#${all[0].metadata.heading} 距离=${all[0].distance.toFixed(4)}，差距=${(best.distance - all[0].distance).toFixed(4)}`
          : "未找到 gold";

      // L3：实际 topK=3 是否召回正确 chunk
      const topKItems = all.slice(0, 3);
      const hitCount = goldItems.filter((g) => topKItems.some((t) => t.id === g.id)).length;
      l3 = spec.goldMode === "all" ? hitCount === goldItems.length : hitCount > 0;
    }

    // L4：真实回答是否正确
    const answer = qVecResult.answer;
    const l4 = spec.isControl
      ? REFUSAL.test(answer)
      : spec.expectMode === "all"
        ? spec.expect.every((re) => re.test(answer))
        : spec.expect.some((re) => re.test(answer));

    // 成本估算
    const context = all
      .slice(0, 3)
      .map((c, i) => `[${i + 1}] (来源: ${c.metadata.file} - ${c.metadata.heading}) ${c.document}`)
      .join("\n\n");
    promptTokensEst += estimateTokens(buildSystem(context)) + estimateTokens(spec.question);
    completionTokensEst += estimateTokens(answer);

    // oracle：L4 失败时，只喂正确 chunk，看是不是 Prompt 层的问题
    let oracle: { ok: boolean; answer: string } | undefined;
    if (!l4 && !spec.isControl) {
      const goldItems = spec.gold
        .map((g) => all.find((a) => a.metadata.file === g.file && a.metadata.heading === g.heading))
        .filter((x): x is (typeof all)[number] => Boolean(x));
      const oracleContext = goldItems
        .map((g, i) => `[${i + 1}] (来源: ${g.metadata.file} - ${g.metadata.heading}) ${g.document}`)
        .join("\n\n");
      const messages: ChatMessage[] = [
        { role: "system", content: buildSystem(oracleContext) },
        { role: "user", content: spec.question },
      ];
      const oAnswer = await chat(messages);
      llmCalls += 1;
      promptTokensEst += estimateTokens(buildSystem(oracleContext)) + estimateTokens(spec.question);
      completionTokensEst += estimateTokens(oAnswer);
      const ok =
        spec.expectMode === "all"
          ? spec.expect.every((re) => re.test(oAnswer))
          : spec.expect.some((re) => re.test(oAnswer));
      oracle = { ok, answer: oAnswer };
    }

    // 根因判定：第一个真正失败的层
    let root: string;
    if (spec.isControl) {
      root = l4 ? "通过（库外问题正确拒答）" : "Prompt（库外问题未拒答）";
    } else if (!l1) {
      root = "Chunk（答案文本不在正确 chunk 内）";
    } else if (!l3) {
      root = l2 === 1 ? "Retrieval（K 截断）" : `Retrieval（诱因 Embedding 排序偏差，gold 排第 ${l2}）`;
    } else if (!l4) {
      root = oracle?.ok
        ? "Retrieval/Prompt 组合（给对上下文能答对）"
        : "Prompt（给对上下文仍答错）";
    } else {
      root = l2 === 1 ? "无（全链路通过）" : `无（最终答对，但 Embedding 排序不理想 gold 排第 ${l2}）`;
    }

    const r: LayerResult = { l1, l2, l3, l4, root, answer, retrieved, goldRankDetail, oracle };
    results.push({ spec, r });

    const mark = (b: boolean | null) => (b === null ? "—" : b ? "✅" : "❌");
    console.log(
      `  L1 Chunk=${mark(l1)}  L2 Embedding(gold排名)=${l2 ?? "—"}  L3 Retrieval=${mark(l3)}  L4 Prompt=${mark(l4)}`,
    );
    console.log(`  检索 Top3：${retrieved.join(", ") || "（拒答）"}`);
    console.log(`  根因：${root}`);
    console.log(`  回答：${answer.replace(/\n/g, " ").slice(0, 120)}`);
    if (oracle) {
      console.log(`  [oracle] 只喂 gold chunk 后能答对=${oracle.ok}：${oracle.answer.replace(/\n/g, " ").slice(0, 100)}`);
    }
    console.log("");
  }

  // 汇总
  console.log("===== 汇总 =====");
  console.log(`用例数：${results.length}`);
  for (const { spec, r } of results) {
    const mark = (b: boolean | null) => (b === null ? "—" : b ? "✅" : "❌");
    console.log(
      `${spec.id} L1=${mark(r.l1)} L2=${r.l2 ?? "—"} L3=${mark(r.l3)} L4=${mark(r.l4)} → ${r.root}`,
    );
  }
  console.log(`\nLLM 调用：${llmCalls} 次`);
  console.log(
    `token 估算：prompt ${promptTokensEst} / completion ${completionTokensEst}（按字符估算，非精确）`,
  );

  // 给报告的 Markdown 明细表
  console.log("\n--- 报告用表格 ---");
  console.log("| 用例 | 问题 | L1 Chunk | L2 gold排名 | L3 Retrieval | L4 Prompt | 根因 |");
  console.log("|---|---|---|---|---|---|---|");
  for (const { spec, r } of results) {
    const mark = (b: boolean | null) => (b === null ? "—" : b ? "✅" : "❌");
    console.log(
      `| ${spec.id} | ${spec.question} | ${mark(r.l1)} | ${r.l2 ?? "—"} | ${mark(r.l3)} | ${mark(r.l4)} | ${r.root} |`,
    );
  }
}

/** rag.ts 未导出 embed，这里用同模型同参数重算查询向量（进程内缓存 embedder，只加载一次） */
let embedder: Awaited<ReturnType<typeof pipeline>> | null = null;
async function getQueryVec(question: string): Promise<number[]> {
  if (!embedder) embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  const out = (await embedder(question, { pooling: "mean", normalize: true } as any)) as Tensor;
  return Array.from(out.data);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
