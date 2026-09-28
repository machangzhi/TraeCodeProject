# 01-ai-chat：第一周 AI Chat 应用

从零实现的极简 AI 聊天应用，覆盖第一周（Day 1–Day 6）全部内容。

## 功能

- 多轮对话（模型无状态，每轮携带完整历史）
- SSE 流式输出（逐字显示，无需等待完整回答）
- Markdown 渲染 + 代码语法高亮
- 多会话管理（新建 / 切换 / 刷新恢复）
- Stop 按钮中断生成（AbortController）
- 后端 token 预算截断（防爆 context window）
- localStorage 持久化（防抖写入）

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Vue 3 + Vite + TypeScript + markdown-it + highlight.js |
| 后端 | Node.js + Express + OpenAI SDK（DeepSeek 兼容协议） |
| 通信 | SSE（fetch ReadableStream 手动解析） |

## 快速开始

```bash
# 后端（端口 3000）
cd server
cp .env.example .env   # 填入 DEEPSEEK_API_KEY
npm install
npm run dev

# 前端（端口 5173，代理 /api 到 3000）
cd frontend
npm install
npm run dev
```

打开 http://localhost:5173

## 项目结构

```text
01-ai-chat/
├── server/src/
│   ├── env.ts      # dotenv 优先加载（ESM 顺序坑）
│   ├── llm.ts      # OpenAI SDK 封装 + token 估算 + 历史截断
│   └── index.ts    # Express 路由：/api/chat、/api/chat/stream
└── frontend/src/
    ├── App.vue                 # 会话管理 + 流式收发 + Stop
    └── components/
        └── MarkdownView.vue    # Markdown 渲染 + 代码高亮
```

## 五个核心问题

### 1. Token 是什么？

Token 是 LLM 处理文本的最小单位，不是字也不是词。分词器（如 BPE）把文本切成子词片段：英文约 1 词 ≈ 1.3 token，中文约 1 字 ≈ 1 token。API 按 token 计费（输入和输出分别计价），context window 也以 token 计。本项目用「非 ASCII 按 1、ASCII 按 0.3」的粗略估算法，见 [llm.ts](file:///d:/TraeCodeProject/ai-agent-learning/01-ai-chat/server/src/llm.ts)。

### 2. Context Window 是什么？

模型单次请求能处理的最大 token 数（输入 + 输出的总和上限），即模型的"记忆容量"。DeepSeek 是 64K。超出直接报错，所以长对话必须截断历史。注意这个窗口对每轮请求独立计算——不是累计配额。

### 3. SSE 为什么适合 LLM Streaming？

- **单向推送**：服务器 → 客户端单向流，LLM 生成是单向的，天然匹配
- **基于 HTTP**：无需 WebSocket 的协议升级，过代理/防火墙无障碍
- **浏览器原生支持**：EventSource（本项目因需 POST body 改用 fetch + ReadableStream 手动解析，本质相同）
- **文本协议**：`data: {...}\n\n` 格式简单，LLM 逐 token 生成的特性正好逐条推送
- **轻量**：比 WebSocket 简单，比轮询实时

### 4. API Key 为什么不能放前端？

前端代码（JS bundle、localStorage、网络请求）对任何打开 DevTools 的人都是可见的。Key 一旦泄露：他人可盗刷你的额度产生费用、可被用于违规内容导致封号。正确做法：Key 只存后端 `.env`，前端只调自己的后端接口，由后端转发给 LLM 厂商。本项目 Key 在 `server/.env`，经 [env.ts](file:///d:/TraeCodeProject/ai-agent-learning/01-ai-chat/server/src/env.ts) 在入口最先加载。

### 5. 多轮对话为什么会增加 Token 消耗？

LLM 无状态——它不记得任何历史。"多轮记忆"是每轮请求都把**完整 messages 数组**重新发给 API 实现的。第 N 轮的输入 token ≈ 前 N-1 轮全部（输入+输出）之和 + 本轮输入。历史线性增长，每轮的输入计费也随之增长，总成本约是轮次的平方级。这就是为什么需要历史截断（本项目预算 8000 token）、为什么长对话更贵。

## 关键实现笔记

- **SSE 断连检测**：必须监听 `res.on('close')` 而非 `req`——Node 16+ 中 POST body 被 `express.json()` 读完后 req 流会立即触发 close，与客户端是否断开无关
- **ESM 加载顺序**：`import` 按顺序执行，读 `process.env` 的模块必须在 `dotenv.config()` 之后，故独立 `env.ts` 在入口第一行导入
- **流式写串会话**：`send()` 捕获发起时的 `conv.messages` 引用，用户中途切换会话也不会把 delta 写错
- **localStorage 防抖**：流式期间每个 delta 都触发 deep watch，需 300ms 防抖合并写入，避免 O(token数 × 总数据量) 卡顿
- **XSS 防护**：markdown-it 设 `html: false`，LLM 输出中的原始 HTML 一律转义
