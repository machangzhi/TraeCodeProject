/**
 * Day 9：Few Shot —— 文本分类 Agent 实验
 *
 * 学习点：
 * - Zero Shot：只给指令（Instruction），不给例子
 * - Few Shot：给指令 + 少量 Example，让模型从例子中学习"格式"和"判定边界"
 * - Example 的选择有讲究：基础示例教会格式，边界示例（反讽/转折）教会判定规则
 *
 * 实验设计：
 * - 任务：电商评论情感三分类（positive / negative / neutral），输出 JSON
 * - 10 条测试评论，其中包含反讽、转折、隐含情感等边界 case
 * - 3 种策略共用同一条 system 指令，唯一变量是"给不给示例、给什么示例"
 * - temperature = 0，保证分类任务可复现
 *
 * 运行：npx tsx src/experiments/day9-few-shot.ts
 * 输出：01-ai-chat/docs/day9-few-shot-classification.md
 */
import "../env";
import OpenAI from "openai";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL,
});

type Label = "positive" | "negative" | "neutral";

// 三种策略共用同一条指令，保证唯一变量是 example
const SYSTEM_PROMPT = `你是一个电商评论情感分类器。
把用户给出的评论分为三类之一：positive（正面）、negative（负面）、neutral（中性/无情感倾向）。
只输出一个 JSON 对象，格式为 {"sentiment": "positive | negative | neutral"}，不要输出任何其他内容。`;

interface Example {
  text: string;
  label: Label;
  note?: string; // 该示例想教模型什么
}

// 基础示例：只覆盖最典型的三类，教会模型"输出格式"
const BASIC_EXAMPLES: Example[] = [
  { text: "这个产品太垃圾了", label: "negative" },
  { text: "质量不错，下次还来", label: "positive" },
  { text: "收到货了", label: "neutral" },
];

// 边界示例：在基础示例之外，额外教两条判定规则
// 1. 反讽：表面夸实际骂 → negative
// 2. 转折："但是/不过"后面才是真正的情感落点
const EDGE_EXAMPLES: Example[] = [
  ...BASIC_EXAMPLES,
  {
    text: "可真行啊，用了两天就坏了",
    label: "negative",
    note: "反讽：表面是夸，实际在骂",
  },
  {
    text: "包装破了点，但东西没问题，给个好评",
    label: "positive",
    note: "转折句：以“但”之后的真实态度为准",
  },
];

interface TestCase {
  text: string;
  reference: Label; // 人工标注的参考标签
  tricky?: string; // 这条的考点
}

const TEST_CASES: TestCase[] = [
  { text: "这个产品太垃圾了", reference: "negative", tricky: "计划中的示例句（也出现在 Few Shot 示例里，观察“样例泄漏”效应）" },
  { text: "太好用了，强烈推荐给大家", reference: "positive" },
  { text: "东西收到了，包装完好", reference: "neutral" },
  { text: "呵呵，可真“好用”呢，第二天就开不了机", reference: "negative", tricky: "反讽" },
  { text: "价格有点小贵，不过质量确实没话说", reference: "positive", tricky: "转折，重点在后半句" },
  { text: "物流一般般，中规中矩吧", reference: "neutral", tricky: "弱情感/无明确褒贬" },
  { text: "等了三天才发货，不过客服态度还可以", reference: "neutral", tricky: "褒贬各半，无明显倾向" },
  { text: "无语，再也不会买了", reference: "negative", tricky: "隐含负面，没有明显贬义词" },
  { text: "已经回购第三次了", reference: "positive", tricky: "隐含正面，没有明显褒义词" },
  { text: "好评，但是发货慢了点", reference: "positive", tricky: "先褒后贬，主句是好评" },
];

type StrategyId = "zero" | "few-basic" | "few-edge";

interface Strategy {
  id: StrategyId;
  name: string;
  purpose: string;
  examples: Example[];
}

