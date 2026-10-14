/**
 * Day 48（上）：Hybrid Search 最小示例 —— Keyword Search + Vector Search 的互补关系
 *
 * 学习点：
 *   - 向量检索把整段压成一个向量，擅长语义相近（复述、同义改写），但精确术语不稳定；
 *     关键词检索（BM25）只认字面重合，精确 API 名/驼峰标识符一查一个准，换个说法就全空。
 *     两者盲区正好互补 → Hybrid Search（多路召回 + 融合）。
 *   - 融合用 RRF（Reciprocal Rank Fusion）：只吃名次不吃分数，回避"BM25 分数与 cosine 距离不可比"。
 *
 * 实验设计（本日按计划只做"最小示例"，不改生产检索链路）：
 *   Part A 排名取证（零成本）：8 条探针 query × 3 种检索（Vector / Keyword / Hybrid），
 *          看各自把 gold chunk 排到第几，统计 Top1 / Top3 命中率。
 *   Part B 答案级对比（真实 LLM）：4 条探针 × 3 种检索，链路固定 K=3 + 注入防御版 Prompt，
 *          三种检索各自取自己的 Top3 上下文喂模型，判断"排名差异是否兑现为答案差异"。
 *
 * 运行：npx tsx src/experiments/day48-hybrid-search.ts
 * 输出：docs/day48-hybrid-search-and-prompt-injection.md 的数据部分
 */
import "../env";
import { pipeline, type Tensor } from "@xenova/transformers";
import { LocalVectorStore, ingestDocuments } from "../rag/rag";
import { KeywordIndex, rrfFuse } from "../rag/keyword";
import { buildRagMessages, type PromptDoc } from "../rag/prompt";
import { chatComplete } from "../llm";

const TOPK = 3;

interface Probe {
  id: string;
  query: string;
  /** 期望命中的 chunk（"file#heading"） */
  gold: string[];
  goldMode: "any" | "all";
  /** Part B 答案判分；不填视为库外对照（应拒答） */
  expect?: RegExp[];
  isControl?: boolean;
  note: string;
}

// 探针集：3 条「精确术语」（预期关键词强）+ 3 条「纯语义复述」（预期向量强）+ 2 条已有用例（C1 病根 / 库外对照）
const PROBES: Probe[] = [
  {
    id: "P1",
    query: "onMounted 是什么时候触发的？",
    gold: ["vue3.md#生命周期"],
    goldMode: "all",
    expect: [/onMounted|onBeforeMount|组合式|挂载/i],
    note: "精确 API 名（预期关键词强）",
  },
  {
    id: "P2",
    query: "beforeDestroy 在哪一步调用？",
    gold: ["vue2.md#生命周期"],
    goldMode: "all",
    expect: [/beforeDestroy|销毁|destroyed/i],
    note: "精确 API 名（预期关键词强）",
  },
  {
    id: "P3",
    query: "Object.defineProperty 有什么局限？",
    gold: ["vue2.md#响应式原理"],
    goldMode: "all",
    expect: [/新增|删除|Vue\.set|Vue\.delete|无法检测/i],
    note: "精确术语 + 字面问法（预期关键词强）",
  },
  {
    id: "P4",
    query: "数据一变界面就自己更新，底层靠什么机制？",
    gold: ["vue3.md#响应式原理"],
    goldMode: "all",
    expect: [/Proxy|响应式/i],
    note: "纯语义复述、无字面重合（预期向量强）",
  },
  {
    id: "P5",
    query: "组件从创建到销毁都经历了哪些阶段？",
    gold: ["vue2.md#生命周期", "vue3.md#生命周期"],
    goldMode: "any",
    expect: [/created|mounted|onMounted|beforeCreate/i],
    note: "纯语义复述（预期向量强）",
  },
  {
    id: "P6",
    query: "页面上的内容是怎么跟着状态变动刷新的？",
    gold: ["react.md#渲染机制"],
    goldMode: "all",
    expect: [/虚拟\s*DOM|Virtual\s*DOM|diff/i],
    note: "纯语义复述（预期向量强）",
  },
  {
    id: "P7",
    query: "响应式原理是什么？",
    gold: ["vue2.md#响应式原理", "vue3.md#响应式原理"],
    goldMode: "any",
    expect: [/Proxy|defineProperty/i],
    note: "Day 43 病根用例：短问句缺实体锚点，向量把 gold 压到全库第 5",
  },
  {
    id: "P8",
    query: "今天上海的天气怎么样？",
    gold: [],
    goldMode: "any",
    isControl: true,
    note: "库外对照：三条链路都不该检索出答案",
  },
];

