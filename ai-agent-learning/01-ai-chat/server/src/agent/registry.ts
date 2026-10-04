/**
 * Day 27：ToolRegistry —— 四阶段执行流水线（Day 19/25 成果的服务端正式版）
 *
 * lookup（工具不存在）→ parse（JSON 解析）→ validate（Zod 校验）→ execute（业务执行）
 * 永不抛出：所有错误都变成结构化 ExecResult 回喂模型（Day 25 结论）。
 */
import { z } from "zod";
import type OpenAI from "openai";

export interface ToolHandler<T = any> {
  name: string;
  definition: OpenAI.Chat.Completions.ChatCompletionTool;
  schema: z.ZodType<T>;
  run(args: T): unknown;
}

export type FailStage = "lookup" | "parse" | "validate" | "execute";
export type ExecResult =
  | { ok: true; data: unknown }
  | { ok: false; stage: FailStage; error: string; details?: unknown };

export class ToolRegistry {
  private handlers = new Map<string, ToolHandler>();

  register(h: ToolHandler): void {
    if (this.handlers.has(h.name)) throw new Error(`工具重复注册：${h.name}`);
    if (h.definition.function.name !== h.name) throw new Error(`工具名不一致：${h.name}`);
    this.handlers.set(h.name, h);
  }

  definitions(): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return [...this.handlers.values()].map((h) => h.definition);
  }

  execute(name: string, rawArguments: string): ExecResult {
    const h = this.handlers.get(name);
    if (!h) return { ok: false, stage: "lookup", error: `未注册的工具："${name}"` };
    let raw: unknown;
    try {
      raw = rawArguments ? JSON.parse(rawArguments) : {};
    } catch (e) {
      return { ok: false, stage: "parse", error: `参数不是合法 JSON：${e instanceof Error ? e.message : String(e)}` };
    }
    const parsed = h.schema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false, stage: "validate", error: "参数校验失败",
        details: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      };
    }
    try {
      return { ok: true, data: h.run(parsed.data) };
    } catch (e) {
      return { ok: false, stage: "execute", error: e instanceof Error ? e.message : String(e) };
    }
  }
}
