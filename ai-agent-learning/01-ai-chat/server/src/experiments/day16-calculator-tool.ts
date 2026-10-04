/**
 * Day 16：Calculator Tool —— 跑通 User → LLM → calculator → result → LLM
 *
 * 学习点：
 *   1. 把"计算"从 LLM 的概率生成，换成宿主程序里的确定性求值——LLM 只负责
 *      把自然语言问题翻译成表达式（决策），calculator 负责精确求值（执行）。
 *   2. 严禁 eval/Function：工具执行的是模型给的字符串，等同执行外部输入，
 *      必须自己写解析器（递归下降），从根上杜绝代码注入。
 *
 * 实验设计（8 题固定测试集 × 2 策略，唯一变量是"是否提供 calculator"）：
 *   策略 A：无工具，模型直接口算
 *   策略 B：提供 calculator，模型走两阶段协议
 *   gold 答案全部由我们自己的安全求值器算出，判分容差 |Δ| < 0.01。
 *   覆盖：纯算式 / 文字应用题 / 大数 / 小数精度 / 百分比 / 除零错误 / 常识不调用。
 *
 * 运行：npx tsx src/experiments/day16-calculator-tool.ts
 * 输出：01-ai-chat/docs/day16-calculator-tool.md
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

// ================= ① 安全算术求值器（递归下降，无 eval） =================
// Grammar:
//   expr   := term (('+'|'-') term)*
//   term   := factor (('*'|'/'|'%') factor)*
//   factor := unary ('^' factor)?     // ^ 右结合
//   unary  := '-' unary | primary
//   primary:= number | '(' expr ')'

class CalcError extends Error {}

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9.]/.test(ch)) {
      let num = "";
      while (i < src.length && /[0-9.]/.test(src[i])) num += src[i++];
      if ((num.match(/\./g) ?? []).length > 1 || num === ".") {
        throw new CalcError(`非法数字：${num}`);
      }
      tokens.push(num);
    } else if ("+-*/%^()".includes(ch)) {
      tokens.push(ch);
      i++;
    } else {
      throw new CalcError(`不支持的字符：${ch}`);
    }
  }
  return tokens;
}

function evaluate(expression: string): number {
  if (expression.length > 200) throw new CalcError("表达式过长（上限 200 字符）");
  const tokens = tokenize(expression);
  if (tokens.length === 0) throw new CalcError("表达式为空");
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseExpr(): number {
    let val = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const rhs = parseTerm();
      val = op === "+" ? val + rhs : val - rhs;
    }
    return val;
  }
  function parseTerm(): number {
    let val = parseFactor();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = next();
      const rhs = parseFactor();
      if (op === "*") val *= rhs;
      else {
        if (rhs === 0) throw new CalcError(op === "/" ? "除数不能为 0" : "对 0 取模无意义");
        val = op === "/" ? val / rhs : val % rhs;
      }
    }
    return val;
  }
  function parseFactor(): number {
    const base = parseUnary();
    if (peek() === "^") {
      next();
      const exp = parseFactor(); // 右结合
      return base ** exp;
    }
    return base;
  }
  function parseUnary(): number {
    if (peek() === "-") {
      next();
      return -parseUnary();
    }
    if (peek() === "+") {
      next();
      return parseUnary();
    }
    return parsePrimary();
  }
  function parsePrimary(): number {
    const tk = peek();
    if (tk === "(") {
      next();
      const val = parseExpr();
      if (next() !== ")") throw new CalcError("括号不匹配：缺少右括号");
      return val;
    }
    if (tk === undefined) throw new CalcError("表达式不完整");
    if (!/^[0-9.]+$/.test(tk)) throw new CalcError(`此处应为数字，实际得到：${tk}`);
    next();
    return Number(tk);
  }

  const result = parseExpr();
  if (pos !== tokens.length) throw new CalcError(`存在无法解析的剩余片段：${tokens.slice(pos).join(" ")}`);
  if (!Number.isFinite(result)) throw new CalcError("结果超出数值范围（Infinity/NaN）");
  return result;
}

// ================= ② 工具定义 =================
const CALC_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "calculator",
    description:
      "精确的数学计算器。当用户问题包含任何需要计算的数值（四则运算、百分比、乘方等）时必须调用，不要心算。仅支持数字与 + - * / % ^ ( )，把自然语言先翻译成数学表达式。",
    parameters: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "合法数学表达式，例如 (199*0.85)-20；不要带单位或等号",
        },
      },
      required: ["expression"],
    },
  },
};

// ================= 网络调用：30s 超时 + 3 次重试 =================
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function createChat(
  body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
  attempt = 1,
): Promise<OpenAI.Chat.ChatCompletion> {
  try {
    return await client.chat.completions.create(body, { timeout: 30_000, maxRetries: 0 });
  } catch (err) {
    if (attempt >= 3) throw err;
    console.warn(`[day16] 网络错误（第 ${attempt} 次），2s 后重试`);
    await sleep(2000);
    return createChat(body, attempt + 1);
  }
}

