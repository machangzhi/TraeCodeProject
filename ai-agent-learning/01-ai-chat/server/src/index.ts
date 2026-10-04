import "./env" ;
import express from "express";
import { chat, chatStream, type ChatMessage } from "./llm";
import { runAgentStream } from "./agent/agent";


const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT) || 3000;

// Day1：健康检查接口，用于证明后端真正跑起来了
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "ai-chat-server", ts: Date.now() });
});

// Day2: 聊天接口
app.post("/api/chat", async (req, res) => {
  try {
    const messages = req.body?.messages as ChatMessage[] | undefined;
    if(!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "messages必须是非空数组" });
      return;
    }
    const reply = await chat(messages);
    res.json({ reply });
  } catch (error) {
    const message =error instanceof Error ? error.message: String(error);
    console.error("[chat] LLM 调用失败:", message);
    res.status(500).json({ error: "LLM 调用失败" });
  }
});

// Day4: 流式聊天接口（SSE）
// SSE 三件套响应头：告诉浏览器这是一条“一直开着”的事件流，别缓存、别断开
app.post("/api/chat/stream", async (req, res) => {
  const messages = req.body?.messages as ChatMessage[] | undefined;
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages必须是非空数组" });
    return;
  }

  // 客户端中途关掉页面时停止生成，避免白白烧 token。
  // 注意必须监听 res 而不是 req：POST body 被 express.json() 读完后，
  // req 流在 Node 16+ 上会立即触发 close（与连接是否断开无关），会导致 closed 恒为 true。
  // res 的 close 在响应正常结束时也会触发，用 writableFinished 区分“真断开”与“正常结束”。
  let closed = false;
  res.on("close", () => {
    if (!res.writableFinished) closed = true;
  });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    for await (const delta of chatStream(messages)) {
      if (closed) break;
      // SSE 报文格式：data: <内容>\n\n（两个换行代表一条消息结束）
      res.write(`data: ${JSON.stringify({ delta })}\n\n`);
    }
    if (!closed) {
      // 约定 [DONE] 表示流结束（与 OpenAI 官方 SSE 习惯一致）
      res.write("data: [DONE]\n\n");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[chat/stream] LLM 调用失败:", message);
    if (!closed) {
      res.write(`data: ${JSON.stringify({ error: "LLM 调用失败" })}\n\n`);
    }
  } finally {
    res.end();
  }
});

// Day 27：Agent 思考链流式接口（SSE）
// 请求体 { messages }：最后一条 user 消息作为本轮任务，其余作为历史（Memory = full 策略）。
// 事件流 data: {"type":"thinking"|"tool_call"|"tool_result"|"answer"|"done"|"error", ...}，[DONE] 结束。
app.post("/api/agent/stream", async (req, res) => {
  const messages = req.body?.messages as ChatMessage[] | undefined;
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages必须是非空数组" });
    return;
  }
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    res.status(400).json({ error: "messages中必须包含至少一条user消息" });
    return;
  }
  // 最后一条 user 之前的消息作为历史（剔除 system 与之后可能重复的内容）
  const idx = messages.lastIndexOf(lastUser);
  const history = messages.slice(0, idx).filter((m) => m.role === "user" || m.role === "assistant");

  // 断连检测：必须监听 res 而非 req（Node16+ POST body 读完后 req 立即 close）
  let closed = false;
  res.on("close", () => {
    if (!res.writableFinished) closed = true;
  });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (payload: unknown) => {
    if (!closed) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    await runAgentStream({
      input: lastUser.content,
      history,
      onEvent: send,
    });
    if (!closed) res.write("data: [DONE]\n\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[agent/stream] 运行失败:", message);
    if (!closed) send({ type: "error", message: "Agent 运行失败" });
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`[server] running at http://localhost:${PORT}`);
});