const REFUSAL = /无法回答|无法确定|没有相关|不包含|未提及|无法提供|无相关信息|未检索到/;

let embedder: Awaited<ReturnType<typeof pipeline>> | null = null;
async function getQueryVec(q: string): Promise<number[]> {
  if (!embedder) embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  const out = (await embedder(q, { pooling: "mean", normalize: true } as any)) as Tensor;
  return Array.from(out.data);
}

function estimateTokens(text: string): number {
  let units = 0;
  for (const ch of text) units += ch.charCodeAt(0) > 127 ? 1 : 0.3;
  return Math.ceil(units) + 4;
}

function clip(text: string, n = 52): string {
  const one = text.replace(/\n/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

/**
 * Part B 判分：双重条件，避免"文本关键词蒙对"的假阳性（Day 48 首轮校准教训）——
 *   库内问题：gold chunk 必须进了上下文（goldHit）且答案文本命中期望关键词（textHit）；
 *   库外对照：出现拒答措辞才算对。
 */
function judgePartB(p: Probe, answer: string, keys: string[]) {
  const refused = REFUSAL.test(answer);
  if (p.isControl) return { verdict: refused, goldHit: true, textHit: refused };
  const goldHit = p.gold.some((g) => keys.includes(g));
  const textHit = !REFUSAL.test(answer.slice(0, 40)) && (p.expect ?? []).some((re) => re.test(answer));
  return { verdict: goldHit && textHit, goldHit, textHit };
}

interface Retrieved {
  id: string;
  document: string;
  key: string;
}

async function main(): Promise<void> {
  console.log("===== Day 48（上）：Hybrid Search 最小示例（Vector / Keyword / Hybrid） =====\n");

  const ingest = await ingestDocuments();
  console.log(`入库：${ingest.files.join(", ")} → ${ingest.count} chunks\n`);

  const store = new LocalVectorStore();
  // 固定顺序枚举全库（同一顺序作为三种检索的公共下标空间）
  const all: Retrieved[] = store.query(await getQueryVec("占位查询"), 999).map((r) => ({
    id: r.id,
    document: r.document,
    key: `${r.metadata.file}#${r.metadata.heading}`,
  }));
  const indexOf = new Map(all.map((d, i) => [d.id, i]));
  const kwIndex = new KeywordIndex(all.map((d) => ({ id: d.id, document: d.document })));
  console.log(`全库 ${all.length} chunk：${all.map((d) => d.key).join(" / ")}\n`);

  // ---------- Part A：三种检索的排名取证（零 LLM 调用） ----------
  console.log("----- Part A：gold 的排名（Vector / Keyword / Hybrid，全库范围） -----");
  const MODES = ["Vector", "Keyword", "Hybrid"] as const;
  const rankings = new Map<string, Record<(typeof MODES)[number], number[]>>();
  const top1Hits: Record<(typeof MODES)[number], number> = { Vector: 0, Keyword: 0, Hybrid: 0 };
  const top3Hits: Record<(typeof MODES)[number], number> = { Vector: 0, Keyword: 0, Hybrid: 0 };

  for (const p of PROBES) {
    const vecOrder = store
      .query(await getQueryVec(p.query), 999)
      .map((r) => indexOf.get(r.id)!)
      .filter((i) => i !== undefined);
    const kwOrder = kwIndex.ranking(p.query);
    const hybridOrder = rrfFuse([vecOrder, kwOrder]);
    rankings.set(p.id, { Vector: vecOrder, Keyword: kwOrder, Hybrid: hybridOrder });

    const cells: string[] = [];
    for (const mode of MODES) {
      const order = rankings.get(p.id)![mode];
      if (p.gold.length === 0) {
        cells.push(`${mode}: top1=${order.length ? all[order[0]].key : "无召回"}（对照）`);
        continue;
      }
      const positions = p.gold.map((g) => {
        const idx = all.findIndex((d) => d.key === g);
        const pos = order.indexOf(idx);
        return pos < 0 ? "未召回" : `第${pos + 1}`;
      });
      // any 口径：只看"命中的那些 gold 里最好的名次"，漏召回的一条不该把 best 拖成 -1
      const reached = p.gold
        .map((g) => order.indexOf(all.findIndex((d) => d.key === g)))
        .filter((pos) => pos >= 0);
      const best = reached.length ? Math.min(...reached) : -1;
      if (best === 0) top1Hits[mode] += 1;
      if (best >= 0 && best < TOPK) top3Hits[mode] += 1;
      cells.push(`${mode}: ${p.gold.map((g, i) => `${g} ${positions[i]}`).join(" / ")}`);
    }
    console.log(`\n[${p.id}] ${p.query}\n  说明：${p.note}`);
    for (const c of cells) console.log(`  - ${c}`);
  }

  const gradable = PROBES.filter((p) => p.gold.length > 0);
  console.log(`\n--- 报告用 Part A 汇总（库内 ${gradable.length} 条探针） ---`);
  console.log("| 检索方式 | Top1 命中 | Top3 命中 |");
  console.log("|---|---|---|");
  for (const mode of MODES) {
    console.log(`| ${mode} | ${top1Hits[mode]}/${gradable.length} | ${top3Hits[mode]}/${gradable.length} |`);
  }

  // ---------- Part B：答案级对比（真实 LLM，4 探针 × 3 检索） ----------
  if (process.env.DAY48_RANK_ONLY === "1") {
    console.log("\n（DAY48_RANK_ONLY=1：只跑零成本的 Part A 排名取证，跳过 Part B 的真实调用）");
    return;
  }
  console.log("\n----- Part B：答案级对比（链路固定 K=3 + 注入防御版 Prompt，唯一变量=检索方式） -----");
  const partB = ["P1", "P4", "P7", "P8"];
  let calls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  const matrix: string[] = [];

  for (const mode of MODES) {
    console.log(`\n### 检索方式：${mode}`);
    const per: string[] = [];
    let ok = 0;
    for (const id of partB) {
      const p = PROBES.find((x) => x.id === id)!;
      const order = rankings.get(id)![mode].slice(0, TOPK);
      const docs: PromptDoc[] = order.map((i) => ({
        file: all[i].key.split("#")[0],
        heading: all[i].key.split("#")[1],
        document: all[i].document,
      }));

      let answer: string;
      if (docs.length === 0) {
        answer = "（无召回，未调用 LLM）";
      } else {
        const messages = buildRagMessages(p.query, docs, { guard: true });
        const { message, usage } = await chatComplete(messages);
        answer = message.content ?? "";
        calls += 1;
        promptTokens += usage.prompt_tokens;
        completionTokens += usage.completion_tokens;
      }
      const keys = docs.map((d) => `${d.file}#${d.heading}`);
      const j = docs.length === 0 ? { verdict: !!p.isControl, goldHit: !!p.isControl, textHit: !!p.isControl } : judgePartB(p, answer, keys);
      if (j.verdict) ok += 1;
      console.log(
        `  ${id}: ${j.verdict ? "✅" : "❌"} 上下文=[${keys.join(", ") || "无"}] goldHit=${j.goldHit ? "✓" : "✗"} textHit=${j.textHit ? "✓" : "✗"}`,
      );
      console.log(`      ${clip(answer, 110)}`);
      per.push(`${id}=${j.verdict ? "✅" : "❌"}`);
    }
    console.log(`  小结：${mode} → ${ok}/${partB.length}`);
    matrix.push(`| ${mode} | ${per.join(" | ")} | ${ok}/${partB.length} |`);
  }

  console.log("\n--- 报告用 Part B 矩阵 ---");
  console.log("| 检索方式 | P1（术语） | P4（复述） | P7（缺锚点） | P8（库外） | 正确 |");
  console.log("|---|---|---|---|---|---|");
  for (const row of matrix) console.log(row);
  console.log(
    `\nPart B 用量：LLM 调用 ${calls} 次，精确 prompt ${promptTokens} / completion ${completionTokens} = ${promptTokens + completionTokens} tokens`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
