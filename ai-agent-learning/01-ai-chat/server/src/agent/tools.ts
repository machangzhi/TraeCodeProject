/**
 * Day 27：Agent 工具集（Day 16-18 的三个正式工具，供 Agent 循环使用）
 *
 * - calculator：精确数学计算（Day 16 递归下降解析器）
 * - get_current_time：Intl 时区时间（Day 17）
 * - get_weather：Mock 天气数据（Day 18，无真实天气 API）
 */
import { z } from "zod";
import type OpenAI from "openai";
import type { ToolHandler } from "./registry.ts";

export class ToolExecError extends Error {}

// ---------------- calculator ----------------

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) i++;
    else if (/[0-9.]/.test(ch)) {
      let num = "";
      while (i < src.length && /[0-9.]/.test(src[i])) num += src[i++];
      if ((num.match(/\./g) ?? []).length > 1 || num === ".") throw new ToolExecError(`非法数字：${num}`);
      tokens.push(num);
    } else if ("+-*/%^()".includes(ch)) {
      tokens.push(ch);
      i++;
    } else throw new ToolExecError(`不支持的字符：${ch}`);
  }
  return tokens;
}

export function calculate(expression: string): number {
  if (expression.length > 200) throw new ToolExecError("表达式过长（上限 200）");
  const tokens = tokenize(expression);
  if (tokens.length === 0) throw new ToolExecError("表达式为空");
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseExpr(): number {
    let v = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const r = parseTerm();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  function parseTerm(): number {
    let v = parseFactor();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = next();
      const r = parseFactor();
      if (op === "*") v *= r;
      else {
        if (r === 0) throw new ToolExecError(op === "/" ? "除数不能为 0" : "对 0 取模无意义");
        v = op === "/" ? v / r : v % r;
      }
    }
    return v;
  }
  function parseFactor(): number {
    const b = parseUnary();
    if (peek() === "^") {
      next();
      return b ** parseFactor();
    }
    return b;
  }
  function parseUnary(): number {
    if (peek() === "-" || peek() === "+") {
      const sign = next() === "-" ? -1 : 1;
      return sign * parseUnary();
    }
    return parsePrimary();
  }
  function parsePrimary(): number {
    const tk = peek();
    if (tk === "(") {
      next();
      const v = parseExpr();
      if (next() !== ")") throw new ToolExecError("括号不匹配");
      return v;
    }
    if (tk === undefined) throw new ToolExecError("表达式不完整");
    if (!/^[0-9.]+$/.test(tk)) throw new ToolExecError(`此处应为数字：${tk}`);
    next();
    return Number(tk);
  }

  const result = parseExpr();
  if (pos !== tokens.length) throw new ToolExecError(`存在无法解析的片段：${tokens.slice(pos).join(" ")}`);
  if (!Number.isFinite(result)) throw new ToolExecError("结果超出范围");
  return result;
}

// ---------------- time ----------------

const DEFAULT_TZ = "Asia/Shanghai";

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function getCurrentTime(timezone = DEFAULT_TZ) {
  if (!isValidTimezone(timezone)) throw new ToolExecError(`非法时区："${timezone}"`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    timezone,
    hourMinute: `${get("hour").padStart(2, "0")}:${get("minute")}`,
    date: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

// ---------------- weather（Mock） ----------------

const SNAPSHOT_AT = "2026-10-04T10:00:00+08:00";
const MOCK_WEATHER: Record<string, { temperatureC: number; condition: string; precipitationMm: number }> = {
  北京: { temperatureC: 22, condition: "晴", precipitationMm: 0 },
  上海: { temperatureC: 24, condition: "多云", precipitationMm: 0 },
  深圳: { temperatureC: 27, condition: "中雨", precipitationMm: 8 },
};

export function getWeather(city: string) {
  const stripped = city.trim().replace(/(市|省)$/u, "");
  const hit = MOCK_WEATHER[stripped];
  if (!hit) throw new ToolExecError(`未知城市："${city}"，当前覆盖：${Object.keys(MOCK_WEATHER).join("、")}`);
  return { city: stripped, observedAt: SNAPSHOT_AT, dataSource: "mock" as const, ...hit };
}

// ---------------- 注册表条目 ----------------

export function makeAgentTools(): ToolHandler<any>[] {
  return [
    {
      name: "calculator",
      definition: {
        type: "function",
        function: {
          name: "calculator",
          description: "精确数学计算器。数值计算必须调用，不要心算。支持 + - * / % ^ ( )。",
          parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
        },
      } satisfies OpenAI.Chat.Completions.ChatCompletionTool,
      schema: z.object({ expression: z.string().min(1).max(200) }),
      run: ({ expression }) => ({ expression, result: calculate(expression) }),
    },
    {
      name: "get_current_time",
      definition: {
        type: "function",
        function: {
          name: "get_current_time",
          description: "获取时区当前时间/日期。",
          parameters: {
            type: "object",
            properties: { timezone: { type: "string", description: `IANA 名；默认 ${DEFAULT_TZ}` } },
            required: [] as string[],
          },
        },
      } satisfies OpenAI.Chat.Completions.ChatCompletionTool,
      schema: z.object({ timezone: z.string().optional() }),
      run: ({ timezone }) => getCurrentTime(timezone),
    },
    {
      name: "get_weather",
      definition: {
        type: "function",
        function: {
          name: "get_weather",
          description: "查询城市天气（温度、状况、降水量）。覆盖：北京、上海、深圳。",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      } satisfies OpenAI.Chat.Completions.ChatCompletionTool,
      schema: z.object({ city: z.string().min(1) }),
      run: ({ city }) => getWeather(city),
    },
  ];
}
