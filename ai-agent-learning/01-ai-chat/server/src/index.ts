import "./env" ;
import express from "express";
import { chat, type ChatMessage } from "./llm";


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

app.listen(PORT, () => {
  console.log(`[server] running at http://localhost:${PORT}`);
});