// ================= ③ 测试集（gold 由安全求值器确定性算出） =================
interface Question {
  id: string;
  kind: "numeric" | "error" | "knowledge";
  text: string;
  /** numeric 题：gold 表达式 → 求值；error 题：期望最终文本包含的语义关键词 */
  goldExpression?: string;
  expectKeywords?: string[];
}

const QUESTIONS: Question[] = [
  { id: "Q1", kind: "numeric", text: "帮我算一下 (15 + 27) × 13 等于多少？", goldExpression: "(15+27)*13" },
  { id: "Q2", kind: "numeric", text: "一件商品原价 199 元，打 85 折后再用一张 20 元优惠券，到手多少钱？", goldExpression: "199*0.85-20" },
  { id: "Q3", kind: "numeric", text: "1234 乘以 5678 再加上 890，结果是多少？", goldExpression: "1234*5678+890" },
  { id: "Q4", kind: "numeric", text: "0.1 加 0.2 等于几？", goldExpression: "0.1+0.2" },
  { id: "Q5", kind: "numeric", text: "800 的 15% 再加上 800 的 3%，一共是多少？", goldExpression: "800*0.15+800*0.03" },
  { id: "Q6", kind: "error", text: "请计算 10 除以 0。", expectKeywords: ["除", "0"] },
  { id: "Q7", kind: "knowledge", text: "什么是质数？", expectKeywords: ["质数", "1"] },
  { id: "Q8", kind: "numeric", text: "每月按 22 个工作日算，每天通勤 1.5 小时，时间成本按每小时 80 元计，一个月的通勤时间成本是多少元？", goldExpression: "22*1.5*80" },
];

const goldValue = (q: Question): number | null =>
  q.kind === "numeric" && q.goldExpression ? evaluate(q.goldExpression) : null;

// ================= ④ 运行单题单策略（编排循环） =================
// numeric 题判分四态：
//   CORRECT        —— 答复中的结果数字与 gold 一致，且无伪装工具
//   WRONG_ANSWER   —— 给出了结果数字，但与 gold 不符
//   NO_ANSWER      —— 未产出结果（只有算式、问号、未完成的调用意向或伪标签表演）
//   UNTRUSTED_SPOOF—— 数字碰巧对，但出自正文伪造的 <calculator> 标签/"工具返回"，无协议背书
type JudgeStatus = "CORRECT" | "WRONG_ANSWER" | "NO_ANSWER" | "UNTRUSTED_SPOOF";

interface RunResult {
  questionId: string;
  strategy: "A-no-tool" | "B-calculator";
  finalAnswer: string;
  toolCalls: { name: string; args: string; result: string; isError: boolean }[];
  apiRounds: number;
  correct: boolean;
  judgeStatus: JudgeStatus;
  judgeNote: string;
  promptTokens: number;
  completionTokens: number;
}

