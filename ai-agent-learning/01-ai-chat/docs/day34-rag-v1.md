# Day 34：RAG 第一版

> 日期：2026-10-07

## 今日目标

- [x] Question → Retrieval → Context → LLM → Answer 全链路打通
- [x] Prompt 工程：把检索结果喂给 LLM
- [x] 带溯源的回答：answer + sources
- [x] 验证"不幻觉"：知识库没有的问题能拒绝回答

## RAG 流程

```
用户提问 → Embedding → 向量检索 Top K → 拼装 Context → System Prompt + Question → LLM → Answer + Sources
```

## Prompt 设计

```
System:
  你是一个基于知识库的问答助手。请严格根据下面提供的参考资料回答用户的问题。
  如果参考资料中没有相关信息，请直接说"根据现有知识库无法回答该问题"，不要编造答案。
  回答时请注明引用的来源编号。
  
  参考资料：
  [1] (来源: vue2.md) ...
  [2] (来源: react.md) ...
  [3] (来源: vue3.md) ...

User:
  Vue3 的响应式原理是什么？
```

## 实验结果

### Q1：Vue3 的响应式原理是什么？

**回答**：Vue3 使用 Proxy 替代 Vue2 的 Object.defineProperty，可以拦截对象的所有操作（属性新增、删除、数组索引修改），无需 Vue.set/Vue.delete。[3]

**来源**：vue2.md#1, react.md#1, vue3.md#1

✅ 即使检索时 vue3 排第 3，LLM 仍正确识别 vue3 为相关来源并给出准确回答。

### Q2：React 怎么管理状态？

**回答**：React 采用单向数据流，状态通过 props 向下传递，事件回调向上传递。复杂状态用 Context 或 Redux/Zustand。更新状态必须用 setState，不可直接修改。[2]

**来源**：react.md#1, react.md#0, vue2.md#1

✅ 准确回答。

### Q3：Vue2 组件怎么定义？

**回答**：Vue2 使用 Options API，包含 data、methods、computed、watch、props 等选项。[2]（附带代码示例）

**来源**：vue2.md#1, vue2.md#0, vue3.md#0

✅ 准确回答，且 LLM 自动纠正了 Markdown 解析导致的 `count * 2` → `count  2` 的代码损坏。

### Q4：今天天气怎么样？

**回答**：根据现有知识库无法回答该问题。知识库内容是关于 React 和 Vue2 的前端开发知识，不包含天气信息。

**来源**：react.md#1, vue2.md#1, react.md#0

✅ **正确拒绝回答，无幻觉！** 这是 RAG 的核心价值：模型被检索结果"约束"，不会编造答案。

## 分析与学习笔记

1. **RAG 的核心价值是"不幻觉"**：Q4 证明了这一点。没有 RAG 时，LLM 会编造天气；有了 RAG，LLM 看到上下文里只有前端知识，就老实说"无法回答"。System Prompt 中"不要编造答案"的指令 + 检索上下文的约束，共同实现了 grounding。
2. **LLM 可以弥补检索的不足**：Q1 中检索把 vue3 排第 3，但 LLM 读完所有 context 后正确选择了 vue3 的内容。这说明 Top K 取 3~5 是合理的——即使排序不完美，LLM 能从 K 个候选中选出正确的。
3. **Markdown 解析的 Bug**：Day 32 的 `parseMarkdown` 用 `text.replace(/[*_]{1,3}/g, "")` 去除加粗标记，但这也把代码里的 `*`（乘法运算符）删掉了，导致 `count * 2` 变成 `count  2`。LLM 很聪明地纠正了，但这是个 bug。**修复方向**：只在非代码区域去除 Markdown 标记，代码内容原样保留。Day 37 做结构化切分时会修复。
4. **溯源的重要性**：回答中标注 [1][2][3]，让用户能验证答案来源。生产环境中还需要显示具体的文件名和段落。

## 概念卡片

- **RAG（Retrieval-Augmented Generation）**：检索增强生成。先从知识库检索相关文档，再让 LLM 基于检索结果生成回答。核心价值是 grounding（不幻觉）和可溯源。
- **Grounding**：模型的回答被外部知识"锚定"，不依赖模型自身的（可能过时或错误的）参数知识。
- **Context Window**：LLM 能处理的最大 token 数。RAG 的检索结果 + 问题 + 回答都要放进 context window，所以 Top K 不能太大。
- **溯源（Citation）**：回答中标注信息来源，让用户可以验证。RAG 的关键特性。

## 面试题

### Q1：RAG 为什么能减少幻觉？
A：因为 LLM 的回答被检索到的上下文"约束"了。System Prompt 明确要求"只根据参考资料回答，没有就说无法回答"，加上上下文中确实有相关内容，LLM 就不需要依赖自身参数知识（可能过时或错误）来编造。本质上是把生成任务从"开放式问答"变成了"阅读理解"——LLM 只需要从给定文本中找答案，难度大幅降低。但 RAG 不能完全消除幻觉，如果检索到的内容本身有误，或 LLM 过度解读，仍可能出错。

### Q2：RAG 中的 System Prompt 应该怎么写？
A：三个关键点：(1) 明确角色——"你是基于知识库的问答助手"；(2) 明确约束——"只根据参考资料回答，没有就说无法回答，不要编造"；(3) 明确格式——"回答时注明引用来源编号"。参考资料要编号 [1][2][3]，方便 LLM 引用。不要给太多花哨的指令，简单明确最重要。后续 Day 43 会做 Prompt 优化实验。

### Q3：如果检索结果里没有答案，LLM 会怎么表现？
A：取决于 Prompt 的约束强度。如果 Prompt 明确说"没有就说无法回答"，LLM 通常会遵守（如 Q4）。但如果约束不够强，LLM 可能会基于自身参数知识回答，造成幻觉。生产环境可以加一层兜底：检索结果的最高相似度低于阈值时，直接返回"未找到相关信息"，不调用 LLM。这比依赖 LLM 自觉更可靠。

## 成本

| 项目 | 值 |
|---|---|
| 模型 | deepseek-chat（LLM）+ all-MiniLM-L6-v2（Embedding） |
| API 花费 | ≈¥0.005（4 次 LLM 调用，约 3000 tokens） |
| Embedding | 4 次，全部命中缓存 |

## 明日目标

Day 35：第 5 周周复盘，总结 RAG 基础链路（Embedding → Similarity → VectorStore → Ingestion → Retrieval → RAG）。