const STRATEGIES: Strategy[] = [
  {
    id: "zero",
    name: "Zero Shot（只给指令）",
    purpose: "不给任何示例，只靠 system 指令完成分类",
    examples: [],
  },
  {
    id: "few-basic",
    name: "Few Shot（3 条基础示例）",
    purpose: "用最典型的三类示例教会模型输出格式",
    examples: BASIC_EXAMPLES,
  },
  {
    id: "few-edge",
    name: "Few Shot（5 条含边界示例）",
    purpose: "增加反讽、转折两个边界示例，教模型判定规则",
    examples: EDGE_EXAMPLES,
  },
];

function buildMessages(strategy: Strategy, userText: string) {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];
  // Few Shot 的示例按多轮对话形式注入：user 评论 → assistant 答案
  for (const ex of strategy.examples) {
    messages.push({ role: "user", content: ex.text });
    messages.push({
      role: "assistant",
      content: JSON.stringify({ sentiment: ex.label }),
    });
  }
  messages.push({ role: "user", content: userText });
  return messages;
}

// 模型有时会把 JSON 包在 ```json 代码块里，这里做容错提取
function extractJson(raw: string): { label: Label | null; parseOk: boolean } {
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  const objMatch = cleaned.match(/\{[\s\S]*?\}/);
  if (objMatch) cleaned = objMatch[0];
  try {
    const obj = JSON.parse(cleaned);
    const label = obj.sentiment;
    if (label === "positive" || label === "negative" || label === "neutral") {
      return { label, parseOk: true };
    }
    return { label: null, parseOk: false };
  } catch {
    return { label: null, parseOk: false };
  }
}

interface CaseResult {
  test: TestCase;
  raw: string;
  label: Label | null;
  parseOk: boolean;
  correct: boolean;
  promptTokens: number;
  completionTokens: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 单次调用加 30s 超时 + 最多 3 次重试（实验中遇到过请求挂死几分钟不返回的情况）
async function createWithRetry(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  attempt = 1,
): Promise<OpenAI.Chat.ChatCompletion> {
  try {
    return await client.chat.completions.create(
      {
        model: process.env.MODEL_CHAT || "deepseek-chat",
        messages,
        temperature: 0,
      },
      { timeout: 30_000 },
    );
  } catch (err) {
    if (attempt >= 3) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[day9]   调用失败（第 ${attempt} 次）：${msg}，2s 后重试 ...`);
    await sleep(2000);
    return createWithRetry(messages, attempt + 1);
  }
}

async function classify(strategy: Strategy, test: TestCase): Promise<CaseResult> {
  const response = await createWithRetry(buildMessages(strategy, test.text));
  const raw = response.choices[0].message.content || "";
  const { label, parseOk } = extractJson(raw);
  return {
    test,
    raw,
    label,
    parseOk,
    correct: label === test.reference,
    promptTokens: response.usage?.prompt_tokens ?? 0,
    completionTokens: response.usage?.completion_tokens ?? 0,
  };
}

function emoji(label: Label | null): string {
  return label === "positive" ? "👍" : label === "negative" ? "👎" : label === "neutral" ? "➖" : "❓";
}

function buildMarkdown(
  results: Record<StrategyId, CaseResult[]>,
  totals: Record<StrategyId, { prompt: number; completion: number }>,
): string {
  const date = new Date().toISOString().slice(0, 10);

  const accuracy = (list: CaseResult[]) =>
    `${list.filter((r) => r.correct).length}/${list.length}`;
  const parseRate = (list: CaseResult[]) =>
    `${list.filter((r) => r.parseOk).length}/${list.length}`;

  // 总览表
  const overview = STRATEGIES.map((s) => {
    const list = results[s.id];
    const t = totals[s.id];
    return `| ${s.name} | ${accuracy(list)} | ${parseRate(list)} | ${t.prompt} | ${t.completion} |`;
  }).join("\n");

  // 逐条对照表
  const caseRows = TEST_CASES.map((tc, i) => {
    const cells = STRATEGIES.map((s) => {
      const r = results[s.id][i];
      const mark = r.correct ? "✅" : r.label === null ? "❗解析失败" : "❌";
      return `${emoji(r.label)} ${r.label ?? "—"} ${mark}`;
    }).join(" | ");
    return `| ${i + 1} | ${tc.text} | ${emoji(tc.reference)} ${tc.reference} | ${cells} |`;
  }).join("\n");

  // 每种策略的原始输出
  const sections = STRATEGIES.map((s) => {
    const rows = results[s.id]
      .map((r, i) => {
        const status = r.correct ? "✅" : "❌";
        return `${i + 1}. ${r.test.text}
   - 参考：${r.test.reference}｜模型：${r.label ?? "解析失败"} ${status}
   - 原始输出：\`${r.raw.replace(/\n/g, " ").trim()}\``;
      })
      .join("\n");
    const exampleBlock =
      s.examples.length === 0
        ? "（无示例）"
        : s.examples
            .map((e) => `- 「${e.text}」→ \`${e.label}\`${e.note ? `（${e.note}）` : ""}`)
            .join("\n");
    return `## 策略：${s.name}

**验证点：** ${s.purpose}

**注入的示例：**

${exampleBlock}

**10 条分类结果：**

${rows}
`;
  }).join("\n---\n\n");

  return `# Day 9：Few Shot 文本分类实验

> 日期：${date}
> 模型：${process.env.MODEL_CHAT || "deepseek-chat"}（temperature=0）
> 任务：电商评论情感三分类（positive / negative / neutral），只允许输出 JSON
> 计划要求示例：输入「这个产品太垃圾了」→ 输出 \`{"sentiment": "negative"}\`

## 总览

| 策略 | 与参考标签一致数 | JSON 可解析数 | Prompt Tokens（10 条累计） | Completion Tokens |
|---|---|---|---|---|
${overview}

## 逐条对照

| # | 评论 | 参考标签 | Zero Shot | Few Shot 基础 | Few Shot 边界 |
|---|---|---|---|---|---|
${caseRows}

图例：👍 positive ｜ 👎 negative ｜ ➖ neutral ｜ ❗ 模型输出无法解析为 JSON

---

${sections}
---

## 分析与学习笔记

<!-- 实验运行后人工补充 -->
`;
}