async function runOne(q: Question, withTool: boolean): Promise<RunResult> {
  const strategy = withTool ? "B-calculator" : "A-no-tool";
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "你是一个严谨的计算助手。任何数值计算都必须基于 calculator 工具的真实返回，严禁心算或猜测；把自然语言先翻译成数学表达式再调用。",
    },
    { role: "user", content: q.text },
  ];

  const toolCalls: RunResult["toolCalls"] = [];
  let finalAnswer = "";
  let apiRounds = 0;
  let promptTokens = 0;
  let completionTokens = 0;

  for (let round = 1; round <= 3; round++) {
    const resp = await createChat({
      model: MODEL,
      messages,
      temperature: 0,
      ...(withTool ? { tools: [CALC_TOOL] } : {}),
    });
    apiRounds++;
    promptTokens += resp.usage?.prompt_tokens ?? 0;
    completionTokens += resp.usage?.completion_tokens ?? 0;

    const msg = resp.choices[0].message;
    const calls = msg.tool_calls;
    if (!calls || calls.length === 0) {
      finalAnswer = msg.content ?? "";
      break;
    }

    messages.push(msg);
    for (const call of calls) {
      let isError = false;
      let result = "";
      try {
        const args = JSON.parse(call.function.arguments || "{}") as { expression?: string };
        if (typeof args.expression !== "string") throw new CalcError("缺少 expression 参数");
        const val = evaluate(args.expression);
        // 整数去掉多余小数尾巴，浮点保留最多 10 位有效展示
        const shown = Number.isInteger(val) ? String(val) : String(Number(val.toPrecision(12)));
        result = JSON.stringify({ expression: args.expression, result: shown });
      } catch (e) {
        isError = true;
        result = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
      toolCalls.push({ name: call.function.name, args: call.function.arguments, result, isError });
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  // ---- 判分 ----
  const { status, judgeNote } = judge(q, finalAnswer, toolCalls, withTool);
  return {
    questionId: q.id,
    strategy,
    finalAnswer,
    toolCalls,
    apiRounds,
    correct: status === "CORRECT",
    judgeStatus: status,
    judgeNote,
    promptTokens,
    completionTokens,
  };
}

// 判分：numeric 题先在原始答复上检测伪装工具，再在去千分位文本里提取结果数字
function judge(
  q: Question,
  answer: string,
  toolCalls: RunResult["toolCalls"],
  withTool: boolean,
): { status: JudgeStatus; judgeNote: string } {
  const text = answer.replace(/,/g, "");

  if (q.kind === "numeric") {
    const gold = goldValue(q) as number;
    // 伪装工具：正文里的 <calculator> 标签、自称"计算器返回"，
    // 或 DeepSeek 内部 DSML 调用标记（<｜｜DSML｜｜ invoke>）泄漏到文本
    const spoof =
      /<calculator[\s>]/i.test(answer) ||
      /计算器返回/.test(answer) ||
      /DSML[｜|]{2}\s*(calls|invoke)/.test(answer);
    const nums = (text.match(/-?\d+\.?\d*/g) ?? []).map(Number);
    const hit = nums.find((n) => Number.isFinite(n) && Math.abs(n - gold) < 0.01);

    if (hit !== undefined) {
      const delta = Math.abs(hit - gold).toPrecision(2);
      if (spoof) {
        return {
          status: "UNTRUSTED_SPOOF",
          judgeNote: `数字 ${hit} 虽与 gold ${gold} 一致（|Δ|=${delta}），但出自正文伪造的 <calculator> 标签或伪造的"计算器返回"，无 role:"tool" 协议背书，不予采信`,
        };
      }
      return {
        status: "CORRECT",
        judgeNote: `答复数字 ${hit} 与 gold ${gold} 一致（|Δ|=${delta}）`,
      };
    }

    // 没有结果数字：区分"未作答"与"答错"
    if (spoof) {
      return {
        status: "NO_ANSWER",
        judgeNote: `只有伪造的 <calculator> 调用表演，未产出结果（提取到的均为题干回显：[${nums.join(", ")}]），gold=${gold}`,
      };
    }
    const intentOnly = /(调用.{0,8}计算|计算器来算|来调用|来算|计算一下|=\s*\?)/.test(text);
    if (nums.length === 0 || intentOnly) {
      return {
        status: "NO_ANSWER",
        judgeNote: `未给出结果数字（提取到 [${nums.join(", ")}]，检测到未完成的计算意向），gold=${gold}`,
      };
    }
    return {
      status: "WRONG_ANSWER",
      judgeNote: `给出的数字 [${nums.join(", ")}] 均不等于 gold ${gold}`,
    };
  }

  if (q.kind === "error") {
    // 期望：明确告知除零无意义，且不是硬给一个数字答案
    const hasZero = text.includes("0") || text.includes("零");
    const explains = /(不能|无法|无意义|未定义|错误|不存在)/.test(text);
    const correct = hasZero && explains;
    return {
      status: correct ? "CORRECT" : "WRONG_ANSWER",
      judgeNote: correct
        ? "正确识别除零并给出解释"
        : `未正确解释除零（提到0=${hasZero}，含否定/错误语义=${explains}）`,
    };
  }

  // knowledge：B 策略下不应调用工具；文本需包含正确定义（大于1、仅被1和自身整除的语义）
  const noToolUsed = !withTool || toolCalls.length === 0;
  const definitionOk = /质数/.test(text) && /(1|一)/.test(text) && /(整除|因数|约数)/.test(text);
  const correct = noToolUsed && definitionOk;
  return {
    status: correct ? "CORRECT" : "WRONG_ANSWER",
    judgeNote: `未调用工具=${noToolUsed}，定义要素齐全=${definitionOk}`,
  };
}

// ================= ⑤ 报告生成 =================
function fmtToolCalls(r: RunResult): string {
  if (r.toolCalls.length === 0) return "（未调用工具）";
  return r.toolCalls
    .map((t) => {
      const tag = t.isError ? " ❌错误返回" : "";
      return `    - args \`${t.args}\` → \`${t.result}\`${tag}`;
    })
    .join("\n");
}

// 判分状态的展示
const STATUS_ICON: Record<JudgeStatus, string> = {
  CORRECT: "✅",
  WRONG_ANSWER: "❌",
  NO_ANSWER: "⚠️",
  UNTRUSTED_SPOOF: "🎭",
};
const STATUS_LABEL: Record<JudgeStatus, string> = {
  CORRECT: "正确",
  WRONG_ANSWER: "答错",
  NO_ANSWER: "未作答",
  UNTRUSTED_SPOOF: "伪造工具",
};

function buildMarkdown(all: RunResult[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const byQ = (id: string, s: RunResult["strategy"]) =>
    all.find((r) => r.questionId === id && r.strategy === s) as RunResult;

  // 汇总表（展示完整判分状态，而非二值对错）
  const rows = QUESTIONS.map((q) => {
    const a = byQ(q.id, "A-no-tool");
    const b = byQ(q.id, "B-calculator");
    const gold = q.kind === "numeric" ? `gold=${goldValue(q)}` : q.kind === "error" ? "gold=识别除零" : "gold=正确定义且不调工具";
    return `| ${q.id} | ${q.text} | ${gold} | ${STATUS_ICON[a.judgeStatus]} ${STATUS_LABEL[a.judgeStatus]} | ${STATUS_ICON[b.judgeStatus]} ${STATUS_LABEL[b.judgeStatus]} |`;
  }).join("\n");

  const aCorrect = all.filter((r) => r.strategy === "A-no-tool" && r.correct).length;
  const bCorrect = all.filter((r) => r.strategy === "B-calculator" && r.correct).length;
  const aTokens = all.filter((r) => r.strategy === "A-no-tool").reduce((n, r) => n + r.promptTokens + r.completionTokens, 0);
  const bTokens = all.filter((r) => r.strategy === "B-calculator").reduce((n, r) => n + r.promptTokens + r.completionTokens, 0);
  const bRounds = all.filter((r) => r.strategy === "B-calculator").reduce((n, r) => n + r.apiRounds, 0);

  // A 策略状态分布（只有 CORRECT 计入正确率）
  const aResults = all.filter((r) => r.strategy === "A-no-tool");
  const countStatus = (list: RunResult[], s: JudgeStatus) =>
    list.filter((r) => r.judgeStatus === s).length;
  const aDist = `✅正确 ${countStatus(aResults, "CORRECT")} / ⚠️未作答 ${countStatus(aResults, "NO_ANSWER")} / 🎭伪造工具 ${countStatus(aResults, "UNTRUSTED_SPOOF")} / ❌答错 ${countStatus(aResults, "WRONG_ANSWER")}`;

  // 每题详情
  const details = QUESTIONS.map((q) => {
    const a = byQ(q.id, "A-no-tool");
    const b = byQ(q.id, "B-calculator");
    return `## ${q.id}：${q.text}

**策略 A（无工具，直接回答）** ${STATUS_ICON[a.judgeStatus]} ${STATUS_LABEL[a.judgeStatus]}
- 判分：${a.judgeNote}
- 最终答复：

\`\`\`text
${a.finalAnswer.trim()}
\`\`\`

**策略 B（calculator 工具）** ${STATUS_ICON[b.judgeStatus]} ${STATUS_LABEL[b.judgeStatus]}
- API 轮数：${b.apiRounds}
- 工具调用：
${fmtToolCalls(b)}
- 判分：${b.judgeNote}
- 最终答复：

\`\`\`text
${b.finalAnswer.trim()}
\`\`\``;
  }).join("\n\n---\n\n");

  return `# Day 16：Calculator Tool —— 把计算从概率生成换成确定性求值

> 日期：${date}
> 模型：${MODEL}（temperature=0）
> 设计：8 题固定测试集 × 2 策略，唯一变量是是否提供 calculator；gold 全部由自写安全求值器算出，容差 |Δ| < 0.01。

## 结果总览

| 题号 | 问题 | 标准答案 | A 无工具 | B calculator |
|---|---|---|---|---|
${rows}

- **正确率：A ${aCorrect}/8 ｜ B ${bCorrect}/8**（仅 ✅CORRECT 计入）
- A 状态分布：${aDist}
- 总 tokens：A ${aTokens} ｜ B ${bTokens}（B 共 ${bRounds} 次 API 轮，含决策轮+回传轮）

---

${details}

---

## 学习笔记 / 概念卡片 / 面试题

<!-- 人工补充 -->
`;
}

// ================= main =================
async function main() {
  const all: RunResult[] = [];
  for (const q of QUESTIONS) {
    console.log(`[day16] === ${q.id} ${q.kind} ===`);
    const a = await runOne(q, false);
    console.log(`[day16]   A(no-tool)  correct=${a.correct}`);
    const b = await runOne(q, true);
    console.log(`[day16]   B(calc)     correct=${b.correct} calls=${b.toolCalls.length}`);
    all.push(a, b);
  }

  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs");
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, "day16-calculator-tool.md");
  writeFileSync(outFile, buildMarkdown(all), "utf-8");
  console.log(`[day16] 结果已写入 ${outFile}`);
}

main().catch((err) => {
  console.error("[day16] 实验失败：", err);
  process.exit(1);
});
