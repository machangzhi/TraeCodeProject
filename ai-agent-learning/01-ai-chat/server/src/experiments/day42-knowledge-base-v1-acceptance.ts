/**
 * Day 42：第 6 周验收 —— 企业知识库 V1 全链路
 *
 * 学习点：把 Day 36-41 的链路（解析 → 结构化切分 → Metadata → 入库 → 过滤检索 → LLM 生成 → 来源）
 *        当成一个产品做验收，而不是逐个模块自测。
 *
 * 实验设计：
 *   Part A 确定性断言（零成本，不调 LLM、不算 embedding）
 *     A1 Markdown 解析保留代码区 `*`（Day 32 的 Bug 回归）
 *     A2 按标题结构化切分（H1 无正文不产出、H2 各自成段）
 *     A3 LocalVectorStore 先过滤后排序 + 持久化重载
 *     A4 上传文件名消毒（路径穿越）
 *   Part B 真实链路（少量 LLM 调用）
 *     B1 入库  B2 知识库列表  B3 库内问答  B4 分类过滤问答  B5 库外问题拒答
 *
 * 运行：npx tsx src/experiments/day42-knowledge-base-v1-acceptance.ts
 */
import "../env";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import {
  LocalVectorStore,
  chunkByHeadings,
  ingestDocuments,
  listDocuments,
  parseMarkdown,
  ragQuery,
  sanitizeFilename,
  type ChunkMetadata,
} from "../rag/rag";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass += 1;
    console.log(`✅ ${name}${detail ? " — " + detail : ""}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}${detail ? " — " + detail : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n----- ${title} -----`);
}

// ============ Part A：确定性断言（零成本） ============
section("Part A 确定性断言");

// A1：代码块里的 `*` 必须原样保留（Day 32 全局去 `*` 的回归测试）
{
  const md = "# 计算\n\n```js\nconst n = count * 2\n```\n\n**粗体**说明文字";
  const parsed = parseMarkdown(md);
  check("A1 代码区 `*` 保留", parsed.includes("count * 2"), `实际 ${JSON.stringify(parsed)}`);
  check("A1' 正文粗体标记被去掉", !parsed.includes("**"));
}

// A2：按 H1/H2 结构化切分
{
  const md = "# 文档标题\n\n## 命名规范\n组件用 PascalCase\n\n## 代码评审\nPR 需一人 approve\n";
  const sections = chunkByHeadings(md);
  check("A2 切出 2 段（H1 无正文不产出）", sections.length === 2, `实际 ${sections.length}`);
  check(
    "A2' 标题与层级正确",
    sections[0]?.heading === "命名规范" && sections[0]?.level === 2 && sections[1]?.heading === "代码评审",
    sections.map((s) => `H${s.level}:${s.heading}`).join(" | "),
  );
}

// A3：向量库「先过滤再排序」+ JSON 持久化重载
const tmpStore = join(process.cwd(), "data", "tmp-day42-store.json");
{
  if (existsSync(tmpStore)) unlinkSync(tmpStore);
  const mk = (id: string, category: string, embedding: number[]) => ({
    id,
    document: `doc-${id}`,
    embedding,
    metadata: { file: `${id}.md`, heading: "h", level: 2, category, tags: [] } as ChunkMetadata,
  });
  const store = new LocalVectorStore(tmpStore);
  // a 与查询向量完全同向，b 次之，c 正交
  store.add([mk("a", "vue", [1, 0, 0]), mk("b", "react", [0.9, 0.1, 0]), mk("c", "vue", [0, 1, 0])]);

  const all = store.query([1, 0, 0], 3);
  check("A3 无过滤返回 3 条且最近的是 a", all.length === 3 && all[0].id === "a", `Top1=${all[0]?.id}`);

  const onlyVue = store.query([1, 0, 0], 3, { category: "vue" });
  check(
    "A3' category=vue 只返回 vue 且仍按距离排序",
    onlyVue.length === 2 && onlyVue.every((r) => r.metadata.category === "vue") && onlyVue[0].id === "a",
    onlyVue.map((r) => `${r.id}(${r.distance.toFixed(2)})`).join(", "),
  );

  check("A3'' 持久化后重载条目一致", new LocalVectorStore(tmpStore).count() === 3);
  unlinkSync(tmpStore);
}

// A4：上传文件名消毒
{
  check(
    "A4 路径穿越被消毒",
    sanitizeFilename("../../hack.md") === "hack.md",
    `实际 ${sanitizeFilename("../../hack.md")}`,
  );
  check("A4' 中文文件名保留", sanitizeFilename("团队前端规范.md") === "团队前端规范.md");
  check("A4'' 空文件名兜底不抛错", /^upload-\d+\.md$/.test(sanitizeFilename("")));
}

// ============ Part B：真实链路 ============
section("Part B 真实链路（含 LLM 调用）");

const ingest = await ingestDocuments();
check(
  "B1 入库 3 文档 / 9 chunks",
  ingest.count === 9 && ingest.files.length === 3,
  `${ingest.files.join(", ")} → ${ingest.count} chunks`,
);

const docs = listDocuments();
check(
  "B2 知识库列表按文件聚合 3 文件 × 3 chunks",
  docs.length === 3 && docs.every((d) => d.chunkCount === 3),
  docs.map((d) => `${d.file}(${d.chunkCount})`).join(", "),
);
check(
  "B2' 分类推断正确",
  docs.find((d) => d.file === "vue3.md")?.category === "vue" &&
    docs.find((d) => d.file === "react.md")?.category === "react",
);

const q1 = await ragQuery("Vue3 的响应式原理是什么？", { topK: 3 });
check(
  "B3 库内问题给出答案",
  q1.answer.length > 20 && !/无法回答/.test(q1.answer),
  q1.sources.map((s) => `${s.file}#${s.heading}(${s.distance.toFixed(3)})`).join(", "),
);
check(
  "B3' 来源全部来自知识库文件",
  q1.sources.length > 0 && q1.sources.every((s) => ["vue2.md", "vue3.md", "react.md"].includes(s.file)),
);

const q2 = await ragQuery("组件之间怎么传递数据？", { topK: 3, filter: { category: "vue" } });
check(
  "B4 category=vue 过滤后来源全为 vue 文档",
  q2.sources.length > 0 && q2.sources.every((s) => s.file.startsWith("vue")),
  q2.sources.map((s) => s.file).join(", "),
);

const q3 = await ragQuery("今天上海的天气怎么样？", { topK: 3 });
check(
  "B5 知识库外问题拒答（无幻觉）",
  /无法|不能|没有|不包含|超出|未提及/.test(q3.answer),
  `回答开头：${q3.answer.slice(0, 60).replace(/\n/g, " ")}`,
);

// ============ 汇总 ============
console.log(`\n=== Day 42 企业知识库 V1 验收：${pass}/${pass + fail} 通过（失败 ${fail}）===`);
if (fail > 0) process.exitCode = 1;
