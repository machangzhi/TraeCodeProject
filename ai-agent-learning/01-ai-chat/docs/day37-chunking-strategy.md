# Day 37：Chunk 策略优化（按标题结构切分）

> 日期：2026-10-07

## 今日目标

- [x] 实现按 Markdown 标题（H1/H2/H3）结构化切分
- [x] 对比固定长度切分 vs 结构化切分
- [x] 超长 section 的二次切分
- [x] Chunk 携带标题路径 metadata

## 两种切分策略

### 方案 1：固定长度切分（Day 32）

```
text.slice(0, 500) → chunk 0
text.slice(450, 950) → chunk 1  (50 overlap)
...
```

### 方案 2：按标题结构化切分

```
# H1 标题
## H2 组件定义     → chunk 0
## H2 响应式原理   → chunk 1
## H2 生命周期     → chunk 2
```

对超长 section（>800 字符）再做固定长度二次切分。

## 实验结果

以 `vue3.md`（680 字符）为例：

| 指标 | 固定长度（500+50） | 结构化（H2 + 800 上限） |
|---|---|---|
| Chunk 数 | 2 | 3 |
| 边界 | 任意字符位置 | 标题分隔处 |
| 语义完整性 | ❌ chunk 0 混合了"组件定义"和"响应式原理"开头 | ✅ 每个 chunk 对应一个 H2 节 |
| Metadata | file + chunkIndex | file + heading + level |

### 结构化 Chunk 详情

| Chunk | 标题 | 字符数 | 内容 |
|---|---|---|---|
| 0 | 组件定义 | 418 | Composition API、setup、ref/reactive |
| 1 | 响应式原理 | 112 | Proxy vs Object.defineProperty |
| 2 | 生命周期 | 102 | onMounted 等改名后的生命周期 |

## 分析与学习笔记

1. **结构化切分的核心优势：语义边界 = chunk 边界**。固定长度切分可能把"Vue3 的响应式基于 Proxy"切成"Vue3 的响应式基"和"于 Proxy"，两个 chunk 都不完整。结构化切分按标题切，保证每个 chunk 是一个完整的语义单元。
2. **标题路径是高价值 metadata**。chunk 携带 `heading: "响应式原理"` 后，检索时可以：(1) 在结果中显示来源标题；(2) 用标题做粗粒度过滤；(3) 让 LLM 回答时引用更精确。
3. **递归切分策略**：先按标题切，section 太长再按固定长度切。这是 LangChain 的 `MarkdownHeaderTextSplitter` + `RecursiveCharacterTextSplitter` 的思路。
4. **切分粒度的权衡**：切得太粗（整篇一个 chunk）检索精度低；切得太细（每段一个 chunk）上下文不足。按 H2 切是经验上的甜点——既不太粗也不太细。

## 概念卡片

- **结构化切分（Structured Chunking）**：按文档的逻辑结构（标题、段落、列表）切分，而非固定长度。
- **递归字符切分（Recursive Character Splitting）**：优先按分隔符切分（如 `\n## `），不够再按下一级分隔符（如 `\n### `），最后才按字符数切。
- **标题路径（Heading Path）**：chunk 所属的标题层级信息，如 `H1 > H2 > H3`，用于溯源和过滤。
- **Semantic Chunking**：用语义相似性决定切分点（相邻句子 embedding 相似度低的地方切），更高级但计算量大。

## 面试题

### Q1：固定长度切分和结构化切分哪个好？
A：结构化切分更好，因为 chunk 边界与语义边界一致。固定长度切分可能把一个完整的句子或段落切成两半，导致两个 chunk 的 embedding 都不准确。结构化切分按标题/段落切，每个 chunk 是完整的语义单元。最佳实践是递归切分：先按标题切，section 太长再按段落切，最后才按字符数切（LangChain 的 RecursiveCharacterTextSplitter 就是这个思路）。

### Q2：Chunk 大小怎么选？
A：没有统一答案，取决于：(1) embedding 模型的最大输入长度（all-MiniLM-L6-v2 是 256 token）；(2) 文档的结构（有标题的按标题切）；(3) 检索场景（精确问答切细一点，概览类切粗一点）。经验值：中文 200-500 字一个 chunk，overlap 取 10%-20%。最终要用评测集（Day 43）系统测试。

### Q3：什么是 Semantic Chunking？
A：用语义相似度决定切分点的方法。先把文档切成句子，计算相邻句子的 embedding 相似度，在相似度低的地方（语义转折）切分。优点是切分点更符合语义；缺点是计算量大（每句都要 embedding），且对 embedding 模型质量敏感。是比结构化切分更高级的方案，适合对质量要求高的场景。

## 成本

| 项目 | 值 |
|---|---|
| 模型 | 无（纯切分逻辑） |
| API 花费 | ¥0 |

## 明日目标

Day 38：Metadata 设计与过滤——为 chunk 设计丰富的 metadata，并实现基于 metadata 的过滤检索。
