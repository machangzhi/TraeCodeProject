# Day 31：向量库选型 + Chroma 本地环境

> 日期：2026-10-07

## 今日目标

- [x] 向量库选型（Chroma vs pgvector）
- [x] 本地向量存储能写入/查询成功
- [x] Docker 迷你技能文档化
- [x] 数据持久化验证

## 选型决策

| 方案 | 运维成本 | 适用场景 | 本项目选择 |
|---|---|---|---|
| LocalVectorStore（自研） | 零运维 | 学习/原型/小规模 | ✅ 当前使用 |
| Chroma Embedded | 零运维 | Python 生态 | ❌ JS 客户端不支持 |
| Chroma Server | 需 Docker | 中等规模 | 🔜 Week 16 切换 |
| pgvector | 需 PG+Docker | 大规模 | 🔜 选做迁移项 |

**决策理由**：chromadb JS 客户端仅支持连接远程服务器，不支持嵌入式持久化；当前环境无 Docker，无法起 Chroma Server。因此自研 LocalVectorStore（JSON 持久化 + Cosine Top K），零依赖、可学习向量库底层原理。后续 Docker 就绪后可平滑切换到 Chroma Server。

## LocalVectorStore 实现

核心接口（模拟 Chroma）：

```typescript
class LocalVectorStore {
  add(items: StoreItem[]): void          // 写入文档（id 去重）
  count(): number                         // 文档数
  query(embedding, nResults): Result      // Top K 语义检索
  clear(): void                           // 清空
}
```

- 存储：内存数组 + JSON 文件持久化（`data/vector-store.json`）
- 相似度：Cosine，query 返回 distance = 1 - cosine（越小越近，与 Chroma 一致）

## 实验结果

### 写入与查询

6 条文档（Vue2/Vue3/React/天气/美食/体育）写入成功。

| 查询 | Top 3 | 说明 |
|---|---|---|
| Vue3 响应式原理 | cooking(0.499) > vue3(0.500) > sports | vue3 排第 2，与 cooking 仅差 0.001（模型限制） |
| React 管理状态 | react(0.464) > sports(0.468) > cooking | ✅ react 排第 1 |
| 怎么做出好吃的菜 | sports(0.406) > cooking(0.442) > weather | cooking 排第 2，sports 误排第 1 |

查询偏差与 Day 30 一致：all-MiniLM-L6-v2 英文模型对中文细粒度语义区分有限。**向量存储本身工作正常**。

### 持久化验证

新建 LocalVectorStore 实例读取同一文件，文档数 = 6 ✅

## 分析与学习笔记

1. **向量库的本质**：就是一个存储 (id, document, embedding, metadata) 的数据库，查询时对 query embedding 与所有文档 embedding 计算相似度，取 Top K。Chroma/pgvector 在底层做的是同样的事，只是加了索引（HNSW/IVF）加速大规模检索。
2. **distance = 1 - cosine**：Chroma 返回的 distance 不是欧氏距离，而是 1 - cosine_similarity。这样越小越相似，与欧氏距离的直觉一致。归一化后，distance 范围 [0, 2]。
3. **JS 生态的局限**：chromadb 的 Python 客户端支持嵌入式持久化（PersistentClient），但 JS 客户端只支持连接远程服务器。这是选择自研 LocalVectorStore 的直接原因。
4. **Docker 是向量库的前置依赖**：Chroma Server、pgvector 都需要 Docker。Week 16 学 Docker 后才能切换到生产级向量库。在此之前 LocalVectorStore 足够跑通 RAG 全链路。

## 概念卡片

- **向量库（Vector Database）**：专门存储和检索高维向量的数据库，核心操作是相似度搜索（Top K）。
- **Cosine Distance**：1 - Cosine Similarity，范围 [0, 2]，越小越相似。Chroma 默认使用。
- **持久化（Persistence）**：将内存数据写入磁盘，重启后不丢失。LocalVectorStore 用 JSON 文件实现。
- **HNSW 索引**：近似最近邻搜索算法，向量库用它加速大规模检索（百万级以上）。小规模数据暴力搜索即可。
- **Embedded vs Client-Server**：嵌入式向量库在应用进程内运行（零运维），Client-Server 模式需独立部署服务端。

## 面试题

### Q1：向量库和普通数据库有什么区别？
A：普通数据库按精确匹配或范围查询（如 WHERE id = 1），向量库按相似度查询（如"找与这个向量最接近的 K 个"）。向量库的核心是近似最近邻（ANN）搜索，通过 HNSW/IVF 等索引在百万级数据上做到毫秒级召回。小规模数据（如本项目的 6 条）不需要索引，暴力计算余弦相似度即可。

### Q2：Chroma 返回的 distance 是欧氏距离吗？
A：不是。Chroma 默认返回的是 cosine distance = 1 - cosine_similarity，范围 [0, 2]，越小越相似。只有在创建集合时指定 `distance: "l2"` 才会用欧氏距离。语义检索场景下 cosine distance 更常用，因为 embedding 通常已归一化，cosine 只反映方向差异。

### Q3：为什么不直接用 Chroma 而要自己实现 LocalVectorStore？
A：因为 chromadb 的 JavaScript 客户端只支持连接远程 Chroma Server，不支持嵌入式持久化（Python 客户端支持）。当前环境没有 Docker，无法起 Chroma Server。LocalVectorStore 用 50 行代码实现了 Chroma 的核心接口（add/query/count/persistence），零依赖、零运维，足够跑通 RAG 全链路。后续 Docker 就绪后可平滑切换。

## 成本

| 项目 | 值 |
|---|---|
| 模型 | Xenova/all-MiniLM-L6-v2（本地） |
| API 花费 | ¥0 |
| 额外计算 | 6 文档 + 3 查询 = 9 次 embedding（全部命中缓存） |

## 明日目标

Day 32：Document 入库 —— Markdown → Chunk → Embedding → Vector DB，跑通文档入库全流程。
