# Day 39：RAG UI（知识库问答界面）

> 日期：2026-10-14

## 今日目标

- [x] 后端起 RAG 问答接口（问答 + 来源引用）
- [x] 后端补「知识库列表」与「文档上传」接口
- [x] 前端做出可用的知识库界面：文档列表 / 上传 / 问答 / 引用来源
- [x] 真实运行 + 浏览器端到端验证

计划要求（Day 41 RAG UI）：**文档上传 / 知识库列表 / 问答 / 引用来源** 四项齐全。

## 接口契约

| 方法 | 路径 | 入参 | 返回 |
|---|---|---|---|
| POST | `/api/rag` | `{ question, topK?, category? }` | `{ answer, sources: [{ file, heading, distance }] }` |
| POST | `/api/rag/ingest` | — | `{ count, files }` |
| GET | `/api/rag/documents` | — | `{ documents: [{ file, category, chunkCount, headings }] }` |
| POST | `/api/rag/documents` | `{ filename, content }` | `{ file, count }` |

上传实现选型：**前端用 `FileReader` 读成文本 → JSON 提交**，而不是 multipart。

- 好处：后端零新增依赖（不需要 multer/busboy），`.md/.txt` 这类文本类知识库文档完全够用。
- 代价：二进制文档（PDF/Word）读不成文本，这条链路暂时覆盖不到；且 JSON body 会整体进内存，需要把 `express.json` 默认的 100kb 上限提到 2mb。

## 真实运行结果

### 1. 入库 + 列表（`/api/rag/ingest` → `/api/rag/documents`）

```
INGEST: {"count":9,"files":["react.md","vue2.md","vue3.md"]}
DOCS:   react.md(category=react, 3 chunks) / vue2.md(vue,3) / vue3.md(vue,3)
```

注意 `data/docs` 目录里实际有 5 个文件（另有 `vue3-reactivity.docx`、`vue3-reactivity.pdf`），列表只显示 3 个——因为入库函数只吃 `.md`。**列表以向量库为数据源，反映的是"真正可检索的内容"，而不是目录里放了什么。**

### 2. 上传（`POST /api/rag/documents`）

上传一份新的 `团队前端规范.md`（两个 H2 小节）：

```
UPLOAD: {"file":"团队前端规范.md","count":11}
DOCS:   团队前端规范.md(category=other, 2 chunks, headings=[命名规范, 代码评审]) + 原 3 个文档
```

- chunk 数从 9 → 11，新文档切出 2 个 chunk，标题元数据正确带上。
- 文档的 H1（`# 团队前端规范`）没有单独成 chunk——它在下一个 H2 之前没有正文，被 flush 时按"空内容跳过"处理。这其实是正确行为：文档大标题不该占用一个检索位。

### 3. 对上传文档提问（`/api/rag`，`category=other`）

问题：「组件的命名规范是什么？合并 PR 有什么要求？」，返回：

```
ANSWER: 组件命名规范：组件文件使用 PascalCase… useUserList。[2]
        合并 PR 要求：所有 PR 至少一人 approve… 严禁直接推 main。[1]
SOURCES: [{"file":"团队前端规范.md","heading":"代码评审","distance":0.214},
          {"file":"团队前端规范.md","heading":"命名规范","distance":0.639}]
```

两个问题都答对，且引用编号 [1]/[2] 与来源列表一一对应。

### 4. 边界与安全

| 用例 | 输入 | 实际结果 |
|---|---|---|
| 空文件名 | `filename: "  "` | `HTTP 400 {"error":"filename 不能为空"}` |
| 空内容 | `content: "   "` | `HTTP 400 {"error":"content 不能为空"}` |
| 路径穿越 | `filename: "../../hack.md"` | 落盘为 `data/docs/hack.md`，`data/` 与上级目录均无越界文件 |

### 5. 浏览器端到端（7/7）

在 `http://localhost:5173` 实测：

1. 左侧「知识库」面板列出 react.md / vue2.md / vue3.md，各带分类标签与 chunk 数 3 ✅
2. 「+ 上传文档」「重建索引」按钮可见 ✅
3. Agent 勾选时 RAG 开关为灰色不可用；取消 Agent 后可勾选 RAG ✅
4. 勾选 RAG 后出现分类下拉框「全部 / Vue / React」，默认「全部」 ✅
5. 输入「Vue3 的响应式原理是什么？」回车发送 ✅
6. AI 气泡内有回答正文 + 「来源：」区块（vue3.md 响应式原理 0.456 / vue2.md 生命周期 0.497 / vue2.md 响应式原理 0.504）✅
7. 整页截图 ✅

