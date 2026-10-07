# Day 32：Document 入库

> 日期：2026-10-07

## 今日目标

- [x] Markdown 解析（提取纯文本）
- [x] Chunk 切分（固定长度 + Overlap）
- [x] Embedding 生成
- [x] 写入向量库
- [x] 入库统计

## 入库流程

```
Markdown 文件 → 解析纯文本 → Chunk 切分 → Embedding → 写入 VectorStore
```

## 实现细节

### 1. Markdown 解析

```
去除代码块标记（保留代码内容）
→ 去除标题 # 
→ 去除列表标记 - * 1.
→ 去除加粗斜体标记 * _
→ 合并多余空行
```

### 2. Chunk 策略

| 参数 | 值 | 说明 |
|---|---|---|
| CHUNK_SIZE | 500 字符 | 每个 chunk 的最大长度 |
| CHUNK_OVERLAP | 50 字符 | 相邻 chunk 重叠，防止语义被切断 |

切分算法：从文本开头按 CHUNK_SIZE 滑动窗口，每步后退 OVERLAP 字符。

### 3. Metadata

每个 chunk 附带 metadata：
```json
{ "file": "vue2.md", "chunkIndex": 0, "totalChunks": 2 }
```

## 入库结果

| 文件 | 原文字符 | 解析后字符 | Chunk 数 |
|---|---|---|---|
| react.md | 586 | 555 | 2 |
| vue2.md | 673 | 642 | 2 |
| vue3.md | 680 | 649 | 2 |
| **合计** | **1939** | **1846** | **6** |

### Chunk 预览

| ID | 内容预览 |
|---|---|
| react.md#0 | React 组件开发规范 组件定义 React 使用函数组件和 Hooks... |
| react.md#1 | 不可直接修改。渲染机制 React 通过虚拟 DOM diff 实现... |
| vue2.md#0 | Vue2 组件开发规范 组件定义 Vue2 组件使用 Options API... |
| vue2.md#1 | 收集依赖，被修改时触发更新。这种方式的局限性... |
| vue3.md#0 | Vue3 组件开发规范 组件定义 Vue3 推荐使用 Composition API... |
| vue3.md#1 | Vue2 的 Object.defineProperty，Proxy 可以直接拦截... |

## 分析与学习笔记

1. **Chunk 是 RAG 质量的第一道关卡**：切得太大，单个 chunk 含多个主题，embedding 会"平均化"丢失重点；切得太小，上下文不足，语义不完整。500 字符 + 50 overlap 是经验起点，后续 Day 37 会实验不同 size。
2. **Overlap 的作用**：防止一个完整语义被切在两个 chunk 的边界。比如"Vue2 的响应式基于 Object.defineProperty"如果被切断，前半 chunk 只有"Vue2 的响应式基于"，后半只有"Object.defineProperty"，embedding 都会变差。Overlap 让边界信息在两个 chunk 中各出现一次。
3. **Markdown 解析要保留代码内容**：代码块是技术文档的核心，不能丢弃。只去掉 ``` 标记，保留代码本身。
4. **Metadata 是溯源的关键**：RAG 回答时需要告诉用户"答案来自哪个文件的哪个部分"，靠 metadata 里的 file + chunkIndex。

## 概念卡片

- **Chunk**：将长文档切成的小段文本，是 embedding 和检索的基本单位。
- **Overlap**：相邻 chunk 的重叠部分，保证边界语义不丢失。
- **Metadata**：chunk 的附加信息（来源文件、位置等），用于溯源和过滤。
- **Markdown 解析**：将 Markdown 标记语言转为纯文本，去除格式符号但保留内容。

## 面试题

### Q1：为什么要把文档切成 Chunk 而不是整篇 embedding？
A：三个原因：(1) 整篇文档太长，embedding 模型有最大输入长度限制（all-MiniLM-L6-v2 是 256 token）；(2) 整篇 embedding 会"平均化"所有主题，检索时无法精确定位到相关段落；(3) 返回给 LLM 的上下文需要精确，整篇文档太长会浪费 token 并引入噪声。Chunk 让检索粒度更细、更精准。

### Q2：Overlap 为什么重要？
A：因为固定长度切分会把完整语义切断在边界。比如"Vue2 的响应式基于 Object.defineProperty"被切成"Vue2 的响应式基于"和"Object.defineProperty"，两个 chunk 都不完整。Overlap 让边界附近的文本在两个 chunk 中各出现一次，保证至少有一个 chunk 包含完整语义。Overlap 太小防不住切断，太大会浪费存储和计算，通常取 chunk size 的 10%–20%。

### Q3：Markdown 解析时为什么保留代码内容而不是删除？
A：技术文档中代码是核心信息（如"Vue2 用 Object.defineProperty，Vue3 用 Proxy"）。删除代码会丢失关键语义，导致检索时无法命中。正确做法是只去掉 ``` 标记和语言标识，保留代码本身。后续 Day 38 会做按 H1/H2/H3 结构切分，比固定长度更合理。

## 成本

| 项目 | 值 |
|---|---|
| 模型 | Xenova/all-MiniLM-L6-v2（本地） |
| API 花费 | ¥0 |
| Embedding 次数 | 6 次（全部命中缓存） |

## 明日目标

Day 33：Retrieval —— Query → Embedding → Vector Search → Top K，验证从向量库召回相关文档。
