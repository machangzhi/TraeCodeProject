import "./env" ;
import express from "express";
import { chat, chatStream, type ChatMessage } from "./llm";
import { runAgentStream } from "./agent/agent";
import { addDocument, ingestDocuments, listDocuments, ragQuery } from "./rag/rag";
import { lexicalRerank } from "./rag/rerank";
import { rewriteQuery } from "./rag/rewrite";


const app = express();
// Day 39：上传文档走 JSON 提交，默认 100kb 放不下较大的 Markdown，调到 2mb
app.use(express.json({ limit: "2mb" }));

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

// Day 39：RAG 知识库问答接口
// Day 45：新增 threshold 相似度阈值——distance 高于阈值的召回视为无关内容；
//         全部超阈值则直接短路拒答（不调 LLM）。
//         Day 45 实验证明固定全局阈值（0.7）在本库净亏（可用阈值区间为空集），
//         故默认不启用：只有显式传 body.threshold 或设置 RAG_THRESHOLD 才过滤。
// Day 46：新增 rerank 精排——粗排 TopN（默认 20）→ Rerank → TopK 送 LLM；默认开启，
//         传 rerank:false 或 RAG_RERANK=0 可关闭（关闭即退回纯向量排序）。
// Day 47：新增 rewrite 查询改写——先让 LLM 把口语化问题改写成带实体锚点的检索式，再检索；
//         默认关闭（每次查询多一次 LLM 调用），显式传 rewrite:true 或 RAG_REWRITE=1 开启。
//         改写只作用于检索，最终回答的仍是用户原始问题。
// POST /api/rag  body: { question, topK?, category?, threshold?, rerank?, rerankTopN?, rewrite? }
// 返回 { answer, sources: [{ file, heading, distance, rerankScore? }], matched }
app.post("/api/rag", async (req, res) => {
  try {
    const { question, topK, category, threshold, rerank, rerankTopN, rewrite } = req.body ?? {};
    if (typeof question !== "string" || !question.trim()) {
      res.status(400).json({ error: "question 不能为空" });
      return;
    }
    const envThreshold = Number(process.env.RAG_THRESHOLD);
    const effectiveThreshold =
      typeof threshold === "number" && Number.isFinite(threshold)
        ? threshold
        : Number.isFinite(envThreshold)
          ? envThreshold
          : undefined;
    const useRerank = !(rerank === false || process.env.RAG_RERANK === "0");
    const useRerankTopN =
      typeof rerankTopN === "number" && rerankTopN > 0 ? rerankTopN : 20;
    const useRewrite = rewrite === true || process.env.RAG_REWRITE === "1";
    const searchQuery = useRewrite ? (await rewriteQuery(question)).searchQuery : undefined;
    const result = await ragQuery(question, {
      topK: topK ?? 3,
      filter: category ? { category } : undefined,
      threshold: effectiveThreshold,
      rerank: useRerank ? lexicalRerank : undefined,
      rerankTopN: useRerankTopN,
      searchQuery,
    });
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[rag] 失败:", message);
    res.status(500).json({ error: "RAG 查询失败" });
  }
});

// Day 39：重新入库文档
// POST /api/rag/ingest  返回 { count, files }
app.post("/api/rag/ingest", async (_req, res) => {
  try {
    const result = await ingestDocuments();
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[rag/ingest] 失败:", message);
    res.status(500).json({ error: "入库失败" });
  }
});

// Day 39：知识库列表
// GET /api/rag/documents  返回 { documents: [{ file, category, chunkCount, headings }] }
app.get("/api/rag/documents", (_req, res) => {
  try {
    res.json({ documents: listDocuments() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[rag/documents] 失败:", message);
    res.status(500).json({ error: "读取知识库失败" });
  }
});

// Day 39：上传文档
// POST /api/rag/documents  body: { filename, content }（前端用 FileReader 读成文本后 JSON 提交）
// 返回 { file, count }；写入 data/docs 后全量重新入库
app.post("/api/rag/documents", async (req, res) => {
  try {
    const { filename, content } = req.body ?? {};
    if (typeof filename !== "string" || !filename.trim()) {
      res.status(400).json({ error: "filename 不能为空" });
      return;
    }
    if (typeof content !== "string" || !content.trim()) {
      res.status(400).json({ error: "content 不能为空" });
      return;
    }
    const result = await addDocument(filename, content);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[rag/documents] 上传失败:", message);
    res.status(500).json({ error: "上传失败" });
  }
});

app.listen(PORT, () => {
  console.log(`[server] running at http://localhost:${PORT}`);
});