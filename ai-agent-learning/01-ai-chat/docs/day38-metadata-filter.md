# Day 38：Metadata 设计与过滤

> 日期：2026-10-07

## 今日目标

- [x] 为 Chunk 设计丰富的 Metadata
- [x] 实现基于 Metadata 的过滤检索
- [x] 验证过滤 + 向量检索的组合效果

## Metadata 设计

每个 chunk 携带以下 metadata：

```json
{
  "file": "vue3.md",
  "heading": "响应式原理",
  "level": 2,
  "category": "vue",
  "tags": ["vue3", "composition-api", "proxy"]
}
```

| 字段 | 说明 | 用途 |
|---|---|---|
| file | 来源文件名 | 溯源 |
| heading | 所属标题 | 显示来源位置 |
| level | 标题层级（H2=2） | 结构化展示 |
| category | 分类（vue/react） | 粗粒度过滤 |
| tags | 标签数组 | 细粒度过滤 |

## 过滤检索实现

```typescript
query(embedding, nResults, filter?: MetadataFilter) {
  let candidates = this.items;
  if (filter) {
    candidates = candidates.filter((item) => {
      for (const [key, value] of Object.entries(filter)) {
        // 等值匹配（category, file, heading）
        // tags 用包含匹配（任一 tag 命中即通过）
      }
      return true;
    });
  }
  // 过滤后再做向量相似度排序
  const scored = candidates.map(...).sort(...);
  return scored.slice(0, nResults);
}
```

**关键**：先过滤再排序，减少计算量并提升精准度。

## 实验结果

查询："响应式原理是什么？"

| 过滤条件 | Top 3 结果 |
|---|---|
| 无过滤 | react 渲染机制, react 状态管理, vue2 生命周期 |
| category=vue | vue2 生命周期, vue3 生命周期, **vue3 响应式原理** |
| category=react | react 渲染机制, react 状态管理, react 组件定义 |
| tags 含 proxy | vue3 生命周期, **vue3 响应式原理**, vue3 组件定义 |

## 分析与学习笔记

1. **过滤的价值**：无过滤时 "响应式原理" 的 Top1 是 react 渲染机制（英文模型区分度弱）。加 `category=vue` 过滤后，结果全部来自 vue 文档，vue3 响应式原理被召回。过滤弥补了 embedding 模型的不足。
2. **两级过滤策略**：category 做粗粒度（文档属于哪个大类），tags 做细粒度（具体技术点）。用户问"Vue3 响应式"时，可以同时用 `category=vue` + `tags=["proxy"]` 精准定位。
3. **过滤条件的来源**：可以是用户明确指定（"只看 Vue 的文档"），也可以是 LLM 从问题中提取（"Vue3 响应式" → category=vue, tags=[vue3, proxy]）。后续 Day 39 的 RAG UI 可以让用户选择分类。
4. **Chroma 原生支持 metadata 过滤**：Chroma 的 `query` 方法支持 `where` 参数做 metadata 过滤，语法类似 MongoDB。我们的 LocalVectorStore 实现了简化版，后续切 Chroma 时可直接用原生 `where`。

## 概念卡片

- **Metadata Filter**：在向量检索前，先用 metadata 条件过滤候选集，缩小搜索范围。
- **Category**：文档的粗粒度分类，用于大范围过滤。
- **Tags**：文档的细粒度标签，用于精准定位。
- **Where 条件**：Chroma/pgvector 中用于 metadata 过滤的查询语法，类似 `{ "category": "vue" }`。
- **Hybrid Search**：结合关键词检索（BM25）和向量检索的混合搜索，比单一向量检索更精准。

## 面试题

### Q1：Metadata 过滤和向量检索哪个先执行？
A：先过滤再检索。原因：(1) 过滤减少候选集大小，向量计算量降低；(2) 过滤是精确匹配（O(n)），向量检索是相似度计算（O(n*d)），先过滤更高效；(3) 过滤保证结果一定满足条件，避免返回不相关的高相似度结果。Chroma 的 `query(where={...})` 内部就是先按 where 过滤再做向量搜索。

### Q2：什么时候用 category，什么时候用 tags？
A：category 是互斥的粗分类（一个文档只能属于一个 category），用于大范围过滤，如"只看 Vue 文档"。tags 是多值的细标签（一个文档可有多个 tags），用于精准定位，如"只看含 proxy 的 chunk"。两者结合：先用 category 缩小范围，再用 tags 精准定位。设计时 category 数量要少（5-10 个），tags 可以多但要有控制（避免 tag 爆炸）。

### Q3：如何从用户问题中自动提取过滤条件？
A：用 LLM 做"查询理解"——把用户问题发给 LLM，让它输出结构化的过滤条件。例如：
```
用户：Vue3 的响应式原理是什么？
LLM 输出：{ "category": "vue", "tags": ["vue3", "proxy"] }
```
然后用这个条件去过滤检索。这是"查询改写"的一种，能显著提升检索精准度。但要注意 LLM 可能提取错误，所以过滤条件最好让用户可编辑或可关闭。

## 成本

| 项目 | 值 |
|---|---|
| 模型 | Xenova/all-MiniLM-L6-v2（本地） |
| API 花费 | ¥0 |
| Embedding 次数 | 9 次（全部命中缓存） |

## 明日目标

Day 39：RAG UI——前端知识库问答界面，集成检索 + LLM 生成 + 来源展示。