## 分析与学习笔记

1. **上传后做的是"全量重建索引"**。实现上直接调 `ingestDocuments()` 清库重灌，简单且幂等；因为已有 chunk 的 embedding 命中本地缓存，重复文档不会重复计算，只有新 chunk 付一次 embedding 成本（本地模型，¥0）。代价是向量库全量重算 Top K、全量重写 JSON——文档上万后需要改成按文件增量（按 `metadata.file` 删旧 chunk + 只算新文件）。
2. **列表接口的真相源选择**。取向量库而不是 `docs` 目录，好处是"能列出的一定能检索到"；实测暴露了它的另一面：目录里的 PDF/Word 没入库就不显示（3 vs 5）。两种数据源各有盲区，后续要支持多格式就得把 `ingest` 的过滤条件放宽，让列表与目录一致。
3. **检索排序依然不可靠，但 LLM 补上了**。问句同时含"命名规范"和"PR 要求"，命中的两个 chunk 里"代码评审"（0.214）反而排在"命名规范"（0.639）前面。这和 Day 33/34 的结论一致：`all-MiniLM-L6-v2` 是英文模型，中文长查询的相似度排序噪声大。但模型仍能按语义把两个问题分别对应到 [2] 和 [1]，**RAG 的最终质量不只是检索器的质量**。
4. **主开关互斥**：Agent 与 RAG 不能同时开（Agent 会自己调工具，RAG 只查知识库）。前端用 `:disabled` 双向绑定实现，避免出现"开着 Agent 却指望它只查知识库"的语义混淆。
5. **上传是写操作，必须有边界**。文件名做了消毒（只留中英文/数字/`._-`，先取 basename 再去前导点），实测 `../../hack.md` 只能落到 `data/docs` 内；参数为空直接 400，不会拿空文档去重建整个索引。

## 概念卡片

- **文档上传（Ingestion API）**：把外部文档写入知识库目录并触发重新切分/向量化，是知识库唯一的内容入口。
- **全量重建 vs 增量索引**：全量重建 = 清空 + 重灌（简单幂等，靠 embedding 缓存省成本）；增量索引 = 只处理变更文件（规模大时必须）。
- **知识库列表（Document Registry）**：按文件聚合已入库 chunk 的元数据，给出文件、分类、chunk 数与标题清单。
- **引用来源（Citation）**：回答里标出 `[n]` 并给出对应的 file + heading + distance，让用户可以自行核对答案出处。
- **上传边界的路径消毒（Path Sanitization）**：对用户提交的文件名取 basename 并过滤特殊字符，防止 `../` 写出受限目录。

## 面试题

### Q1：上传文档为什么用 JSON 提交而不是 multipart/form-data？
A：因为这一版只收文本类知识库文档（`.md/.txt`），前端 `FileReader` 读成字符串后直接 JSON 提交，后端**零新增依赖**，也不用处理临时文件、字段顺序、流式解析这些 multipart 细节。实测 `express.json` 默认 100kb 限制成了隐性坑（一份稍大的 Markdown 就会 413），需要显式调到 2mb。什么时候该换 multipart？——要支持 PDF/Word 等二进制文档时（那类文件读不成文本），届时再引 multer/busboy + 服务端解析。

### Q2：上传之后为什么直接全量重建索引？什么时候必须换成增量？
A：全量重建（清库 + 重灌所有文档）实现最简单、天然幂等，且不会出现"旧 chunk 残留"。本例每次重建只处理 3~5 个文档、几十个 chunk，成本和时间都可忽略，重复文本还命中本地 embedding 缓存。该换增量的信号是：文档数量上百、单次重建耗时明显、或需要在线更新（重建期间知识库不可用）。增量做法是按文件维度删除——用 `metadata.file` 过滤删掉该文件的旧 chunk，再只对新文件算 embedding，代价是必须正确处理改名/删除/内容变更三种情况。

### Q3：知识库列表接口为什么取向量库而不是 `data/docs` 目录？
A：向量库才是"可检索内容"的真相源：它能直接给出 chunk 数和标题结构，这些信息在目录里没有；而且目录里放了文件但没入库的情况（解析失败的 PDF/docx）如果照目录显示，会误导用户以为能查到。实测正好印证：`data/docs` 有 5 个文件，列表只有 3 个 `.md`。反过来这个选择也有盲区——用户刚放进目录还没入库的文件不会出现在列表里，所以页面上额外提供了「重建索引」按钮，让用户手动对齐两者。