async function main() {
  const results = {} as Record<StrategyId, CaseResult[]>;
  const totals = {} as Record<StrategyId, { prompt: number; completion: number }>;

  for (const strategy of STRATEGIES) {
    console.log(`[day9] 策略：${strategy.name}`);
    const list: CaseResult[] = [];
    let prompt = 0;
    let completion = 0;
    for (const tc of TEST_CASES) {
      let r: CaseResult;
      try {
        r = await classify(strategy, tc);
      } catch (err) {
        // 单条 3 次重试仍失败时，记录为失败案例，继续跑完其余用例
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[day9]   「${tc.text}」最终失败：${msg}`);
        r = {
          test: tc,
          raw: `[API_ERROR] ${msg}`,
          label: null,
          parseOk: false,
          correct: false,
          promptTokens: 0,
          completionTokens: 0,
        };
      }
      list.push(r);
      prompt += r.promptTokens;
      completion += r.completionTokens;
      console.log(
        `[day9]   「${tc.text}」→ ${r.label ?? "解析失败"}（参考 ${tc.reference}）${r.correct ? " ✅" : " ❌"}`,
      );
    }
    results[strategy.id] = list;
    totals[strategy.id] = { prompt, completion };
    console.log(
      `[day9]   小计：${list.filter((r) => r.correct).length}/10 正确，prompt=${prompt} completion=${completion}\n`,
    );
  }

  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs");
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, "day9-few-shot-classification.md");
  writeFileSync(outFile, buildMarkdown(results, totals), "utf-8");
  console.log(`[day9] 结果已写入 ${outFile}`);
}

main().catch((err) => {
  console.error("[day9] 实验失败：", err);
  process.exit(1);
});
