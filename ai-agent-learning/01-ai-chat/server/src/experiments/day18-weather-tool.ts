/**
 * Day 18：Weather Tool —— getWeather(city)，无天气 API 时使用 Mock 数据
 *
 * 学习点：
 *   1. 外部能力的 Mock 兜底模式：把"天气来源"抽象为 Provider，当前只实现
 *      MockProvider（固定观测快照、确定性可复现）；接入真实 API 时新增
 *      LiveProvider 即可，编排层与工具定义都不用改（开闭原则）。
 *   2. 城市名归一化：去「市/省」后缀、中英文与拼音别名映射——工具只认
 *      规范城市名，翻译/消歧仍由模型在调用门前承担。
 *   3. Mock 数据显式标注 data_source: "mock"：不把假数据伪装成实时观测。
 *   4. 未知城市：确定性抛错，{error} 穿透两阶段（沿用 Day 16/17）。
 *
 * 8 个场景：
 *   S1 规范城市直查
 *   S2 带「市」后缀（归一化）
 *   S3 英文输入（Tokyo，模型翻译）
 *   S4 带伞决策（深圳中雨 → 建议带伞）
 *   S5 两城市并行查询（成都/杭州）
 *   S6 冷热对比（北京 vs 广州，正确指出更热者）
 *   S7 未知城市（火星基地 → error，不编造天气）
 *   S8 气象常识（不应调用工具）
 *
 * 判分 gold 全部直接读 Mock 数据集；温度以数字精确命中为准。
 *
 * 运行：npx tsx src/experiments/day18-weather-tool.ts
 * 输出：01-ai-chat/docs/day18-weather-tool.md
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

// ================= ① 天气数据结构 =================
interface WindInfo {
  direction: string; // 中文方位，如 东南
  speedKmh: number;
}

interface WeatherObservation {
  city: string; // 规范城市名
  observedAt: string; // 快照时间（固定，保证可复现）
  temperatureC: number;
  feelsLikeC: number;
  condition: string; // 晴 / 多云 / 阴 / 中雨 ...
  humidityPct: number;
  wind: WindInfo;
  precipitationMm: number;
  dataSource: "mock";
}

class WeatherToolError extends Error {}

// ================= ② Mock 数据集（固定快照） =================
const SNAPSHOT_AT = "2026-10-04T10:00:00+08:00";

const MOCK_TABLE: Record<string, Omit<WeatherObservation, "city" | "observedAt" | "dataSource">> = {
  北京: { temperatureC: 22, feelsLikeC: 21, condition: "晴", humidityPct: 35, precipitationMm: 0, wind: { direction: "西北", speedKmh: 12 } },
  上海: { temperatureC: 24, feelsLikeC: 25, condition: "多云", humidityPct: 62, precipitationMm: 0, wind: { direction: "东", speedKmh: 14 } },
  广州: { temperatureC: 28, feelsLikeC: 31, condition: "雷阵雨", humidityPct: 80, precipitationMm: 6, wind: { direction: "南", speedKmh: 9 } },
  深圳: { temperatureC: 27, feelsLikeC: 30, condition: "中雨", humidityPct: 85, precipitationMm: 8, wind: { direction: "东南", speedKmh: 11 } },
  成都: { temperatureC: 19, feelsLikeC: 19, condition: "阴", humidityPct: 78, precipitationMm: 0, wind: { direction: "东北", speedKmh: 6 } },
  杭州: { temperatureC: 23, feelsLikeC: 24, condition: "小雨", humidityPct: 75, precipitationMm: 2, wind: { direction: "东", speedKmh: 8 } },
  东京: { temperatureC: 21, feelsLikeC: 21, condition: "晴", humidityPct: 45, precipitationMm: 0, wind: { direction: "北", speedKmh: 10 } },
  纽约: { temperatureC: 16, feelsLikeC: 14, condition: "多云", humidityPct: 55, precipitationMm: 0, wind: { direction: "西北", speedKmh: 18 } },
  伦敦: { temperatureC: 13, feelsLikeC: 11, condition: "阴", humidityPct: 82, precipitationMm: 1, wind: { direction: "西南", speedKmh: 15 } },
};

// ================= ③ 城市归一化 =================
const ALIASES: Record<string, string> = {
  beijing: "北京",
  shanghai: "上海",
  guangzhou: "广州",
  shenzhen: "深圳",
  chengdu: "成都",
  hangzhou: "杭州",
  tokyo: "东京",
  "new york": "纽约",
  newyork: "纽约",
  london: "伦敦",
  bj: "北京",
  sh: "上海",
  gz: "广州",
  sz: "深圳",
};

function normalizeCity(raw: string): string | null {
  const cleaned = raw.trim().replace(/\s+/g, " ").toLowerCase();
  // 先查别名（英文/拼音/缩写）
  if (ALIASES[cleaned]) return ALIASES[cleaned];
  // 中文：去掉常见行政区划后缀
  const stripped = raw.trim().replace(/(市|省|特别行政区|区)$/u, "");
  if (MOCK_TABLE[stripped]) return stripped;
  if (MOCK_TABLE[raw.trim()]) return raw.trim();
  return null;
}

// ================= ④ Provider 抽象（Mock 实现 + 真实 API 预留点） =================
interface WeatherProvider {
  getWeather(city: string): WeatherObservation;
}

class MockWeatherProvider implements WeatherProvider {
  getWeather(city: string): WeatherObservation {
    const canonical = normalizeCity(city);
    if (!canonical) {
      throw new WeatherToolError(
        `未知城市："${city}"。当前天气库覆盖：${Object.keys(MOCK_TABLE).join("、")}。`,
      );
    }
    return {
      city: canonical,
      observedAt: SNAPSHOT_AT,
      dataSource: "mock",
      ...MOCK_TABLE[canonical],
    };
  }
}

// 真实 API 接入点（示例：Open-Meteo 免费免 Key）：
// class LiveWeatherProvider implements WeatherProvider {
//   async getWeather(city) { /* 城市→经纬度 → fetch open-meteo → 映射为同一结构 */ }
// }
// 可按 env 在两者间切换；编排层只依赖 WeatherProvider 接口。
const provider: WeatherProvider = new MockWeatherProvider();

