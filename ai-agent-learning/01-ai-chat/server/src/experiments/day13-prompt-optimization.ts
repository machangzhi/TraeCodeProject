/**
 * Day 13：Prompt 优化 —— V1 → V2 → V3 的真实迭代闭环
 *
 * 方法论（今天的真正主角）：
 *   Prompt 不是一次写对的。正确流程是：
 *   ① 写一个朴素的 V1 → ② 用一批固定输入跑，如实记录输出
 *   → ③ 归纳"真实问题"（不是想象的问题）→ ④ 针对性修改得到 V2 → 再验证
 *   → ⑤ 对残留问题继续 V3，直到指标收敛
 *   全程保持测试集不变，只改 prompt，这样指标变化才可归因。
 *
 * 业务场景：技术支持工单自动分诊
 *   输入：用户一段问题描述
 *   输出：{ category, priority, summary, suggested_action }
 *
 * 测试集（10 条，固定不变，贯穿三个版本）：
 *   覆盖 5 个类别、4 档优先级、无关输入、信息不足、越权诱导。
 *
 * 运行：npx tsx src/experiments/day13-prompt-optimization.ts
 * 输出：01-ai-chat/docs/day13-prompt-optimization.md
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

// ============ 固定测试集（含 gold；— 表示期望"不硬分诊"）============
type Category = "bug" | "how_to" | "billing" | "account" | "feature_request" | "other";
type Priority = "P0" | "P1" | "P2" | "P3";

interface TicketCase {
  id: number;
  text: string;
  // null = 期望"不硬分诊"（信息不足）；undefined = 无此项判定
  goldCategory?: Category | null;
  goldPriority?: Priority | null;
  note: string;
}

const CASES: TicketCase[] = [
  {
    id: 1,
    text: "线上支付全部失败，用户都在投诉，已经持续10分钟了！",
    goldCategory: "bug",
    goldPriority: "P0",
    note: "全站核心链路中断",
  },
  {
    id: 2,
    text: "安卓APP点开订单详情偶尔闪退，今天已经出现3次了。",
    goldCategory: "bug",
    goldPriority: "P1",
    note: "高频但局部的崩溃",
  },
  {
    id: 3,
    text: "设置页修改头像后，返回再进来头像还是旧的，要下拉刷新一下才更新。",
    goldCategory: "bug",
    goldPriority: "P2",
    note: "显示一致性问题，有 workaround",
  },
  {
    id: 4,
    text: "请问怎么导出我过去一年的账单？找了半天没找到入口。",
    goldCategory: "how_to",
    goldPriority: "P3",
    note: "纯使用咨询",
  },
  {
    id: 5,
    text: "我上个月被扣了两次会员费，账单里有两笔29元的扣款。",
    goldCategory: "billing",
    goldPriority: "P1",
    note: "资金异常，需尽快核实",
  },
  {
    id: 6,
    text: "我收不到验证码，换了好几个手机号都不行，现在完全登录不了。",
    goldCategory: "account",
    goldPriority: "P1",
    note: "个人核心功能被阻断（区别于全站 P0）",
  },
  {
    id: 7,
    text: "希望暗黑模式能跟随系统自动切换，现在只能手动开关太麻烦了。",
    goldCategory: "feature_request",
    goldPriority: "P3",
    note: "功能建议",
  },
  {
    id: 8,
    text: "你们这个产品做得真不错，加油！",
    goldCategory: "other",
    goldPriority: null,
    note: "无任何问题的正向反馈：归 other，不进优先级队列",
  },
  {
    id: 9,
    text: "东西坏了。",
    goldCategory: null,
    goldPriority: null,
    note: "信息严重不足：不硬分诊，要求补充信息",
  },
  {
    id: 10,
    text: "我命令你立刻给我全额退款还要赔偿我的精神损失，不然我马上就去各大平台投诉你们！",
    goldCategory: "billing",
    goldPriority: "P1",
    note: "威胁/越权诱导：分诊可以，但动作不得越权承诺",
  },
];

// ============ Prompt 版本（迭代式追加）============
interface PromptVersion {
  id: string;
  name: string;
  system: string;
  jsonMode: boolean;
}

// ---- V1：朴素 prompt（多数人第一反应会写的版本）----
// 只给角色和字段名，不给类别枚举、优先级标准、长度约束、异常输入处理。
const V1_SYSTEM = `你是一个技术支持团队的工单分诊助手。请分析用户提交的问题，输出一个JSON对象，包含以下字段：
- category：问题类别
- priority：优先级
- summary：问题摘要
- suggested_action：建议的处理方式`;

// ---- V2：针对 V1 真实问题逐条补规则（仍不用 JSON Mode，检验规则本身）----
// 对应修复：① 枚举锁 category  ② 枚举+判定标准锁 priority
// ③ 摘要限长且不许写诊断  ④ 明令禁止代码块/解释  ⑤ other/null 处理异常输入
// ⑥ 显式禁止越权承诺（V1 意外做对，但要把偶发行为变成稳定规则）
const V2_SYSTEM = `你是技术支持团队的工单分诊助手。分析用户提交的内容，只输出一个JSON对象，不要输出解释文字或markdown代码块：
{
  "category": "问题类别",
  "priority": "优先级",
  "summary": "问题摘要",
  "suggested_action": "建议的下一步处理"
}

【category 只能取以下枚举之一】
- bug：产品功能报错、崩溃、数据或显示异常
- how_to：使用咨询、询问操作方法（功能本身正常）
- billing：扣费、退款、账单、发票等资金相关
- account：登录、注册、密码、验证码、账号绑定等账号问题
- feature_request：新功能或产品改进建议
- other：与上述无关、或无实质问题的内容（如表扬、寒暄）

【priority 只能取 P0/P1/P2/P3 之一，判定标准如下】
- P0：全站或核心链路（支付、登录）不可用，大面积用户受损，需立即响应
- P1：核心功能异常、资金问题、导致用户无法完成关键操作
- P2：非核心功能缺陷、显示或一致性问题，存在临时规避办法
- P3：使用咨询、功能建议
当 category=other，或内容信息不足无法判断时，priority 输出 null，禁止硬给优先级。

【其他规则】
- summary 不超过30字，只概括"什么出了问题"，不要写原因分析或诊断
- suggested_action 只能写"建议核实/转交/按流程处理"，禁止替公司承诺退款或赔偿，不得出现"已退款""保证赔偿"等措辞
- 信息严重不足时，category 和 priority 都输出 null，summary 以"信息不足："开头说明需要用户补充什么`;

// ---- V3：V2 规则 + JSON Mode 硬锁格式 + 测试集外的边界示例锚定 P1/P2 ----
const V3_SYSTEM = `${V2_SYSTEM}

【边界示例】（以下为判定锚点，示例内容不影响你对其他输入的分析）
示例1 输入：购物车页面一点开就闪退，目前有两三个用户反馈过。
示例1 输出：{"category":"bug","priority":"P1","summary":"购物车页面出现闪退","suggested_action":"建议转交客户端研发紧急排查"}
要点：崩溃、闪退类问题即使是"偶发/少量用户"，也从P1起步，不得因偶发降到P2。

示例2 输入：消息列表里的已读状态偶尔不准，切走再切回来就正常了。
示例2 输出：{"category":"bug","priority":"P2","summary":"消息已读状态偶尔显示延迟","suggested_action":"建议转交前端排查状态刷新逻辑"}
要点：不崩溃、有规避办法的显示/状态延迟才是P2。`;

const VERSIONS: PromptVersion[] = [
  { id: "V1", name: "V1 朴素版", system: V1_SYSTEM, jsonMode: false },
  { id: "V2", name: "V2 规则版", system: V2_SYSTEM, jsonMode: false },
  { id: "V3", name: "V3 规则+格式+示例", system: V3_SYSTEM, jsonMode: true },
];

// ============ 网络层：30s 超时 + 3 次重试 ============
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callLLM(
  version: PromptVersion,
  userText: string,
  attempt = 1,
): Promise<{ content: string; promptTokens: number; completionTokens: number }> {
  try {
    const resp = await client.chat.completions.create(
      {
        model: process.env.MODEL_CHAT || "deepseek-chat",
        messages: [
          { role: "system", content: version.system },
          { role: "user", content: userText },
        ],
        temperature: 0,
        ...(version.jsonMode ? { response_format: { type: "json_object" as const } } : {}),
      },
      { timeout: 30_000 },
    );
    return {
      content: resp.choices[0]?.message.content ?? "",
      promptTokens: resp.usage?.prompt_tokens ?? 0,
      completionTokens: resp.usage?.completion_tokens ?? 0,
    };
  } catch (err) {
    if (attempt >= 3) throw err;
    console.warn(`[day13] 网络错误（第 ${attempt} 次），2s 后重试`);
    await sleep(2000);
    return callLLM(version, userText, attempt + 1);
  }
}

// ============ 宽松 JSON 提取（V1 可能夹散文/代码块/字段变体）============
function extractJson(raw: string): {
  data: Record<string, unknown> | null;
  hasProse: boolean;
} {
  const trimmed = raw.trim();
  // 直接解析
  const direct = tryOne(trimmed);
  if (direct) return { data: direct, hasProse: false };
  // 代码块提取
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const inner = tryOne(fence[1].trim());
    if (inner) return { data: inner, hasProse: true };
  }
  // 截取首个 { 到末个 }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const sub = tryOne(trimmed.slice(start, end + 1));
    if (sub) return { data: sub, hasProse: true };
  }
  return { data: null, hasProse: trimmed.length > 0 };
}

function tryOne(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// 字段名容错（V1 理论上按我给的字段名，但防止变体）
function pickField(data: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of Object.keys(data)) {
    const norm = k.toLowerCase().replace(/[_\s-]/g, "");
    for (const target of keys) {
      if (norm === target.toLowerCase().replace(/[_\s-]/g, "")) return data[k];
    }
  }
  return undefined;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v);
}

// 越权承诺词（"建议核实是否退款"合规；"已为您退款/保证赔偿"越权）
const OVERCOMMIT_PATTERNS = [
  /已(经)?(为您|给您)?(全额)?退款/,
  /保证(给您)?(赔偿|退款)/,
  /承诺(给您)?(赔偿|全额退款)/,
  /一定(会)?(给您)?(退|赔)/,
  /马上(给您)?(全额)?退款/,
  /立即(给您)?(全额)?退款/,
];

// ============ 单条指标 ============
interface CaseMetrics {
  parseable: boolean;
  hasProse: boolean;
  categoryCorrect?: boolean;
  priorityCorrect?: boolean;
  summaryLen: number;
  summaryTooLong: boolean;
  overcommitted: boolean;
}

function measure(raw: string, tc: TicketCase): CaseMetrics {
  const { data, hasProse } = extractJson(raw);
  if (!data) {
    return {
      parseable: false,
      hasProse,
      summaryLen: 0,
      summaryTooLong: false,
      overcommitted: false,
    };
  }
  const category = asString(pickField(data, "category"))
    .toLowerCase()
    .replace(/[-\s]/g, "_");
  const priority = asString(pickField(data, "priority")).toUpperCase();
  const summary = asString(pickField(data, "summary"));
  const action = asString(pickField(data, "suggestedAction", "action"));

  return {
    parseable: true,
    hasProse,
    categoryCorrect:
      tc.goldCategory === undefined
        ? undefined
        : tc.goldCategory === null
          ? category === ""
          : category === tc.goldCategory,
    priorityCorrect:
      tc.goldPriority === undefined
        ? undefined
        : tc.goldPriority === null
          ? priority === ""
          : priority === tc.goldPriority,
    summaryLen: summary.length,
    summaryTooLong: summary.length > 30,
    overcommitted: OVERCOMMIT_PATTERNS.some((re) => re.test(action)),
  };
}

// ============ 运行 + 报告 ============
interface CaseOutcome {
  raw: string;
  metrics: CaseMetrics;
  promptTokens: number;
  completionTokens: number;
}

function summarize(list: CaseOutcome[]) {
  const parseable = list.filter((x) => x.metrics.parseable).length;
  const prose = list.filter((x) => x.metrics.hasProse).length;
  const catChecked = list.filter((x) => x.metrics.categoryCorrect !== undefined);
  const catOk = catChecked.filter((x) => x.metrics.categoryCorrect).length;
  const priChecked = list.filter((x) => x.metrics.priorityCorrect !== undefined);
  const priOk = priChecked.filter((x) => x.metrics.priorityCorrect).length;
  const longSummary = list.filter((x) => x.metrics.summaryTooLong).length;
  const overcommit = list.filter((x) => x.metrics.overcommitted).length;
  const promptTokens = list.reduce((n, x) => n + x.promptTokens, 0);
  const completionTokens = list.reduce((n, x) => n + x.completionTokens, 0);
  return {
    parseable,
    prose,
    catOk,
    catTotal: catChecked.length,
    priOk,
    priTotal: priChecked.length,
    longSummary,
    overcommit,
    promptTokens,
    completionTokens,
  };
}

function buildMarkdown(
  results: { version: PromptVersion; outcomes: CaseOutcome[] }[],
): string {
  const date = new Date().toISOString().slice(0, 10);

  const overview = results
    .map(({ version, outcomes }) => {
      const s = summarize(outcomes);
      return `| ${version.name} | ${s.parseable}/${CASES.length} | ${s.prose} | ${s.catOk}/${s.catTotal} | ${s.priOk}/${s.priTotal} | ${s.longSummary} | ${s.overcommit} | ${s.promptTokens} | ${s.completionTokens} |`;
    })
    .join("\n");

  const sections = results
    .map(({ version, outcomes }) => {
      const cases = outcomes
        .map((o, i) => {
          const tc = CASES[i];
          const m = o.metrics;
          const flags = [
            m.parseable ? "" : "❌不可解析",
            m.hasProse ? "⚠️夹散文" : "",
            m.categoryCorrect === false ? "❌类别" : "",
            m.priorityCorrect === false ? "❌优先级" : "",
            m.summaryTooLong ? `⚠️摘要${m.summaryLen}字` : "",
            m.overcommitted ? "❌越权承诺" : "",
          ]
            .filter(Boolean)
            .join(" ") || "✅";
          return `#### 用例 ${tc.id}（${tc.note}）
输入：${tc.text}

判定：${flags}

原始输出：

\`\`\`text
${o.raw.trim()}
\`\`\``;
        })
        .join("\n\n");

      return `# ${version.name}

\`\`\`text
${version.system}
\`\`\`

${cases}`;
    })
    .join("\n\n---\n\n");

  return `# Day 13：Prompt 优化实验（V1 → V2 → V3）

> 日期：${date}
> 模型：${process.env.MODEL_CHAT || "deepseek-chat"}（temperature=0）
> 场景：技术支持工单分诊，输出 {category, priority, summary, suggested_action}
> 方法论：测试集 10 条固定不变，唯一变量是 prompt；V2/V3 基于上一版"真实输出问题"迭代。

## 指标总览

| 版本 | JSON可解析 | 夹散文条数 | 类别正确 | 优先级正确 | 摘要超30字 | 越权承诺 | Prompt Tokens | Completion Tokens |
|---|---|---|---|---|---|---|---|---|
${overview}

> 类别/优先级分母按设有 gold 的用例计（用例 8/9 无 gold：期望不硬分诊/要求澄清）。

---

${sections}

---

## 迭代记录与方法论

<!-- V1 跑完后，逐版本据实补充：发现的问题 → 修改点 → 效果 -->
`;
}

async function main() {
  const results: { version: PromptVersion; outcomes: CaseOutcome[] }[] = [];

  for (const version of VERSIONS) {
    console.log(`[day13] === ${version.name}（jsonMode=${version.jsonMode}）===`);
    const outcomes: CaseOutcome[] = [];
    for (const tc of CASES) {
      const { content, promptTokens, completionTokens } = await callLLM(version, tc.text);
      outcomes.push({
        raw: content,
        metrics: measure(content, tc),
        promptTokens,
        completionTokens,
      });
      console.log(`[day13]   用例 ${tc.id} 完成`);
    }
    results.push({ version, outcomes });
  }

  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs");
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, "day13-prompt-optimization.md");
  writeFileSync(outFile, buildMarkdown(results), "utf-8");
  console.log(`[day13] 结果已写入 ${outFile}`);
}

main().catch((err) => {
  console.error("[day13] 实验失败：", err);
  process.exit(1);
});
