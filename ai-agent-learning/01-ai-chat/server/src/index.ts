import "./env" ;
import express from "express";
import { chat, chatStream, type ChatMessage } from "./llm";


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

app.listen(PORT, () => {
  console.log(`[server] running at http://localhost:${PORT}`);
});