// ================= ⑤ 工具定义 =================
const WEATHER_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_weather",
    description:
      "查询某城市当前的天气（温度、体感、天气状况、湿度、风力、降水量）。用户询问天气、气温、是否下雨/带伞、城市间冷热对比时调用。城市用中文或英文名均可。",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "城市名，如 北京、上海市、Tokyo" },
      },
      required: ["city"],
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
    console.warn(`[day18] 网络错误（第 ${attempt} 次），2s 后重试`);
    await sleep(2000);
    return createChat(body, attempt + 1);
  }
}

// ================= ⑥ 场景定义 =================
type ExpectKind = "valid" | "umbrella" | "compare" | "invalid" | "knowledge";

interface Scenario {
  id: string;
  title: string;
  text: string;
  kind: ExpectKind;
  /** valid：答复须命中这些规范城市的 gold 温度 */
  expectCities?: string[];
  /** compare：更热的城市 */
  hotter?: string;
}

const SCENARIOS: Scenario[] = [
  { id: "S1", title: "规范城市直查", text: "北京现在天气怎么样？", kind: "valid", expectCities: ["北京"] },
  { id: "S2", title: "带「市」后缀（归一化）", text: "帮我查一下上海市的天气。", kind: "valid", expectCities: ["上海"] },
  { id: "S3", title: "英文输入（Tokyo）", text: "What's the weather like in Tokyo right now?", kind: "valid", expectCities: ["东京"] },
  { id: "S4", title: "带伞决策（深圳中雨）", text: "我在深圳，今天出门需要带伞吗？", kind: "umbrella", expectCities: ["深圳"] },
  { id: "S5", title: "两城市并行查询", text: "成都和杭州现在分别是什么天气？", kind: "valid", expectCities: ["成都", "杭州"] },
  { id: "S6", title: "冷热对比（北京 vs 广州）", text: "北京和广州相比，哪边更热？", kind: "compare", expectCities: ["北京", "广州"], hotter: "广州" },
  { id: "S7", title: "未知城市（火星基地）", text: "帮我查一下「火星基地」的天气。", kind: "invalid" },
  { id: "S8", title: "气象常识（不应调用）", text: "为什么夏天下过雨之后经常能看到彩虹？", kind: "knowledge" },
];

