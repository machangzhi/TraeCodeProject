import express from "express";
import dotenv from "dotenv";

// 启动时读取 .env 中的环境变量（API Key 等）
dotenv.config();

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT) || 3000;

// Day1：健康检查接口，用于证明后端真正跑起来了
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "ai-chat-server", ts: Date.now() });
});

app.listen(PORT, () => {
  console.log(`[server] running at http://localhost:${PORT}`);
});
