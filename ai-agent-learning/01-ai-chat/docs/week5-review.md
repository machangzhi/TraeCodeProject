# 第 5 周周复盘（Day 29-35）

> 日期：2026-10-07
> 主题：RAG 基础链路

## 本周成果

本周完成了 RAG（检索增强生成）的完整基础链路，从 Embedding 到 RAG 第一版，共 6 个实验：

| 日期 | 内容 | 关键产出 |
|---|---|---|
| Day 29 | Embedding | 本地模型 all-MiniLM-L6-v2 调通 + 缓存机制 |
| Day 30 | Similarity | Cosine/Euclidean 计算 + Top K 检索 |
| Day 31 | 向量库选型 | 自研 LocalVectorStore（JSON 持久化 + Cosine Top K） |
| Day 32 | Document 入库 | Markdown 解析 + Chunk 切分 + Embedding + 入库 |
| Day 33 | Retrieval | Query → Embedding → Top K 检索全链路 |
| Day 34 | RAG 第一版 | Question → Retrieval → Context → LLM → Answer |

## 核心链路图

```
Day 29 Embedding        ── 文本 → 向量
Day 30 Similarity       ── 向量间的相似度计算
Day 31 VectorStore      ── 向量的存储与查询基础设施
Day 32 Ingestion        ── 文档 → Chunk → 向量 → 入库
Day 33 Retrieval        ── 查询 → 向量 → Top K 召回
Day 34 RAG              ── 召回 + LLM 生成 → 带溯源的回答
```

## 关键决策

1. **Embedding 模型**：DeepSeek 无 embedding 端点 → 选用本地 `Xenova/all-MiniLM-L6-v2`（384 维，~80MB）。优点是零成本、离线可用；缺点是英文模型对中文细粒度区分弱（Vue2/Vue3 区分度不足）。后续 Day 44 换 `bge-small-zh`。
2. **向量库**：chromadb JS 客户端不支持嵌入式 + 无 Docker → 自研 `LocalVectorStore`（50 行代码模拟 Chroma 接口）。零依赖、可学习底层原理。Week 16 学 Docker 后切 Chroma Server。
3. **Chunk 策略**：固定长度 500 字符 + 50 overlap。经验起点，Day 37 做结构化切分（按 H1/H2/H3）。
4. **Top K**：取 3。K=1 漏召回，K=5 噪声多。LLM 能从 Top 3 中选出正确答案。

## 遇到的问题与解决

| 问题 | 原因 | 解决 |
|---|---|---|
| DeepSeek embedding 404 | DeepSeek 只有 chat 模型 | 换本地 all-MiniLM-L6-v2 |
| huggingface.co 下载超时 | 网络问题 | 用 hf-mirror.com 镜像 |
| chromadb JS 无嵌入式 | JS 客户端只支持远程 | 自研 LocalVectorStore |
| 中文语义区分弱 | 英文 embedding 模型 | 后续换 bge-small-zh |
| 代码中 `*` 被删除 | parseMarkdown 全局去 `*` | Day 37 修复：代码区原样保留 |

## 成本统计

| 项目 | 花费 |
|---|---|
| Embedding（Day 29-34） | ¥0（本地模型，缓存命中） |
| LLM（Day 34） | ≈¥0.005（4 次调用，3k tokens） |
| **本周总计** | **≈¥0.005** |

## 知识收获

### 技术栈
- `@xenova/transformers`：浏览器/Node.js 跑 HuggingFace 模型
- Embedding 缓存策略：text → number[] 持久化到 JSON
- 向量库核心原理：存储 (id, document, embedding, metadata) + 暴力 Cosine 搜索

### RAG 核心概念
- **Chunk**：检索的基本单位，太大平均化、太小缺上下文
- **Overlap**：防止语义被边界切断
- **Top K**：召回率与精确率的平衡点
- **Grounding**：RAG 的核心价值——不幻觉
- **溯源**：回答带来源，可验证

### 工程经验
- `env.allowLocalModels = true as any`（transformers.js TS 类型复杂）
- `{ pooling: "mean", normalize: true } as any`（normalize 与 String.prototype.normalize 冲突）
- Pipeline 输出需 `as Tensor` 后 `Array.from(output.data)`
- `distance = 1 - cosine`（Chroma 约定，越小越近）

## 下周计划（Day 36-42：企业知识库）

| 日期 | 内容 |
|---|---|
| Day 36 | 文档解析：PDF/Word/Markdown 统一解析 |
| Day 37 | Chunk 策略优化：按标题结构切分 + 修复 `*` Bug |
| Day 38 | Metadata 设计与过滤 |
| Day 39 | RAG UI：前端知识库问答界面 |
| Day 40 | 企业知识库集成 |
| Day 41 | 缓冲/选做 |
| Day 42 | 第 6 周周复盘 |

## 待改进项

1. **换中文 Embedding 模型**：bge-small-zh，解决 Vue2/Vue3 区分度问题
2. **修复 parseMarkdown**：代码区保留原始 `*`
3. **加 Rerank**：对 Top K 重新排序
4. **结构化 Chunk**：按 Markdown 标题切分
5. **加相似度阈值**：低于阈值直接返回"未找到"，不调 LLM