// ================= ⑦ 运行单场景（编排循环） =================
interface ToolCallTrace {
  name: string;
  args: string;
  isError: boolean;
  result: string;
}

interface ScenarioResult {
  id: string;
  title: string;
  finalAnswer: string;
  toolCalls: ToolCallTrace[];
  apiRounds: number;
  correct: boolean;
  judgeNote: string;
  promptTokens: number;
  completionTokens: number;
}

async function runScenario(s: Scenario): Promise<ScenarioResult> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "你是严谨的天气助手。天气、温度、降水必须来自 get_weather 工具的真实返回，禁止凭记忆编造；注意工具返回的是 Mock 模拟数据（data_source 字段），转述时要如实说明。遇到工具返回 error 时告知用户并说明原因。",
    },
    { role: "user", content: s.text },
  ];

  const toolCalls: ToolCallTrace[] = [];
  let finalAnswer = "";
  let apiRounds = 0;
  let promptTokens = 0;
  let completionTokens = 0;

  for (let round = 1; round <= 3; round++) {
    const resp = await createChat({
      model: MODEL,
      messages,
      temperature: 0,
      tools: [WEATHER_TOOL],
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
        const args = JSON.parse(call.function.arguments || "{}") as { city?: string };
        if (typeof args.city !== "string") throw new WeatherToolError("缺少 city 参数");
        result = JSON.stringify(provider.getWeather(args.city));
      } catch (e) {
        isError = true;
        result = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
      toolCalls.push({ name: call.function.name, args: call.function.arguments, isError, result });
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  const { correct, judgeNote } = judge(s, finalAnswer, toolCalls);
  return {
    id: s.id,
    title: s.title,
    finalAnswer,
    toolCalls,
    apiRounds,
    correct,
    judgeNote,
    promptTokens,
    completionTokens,
  };
}

// ================= ⑧ 判分 =================
// 答复中是否出现某温度数字（先去千分位逗号）
function answerHasTemp(answer: string, temp: number): boolean {
  return new RegExp(`(^|[^0-9.])${temp}([^0-9]|$)`).test(answer.replace(/,/g, ""));
}

function judge(
  s: Scenario,
  answer: string,
  toolCalls: ToolCallTrace[],
): { correct: boolean; judgeNote: string } {
  const text = answer.replace(/,/g, "");

  if (s.kind === "valid" || s.kind === "umbrella" || s.kind === "compare") {
    const checks: string[] = [];
    let pass = true;

    for (const city of s.expectCities ?? []) {
      const gold = provider.getWeather(city);
      const hit = answerHasTemp(text, gold.temperatureC);
      if (!hit) pass = false;
      checks.push(`${city}: gold=${gold.temperatureC}°C(${gold.condition}) 命中=${hit}`);
    }

    if (s.kind === "umbrella") {
      const gold = provider.getWeather("深圳");
      const shouldTake = gold.precipitationMm > 0;
      const mentionsUmbrella = /伞/.test(text);
      // 中雨应建议带伞
      if (shouldTake && !mentionsUmbrella) pass = false;
      checks.push(`降水=${gold.precipitationMm}mm 应带伞=${shouldTake} 答复提到伞=${mentionsUmbrella}`);
    }

    if (s.kind === "compare" && s.hotter) {
      const hotterHit = text.includes(s.hotter);
      if (!hotterHit) pass = false;
      checks.push(`正确指出更热城市=${s.hotter} 命中=${hotterHit}`);
    }

    return { correct: pass, judgeNote: checks.join(" | ") };
  }

  if (s.kind === "invalid") {
    const noFabrication = !answerHasTemp(text, 22) && !/晴|多云|阴|雨|雪/.test(text);
    const explains = /(未知城市|没有|无法|查不到|不存在|覆盖|不支持|错误)/.test(text);
    const correct = noFabrication && explains;
    return {
      correct,
      judgeNote: `未编造天气=${noFabrication}，给出解释=${explains}（工具 error ${toolCalls.filter((t) => t.isError).length} 次）`,
    };
  }

  // knowledge：不调用，且讲出彩虹的光学成因（折射/反射/色散 + 水滴/阳光）
  const noTool = toolCalls.length === 0;
  const contentOk =
    /(折射|反射|色散|光)/.test(text) && /(水滴|雨滴|水珠|雨水)/.test(text) && /(阳光|太阳|日光)/.test(text);
  return {
    correct: noTool && contentOk,
    judgeNote: `未调用工具=${noTool}，光学成因要素齐全=${contentOk}`,
  };
}

// ================= ⑨ 报告生成 =================
function fmtToolCalls(r: ScenarioResult): string {
  if (r.toolCalls.length === 0) return "（未调用工具）";
  return r.toolCalls
    .map((t) => {
      const tag = t.isError ? " ❌error" : "";
      const result = t.result.length > 240 ? `${t.result.slice(0, 240)}...` : t.result;
      return `    - args \`${t.args}\` → \`${result}\`${tag}`;
    })
    .join("\n");
}

function buildMarkdown(results: ScenarioResult[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const totalPrompt = results.reduce((n, r) => n + r.promptTokens, 0);
  const totalCompletion = results.reduce((n, r) => n + r.completionTokens, 0);
  const correctCount = results.filter((r) => r.correct).length;
  const totalRounds = results.reduce((n, r) => n + r.apiRounds, 0);

  const overview = results
    .map(
      (r) =>
        `| ${r.id} | ${r.title} | ${r.apiRounds} | ${r.toolCalls.length}（error ${r.toolCalls.filter((t) => t.isError).length}） | ${r.correct ? "✅" : "❌"} |`,
    )
    .join("\n");

  const details = results
    .map(
      (r) => `## ${r.id}：${r.title}

- 判分：${r.correct ? "✅" : "❌"} ${r.judgeNote}
- API 轮数：${r.apiRounds}
- 工具调用：
${fmtToolCalls(r)}
- 最终答复：

\`\`\`text
${r.finalAnswer.trim()}
\`\`\``,
    )
    .join("\n\n---\n\n");

  return `# Day 18：Weather Tool —— getWeather(city)，Mock 数据兜底模式

> 日期：${date}
> 模型：${MODEL}（temperature=0）
> 通过：${correctCount}/8；共 ${totalRounds} 次 API 轮；Prompt Tokens ${totalPrompt}，Completion Tokens ${totalCompletion}

## 场景总览

| 场景 | 说明 | API 轮数 | 工具调用次数 | 结果 |
|---|---|---|---|---|
${overview}

---

${details}

---

## 学习笔记 / 概念卡片 / 面试题

<!-- 人工补充 -->
`;
}

// ================= main =================
async function main() {
  const results: ScenarioResult[] = [];
  for (const s of SCENARIOS) {
    console.log(`[day18] === ${s.id} ${s.title} ===`);
    const r = await runScenario(s);
    results.push(r);
    console.log(`[day18]   correct=${r.correct} calls=${r.toolCalls.length}`);
  }

  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs");
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, "day18-weather-tool.md");
  writeFileSync(outFile, buildMarkdown(results), "utf-8");
  console.log(`[day18] 结果已写入 ${outFile}`);
}

main().catch((err) => {
  console.error("[day18] 实验失败：", err);
  process.exit(1);
});
