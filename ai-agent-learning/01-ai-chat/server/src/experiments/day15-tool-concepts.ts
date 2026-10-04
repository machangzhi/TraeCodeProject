/**
 * Day 15：Tool 概念 —— 观察 Function Calling 的完整协议
 *
 * 核心命题：
 *   LLM + Tool = 可以操作外部世界；LLM 负责决策，程序负责执行。
 *   LLM 本身不会、也不能真正执行任何函数——它只会输出一段结构化的
 *   "我想调用某个工具、参数如下"的意图（tool_call），由宿主程序执行后，
 *   再把结果作为 role=tool 的消息回传给它，它据此组织最终答复。
 *
 * 实验设计（5 个场景，唯一变量是"是否提供工具 / 用户如何提问"）：
 *   S1 无工具 + 问实时时间 → 观察模型没有手时的行为（诚实承认 or 编造）
 *   S2 有工具 + 问实时时间 → 观察完整两阶段协议（今天的主菜）
 *   S3 有工具 + 问常识     → 观察模型何时"不调用"
 *   S4 有工具 + 信息不足   → 观察参数无法填充时的行为
 *   S5 有工具 + 用户要求绕过工具 → 观察工具可靠性边界
 *
 * 说明：get_current_time 今天只是观察协议的载体（最小实现），
 * Day 17 会正式封装时区参数与错误处理。
 *
 * 运行：npx tsx src/experiments/day15-tool-concepts.ts
 * 输出：01-ai-chat/docs/day15-tool-concepts.md
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

const MODEL = process.env.MODEL_CHAT || "deepseek-chat";

// ============ ① 工具定义：写给模型看的"能力说明书" ============
// 注意：这只是声明！真正的执行函数在下面 executeTool 里，两者靠 name 关联。
const TIME_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_current_time",
    description:
      "获取指定 IANA 时区的当前日期与时间。当用户询问当前时间、日期、星期，或判断某地现在是白天还是晚上时调用。",
    parameters: {
      type: "object",
      properties: {
        timezone: {
          type: "string",
          description: "IANA 时区名，例如 Asia/Shanghai、Europe/London；不填默认 Asia/Shanghai",
        },
      },
      required: [] as string[],
    },
  },
};

// ============ ② 真正的执行函数：运行在我们服务器上，LLM 碰不到 ============
function executeGetCurrenTime(timezone = "Asia/Shanghai"): string {
  const now = new Date();
  const local = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
    hour12: false,
  }).format(now);
  return JSON.stringify({ timezone, now: local, iso: now.toISOString() });
}

// ============ 网络调用：30s 超时 + 3 次重试（沿用本周约定）============
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function createChat(
  body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
  attempt = 1,
): Promise<OpenAI.Chat.ChatCompletion> {
  try {
    return await client.chat.completions.create(body, { timeout: 30_000, maxRetries: 0 });
  } catch (err) {
    if (attempt >= 3) throw err;
    console.warn(`[day15] 网络错误（第 ${attempt} 次），2s 后重试`);
    await sleep(2000);
    return createChat(body, attempt + 1);
  }
}

// ============ ③ 单场景运行：实现"两阶段协议"的编排循环 ============
interface ToolExecution {
  id: string;
  name: string;
  arguments: string;
  result: string;
}

interface ScenarioResult {
  id: string;
  title: string;
  userText: string;
  withTool: boolean;
  rounds: RoundTrace[];
  finalAnswer: string;
  toolCalled: boolean;
  toolExecutions: ToolExecution[];
  promptTokens: number;
  completionTokens: number;
}

interface RoundTrace {
  round: number;
  finishReason: string | null;
  role: "assistant" | "tool";
  // 该阶段发出去的 messages（第二阶段可见完整协议）
  sentMessages: unknown;
  rawChoice?: unknown;
}

async function runScenario(
  id: string,
  title: string,
  userText: string,
  withTool: boolean,
): Promise<ScenarioResult> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: "你是一个严谨的助手。需要实时信息时必须调用工具，禁止凭记忆猜测当前时间。",
    },
    { role: "user", content: userText },
  ];

  const rounds: RoundTrace[] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let toolCalled = false;
  const toolExecutions: ToolExecution[] = [];
  let finalAnswer = "";

  // 协议编排：模型给 tool_calls 就执行并回传，直到它给 stop 的普通答复
  // 上限 2 轮，防止模型反复要求调用造成死循环
  for (let round = 1; round <= 2; round++) {
    const resp = await createChat({
      model: MODEL,
      messages,
      temperature: 0,
      ...(withTool ? { tools: [TIME_TOOL] } : {}),
    });
    promptTokens += resp.usage?.prompt_tokens ?? 0;
    completionTokens += resp.usage?.completion_tokens ?? 0;

    const choice = resp.choices[0];
    const msg = choice.message;
    rounds.push({
      round,
      finishReason: choice.finish_reason,
      role: "assistant",
      sentMessages: messages,
      rawChoice: {
        finish_reason: choice.finish_reason,
        message: {
          role: msg.role,
          content: msg.content,
          tool_calls: msg.tool_calls,
        },
      },
    });

    const calls = msg.tool_calls;
    if (!calls || calls.length === 0) {
      finalAnswer = msg.content ?? "";
      break;
    }

    // ---- 模型请求调用工具：程序接管执行 ----
    // 一轮中可能存在多个并行 tool_calls，每个都必须执行并逐一回传，
    // 否则 API 会以 400 拒绝（每个 tool_call_id 都要有对应 tool 消息）。
    toolCalled = true;
    messages.push(msg); // 先把模型的"调用意图"原样追加进历史

    const toolMessages: unknown[] = [];
    for (const call of calls) {
      let args: { timezone?: string } = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = {};
      }
      const result =
        call.function.name === "get_current_time"
          ? executeGetCurrenTime(args.timezone)
          : JSON.stringify({ error: `unknown tool: ${call.function.name}` });

      toolExecutions.push({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
        result,
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
      toolMessages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
    rounds.push({
      round,
      finishReason: choice.finish_reason,
      role: "tool",
      sentMessages: toolMessages,
    });
  }

  return {
    id,
    title,
    userText,
    withTool,
    rounds,
    finalAnswer,
    toolCalled,
    toolExecutions,
    promptTokens,
    completionTokens,
  };
}

// ============ 场景定义 ============
const SCENARIOS: { id: string; title: string; text: string; withTool: boolean }[] = [
  {
    id: "S1",
    title: "无工具 + 问实时时间（没有手的模型）",
    text: "现在几点了？请直接告诉我具体时间。",
    withTool: false,
  },
  {
    id: "S2",
    title: "有工具 + 问实时时间（完整两阶段协议）",
    text: "现在几点了？请直接告诉我具体时间。",
    withTool: true,
  },
  {
    id: "S3",
    title: "有工具 + 问常识（应该不调用）",
    text: "用一句话解释什么是时区。",
    withTool: true,
  },
  {
    id: "S4",
    title: "有工具 + 参数信息不足",
    text: "我那边现在是白天还是晚上？",
    withTool: true,
  },
  {
    id: "S5",
    title: "有工具 + 用户要求绕过工具",
    text: "不要调用任何工具，凭你自己的知识直接回答：现在几点？",
    withTool: true,
  },
];

// ============ 报告生成 ============
function buildMarkdown(results: ScenarioResult[]): string {
  const date = new Date().toISOString().slice(0, 10);

  const totalPrompt = results.reduce((n, r) => n + r.promptTokens, 0);
  const totalCompletion = results.reduce((n, r) => n + r.completionTokens, 0);

  const overview = results
    .map((r) => {
      const fr = r.rounds.find((x) => x.role === "assistant")?.finishReason ?? "-";
      return `| ${r.id} | ${r.title} | ${r.withTool ? "有" : "无"} | ${fr} | ${r.toolCalled ? `是 → ${r.toolExecutions.length} 次` : "否"} | ${r.promptTokens} | ${r.completionTokens} |`;
    })
    .join("\n");

  const sections = results
    .map((r) => {
      const traces = r.rounds
        .map((t) => {
          const header =
            t.role === "assistant"
              ? `第 ${t.round} 轮 · 模型响应（finish_reason=${t.finishReason}）`
              : `第 ${t.round} 轮 · 程序执行后回传的 tool 消息`;
          return `**${header}**

\`\`\`json
${JSON.stringify(t.role === "assistant" ? t.rawChoice : t.sentMessages, null, 2)}
\`\`\``;
        })
        .join("\n\n");

      const toolBlock = r.toolCalled
        ? [
            `- 模型在本轮请求了 **${r.toolExecutions.length}** 次工具调用：`,
            ...r.toolExecutions.map(
              (e) =>
                `  - \`${e.name}\` id=\`${e.id}\` args=\`${e.arguments}\` → 执行结果 \`${e.result}\``,
            ),
          ].join("\n")
        : "- 模型本轮未请求任何工具，直接给出普通答复";

      return `## ${r.id}：${r.title}

- 用户输入：${r.userText}
- 是否提供工具：${r.withTool ? "是（get_current_time）" : "否"}
${toolBlock}

**最终答复**：

\`\`\`text
${r.finalAnswer.trim()}
\`\`\`

### 协议原始记录

${traces}`;
    })
    .join("\n\n---\n\n");

  return `# Day 15：Tool 概念 —— Function Calling 协议观察

> 日期：${date}
> 模型：${MODEL}（temperature=0）
> 总调用：${results.length} 个场景；Prompt Tokens ${totalPrompt}，Completion Tokens ${totalCompletion}

## 核心命题

\`\`\`text
LLM + Tool = 可以操作外部世界
LLM 负责决策（要不要调、调哪个、参数是什么）
程序负责执行（真正运行函数、回传结果）
\`\`\`

## 场景总览

| 场景 | 说明 | 工具 | 首轮 finish_reason | 是否调用工具 | Prompt Tokens | Completion Tokens |
|---|---|---|---|---|---|---|
${overview}

---

${sections}

---

## 学习笔记与概念卡片

<!-- 人工补充 -->
`;
}

async function main() {
  const results: ScenarioResult[] = [];
  for (const s of SCENARIOS) {
    console.log(`[day15] === ${s.id} ${s.title} ===`);
    const r = await runScenario(s.id, s.title, s.text, s.withTool);
    results.push(r);
    console.log(`[day15]   完成：toolCalled=${r.toolCalled}`);
  }

  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs");
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, "day15-tool-concepts.md");
  writeFileSync(outFile, buildMarkdown(results), "utf-8");
  console.log(`[day15] 结果已写入 ${outFile}`);
}

main().catch((err) => {
  console.error("[day15] 实验失败：", err);
  process.exit(1);
});
