# Day 33：Retrieval

> 日期：2026-10-07

## 今日目标

- [x] Query → Embedding → Vector Search → Top K 全链路打通
- [x] Top K 参数对比实验
- [x] 召回结果分析

## 检索流程

```
用户查询 → Embedding → 与库中所有 chunk 计算 Cosine Distance → 排序取 Top K
```

## 实验结果

### Top 3 检索

| 查询 | Top 1 | Top 2 | Top 3 | Top1 命中 |
|---|---|---|---|---|
| Vue3 的响应式原理 | vue2 (0.446) | react (0.455) | **vue3** (0.513) | ❌ |
| Vue2 和 Vue3 响应式区别 | vue2 (0.438) | **vue3** (0.530) | **vue3** (0.549) | ❌ |
| React 怎么管理状态 | **react** (0.325) | **react** (0.576) | vue2 (0.632) | ✅ |
| Vue2 组件怎么定义 | **vue2** (0.415) | **vue2** (0.417) | vue3 (0.434) | ✅ |

### Top K 对比（查询：Vue3 的响应式原理）

| K | 召回文件 | 包含 vue3 |
|---|---|---|
| 1 | vue2 | ❌ |
| 3 | vue2, react, vue3 | ✅ |
| 5 | vue2, react, vue3, vue3, vue2 | ✅ |

## 分析与学习笔记

1. **召回率 vs 精确率的权衡**：K=1 时精确但容易漏召回（Q1 漏了 vue3）；K=3 时 vue3 被召回，但带进来 react 噪声。K 越大召回率越高、精确率越低。生产环境通常 K=3~5。
2. **英文模型对中文细粒度区分弱**：Q1 问 Vue3 响应式，Top1 却是 vue2 的响应式 chunk。因为"响应式"这个关键词在 vue2/vue3 两个 chunk 中都出现，英文 embedding 模型无法区分"Vue2 的响应式"和"Vue3 的响应式"。这再次印证 Day 30 的结论：需要换中文 embedding 模型（如 bge-small-zh）。
3. **distance 差距小说明区分度低**：Q1 中 vue2(0.446) 和 vue3(0.513) 差距仅 0.067，说明模型认为两者与查询的相似度接近。换中文模型后这个差距应该拉大。
4. **Top K 不是越大越好**：K=5 时 vue2 出现两次（两个 chunk），说明同文档的多个 chunk 被召回，浪费 LLM context。后续可以加去重（同文档只取最高分的 chunk）或 Rerank。

## 概念卡片

- **Retrieval（检索）**：根据查询从向量库中找出最相关的 Top K 个文档的过程。
- **Top K**：返回最相关的 K 个结果。K 是召回率和精确率的平衡点。
- **Recall（召回率）**：相关文档中被检索到的比例。K 越大召回率越高。
- **Precision（精确率）**：检索到的文档中相关的比例。K 越小精确率越高。
- **Rerank（重排序）**：对召回的 Top K 用更强的模型重新排序，提升精确率（Day 44）。

## 面试题

### Q1：RAG 中 Top K 取多少合适？
A：没有标准答案，取决于数据量和场景。经验值 K=3~5。K 太小会漏召回（相关文档不在 Top K 里），K 太大会引入噪声并浪费 LLM context window。正确做法是用评测集（Day 43 会做）系统测试不同 K 值的召回率和精确率，选最优值。另外可以用 Rerank 模型对 Top K 重新排序，这样可以取较大的 K（如 20）保证召回率，再用 Rerank 选前 3~5 个保证精确率。

### Q2：为什么 Q1 问 Vue3 响应式，Top1 却是 vue2？
A：两个原因：(1) 用的是英文 embedding 模型 all-MiniLM-L6-v2，对中文细粒度语义区分弱，"Vue2 响应式"和"Vue3 响应式"在向量空间中距离很近；(2) vue2 的 chunk 中"响应式"关键词出现更集中（整段都在讲 Object.defineProperty 响应式原理），而 vue3 的 chunk 中响应式只是其中一部分。换中文 embedding 模型（如 bge-small-zh）后，Vue2 和 Vue3 的区分度会提升。这也是 Day 30/31 中 Q1/Q2 偏差的同一根本原因。

### Q3：检索和搜索引擎有什么区别？
A：传统搜索引擎（如 Elasticsearch）基于关键词匹配（BM25），只能命中包含相同词的文档；向量检索基于语义相似度，可以命中用词不同但意思相近的文档（如"前端框架"能匹配到"React/Vue"）。现代 RAG 通常用 Hybrid Search（关键词 + 向量）结合两者优势，再用 Rerank 提升精确率。

## 成本

| 项目 | 值 |
|---|---|
| 模型 | Xenova/all-MiniLM-L6-v2（本地） |
| API 花费 | ¥0 |
| Embedding 次数 | 4 次查询（全部命中缓存） |

## 明日目标

Day 34：RAG 第一版 —— Question → Retrieval → Context → LLM → Answer，把检索结果喂给 LLM 生成回答。
