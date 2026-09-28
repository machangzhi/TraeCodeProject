/**
 * Day 8：Prompt 基础 —— 同一问题、不同 Prompt 策略对比实验
 *
 * 学习点对应：
 * - System Prompt：策略 B/C/D/E 演示 system 对输出的塑形作用
 * - User Prompt：所有策略共用同一个 user 问题，保证只有 system 是变量
 * - Role：策略 B/C 对比"面试官"与"老师"两种角色的语气和内容差异
 * - Context：策略 C/E 注入受众背景/用户画像，观察回答的针对性
 * - Instruction：策略 D 用强格式指令约束输出结构
 *
 * 运行：npx tsx src/experiments/day8-prompt-basics.ts
 * 输出：控制台日志 + 01-ai-chat/docs/day8-prompt-comparison.md
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

// 统一的用户问题，保证 5 组实验的唯一变量是 system prompt
const QUESTION = "什么是闭包？";

interface Strategy {
  id: string;
  name: string;
  purpose: string; // 这个策略想验证什么
  system?: string; // 无 system 即基线
}

const STRATEGIES: Strategy[] = [
  {
    id: "A",
    name: "基线：裸 User Prompt",
    purpose: "不设 system，看模型的默认行为（后续策略的对照组）",
  },
  {
    id: "B",
    name: "Role：面试官",
    purpose: "Role 设定如何改变语气和内容倾向",
    system:
      "你是一位资深前端面试官，正在面试候选人。用考察的口吻回答，并在结尾追问候选人一个深入的追问问题。",
  },
  {
    id: "C",
    name: "Role + Context：新手老师",
    purpose: "注入受众背景（Context），观察回答是否会主动降维",
    system:
      "你是一位耐心的编程老师。你的学生刚学完 JS 的变量、函数和作用域，完全没听过闭包。请结合他已学的知识来解释，避免引入他还不会的概念。",
  },
  {
    id: "D",
    name: "Instruction：强格式约束",
    purpose: "用指令锁死输出结构，观察可控性",
    system: `回答任何概念性问题时，必须严格按以下结构输出，总字数不超过 300 字：
1. 【一句话定义】
2. 【生活类比】
3. 【最小代码示例】
4. 【常见误区】`,
  },
  {
    id: "E",
    name: "Context：用户画像注入",
    purpose: "把用户画像作为 context 注入，观察个性化程度",
    system: `以下是提问者的背景信息：
- 小明，10 年后端开发（Java），刚转前端 1 个月
- 熟悉 Java 的匿名内部类和 lambda
请基于他的技术背景，用他熟悉的概念做类比来解释。`,
  },
];

interface Result {
  strategy: Strategy;
  reply: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}

async function runOne(strategy: Strategy): Promise<Result> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    ...(strategy.system
      ? [{ role: "system" as const, content: strategy.system }]
      : []),
    { role: "user", content: QUESTION },
  ];

  const start = Date.now();
  const response = await client.chat.completions.create({
    model: process.env.MODEL_CHAT || "deepseek-chat",
    messages,
  });
  const durationMs = Date.now() - start;

  return {
    strategy,
    reply: response.choices[0].message.content || "",
    promptTokens: response.usage?.prompt_tokens ?? 0,
    completionTokens: response.usage?.completion_tokens ?? 0,
    durationMs,
  };
}

function buildMarkdown(results: Result[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const totalTokens = results.reduce(
    (s, r) => s + r.promptTokens + r.completionTokens,
    0,
  );

  const summaryRows = results
    .map(
      (r) =>
        `| ${r.strategy.id} | ${r.strategy.name} | ${r.promptTokens} | ${r.completionTokens} | ${(r.durationMs / 1000).toFixed(1)}s | ${r.reply.length} |`,
    )
    .join("\n");

  const details = results
    .map((r) => {
      const systemBlock = r.strategy.system
        ? `**System Prompt：**\n\n\`\`\`text\n${r.strategy.system}\n\`\`\``
        : "**System Prompt：**（无）";
      return `## 策略 ${r.strategy.id}：${r.strategy.name}

**验证点：** ${r.strategy.purpose}

${systemBlock}

**User Prompt：** ${QUESTION}

**回复（${r.completionTokens} tokens / ${(r.durationMs / 1000).toFixed(1)}s）：**

${r.reply}
`;
    })
    .join("\n---\n\n");

  return `# Day 8：Prompt 策略对比实验

> 日期：${date}
> 模型：${process.env.MODEL_CHAT || "deepseek-chat"}
> 实验方法：固定 User Prompt「${QUESTION}」，只改变 System Prompt，对比 5 种策略的输出差异。
> 本次实验总 token 消耗：${totalTokens}

## 汇总

| 策略 | 说明 | Prompt Tokens | Completion Tokens | 耗时 | 回复字符数 |
|---|---|---|---|---|---|
${summaryRows}

---

${details}

---

## 对比分析

<!-- 以下为人工分析，实验运行后补充 -->
`;
}

async function main() {
  console.log(`[day8] 问题：${QUESTION}`);
  console.log(`[day8] 共 ${STRATEGIES.length} 个策略，串行执行\n`);

  const results: Result[] = [];
  for (const strategy of STRATEGIES) {
    console.log(`[day8] 运行策略 ${strategy.id}：${strategy.name} ...`);
    const result = await runOne(strategy);
    results.push(result);
    console.log(
      `[day8] 策略 ${strategy.id} 完成：prompt=${result.promptTokens} completion=${result.completionTokens} 耗时=${(result.durationMs / 1000).toFixed(1)}s\n`,
    );
  }

  // server/src/experiments/ → 上三层 = 01-ai-chat/
  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs");
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, "day8-prompt-comparison.md");
  writeFileSync(outFile, buildMarkdown(results), "utf-8");
  console.log(`[day8] 结果已写入 ${outFile}`);
}

main().catch((err) => {
  console.error("[day8] 实验失败：", err);
  process.exit(1);
});
