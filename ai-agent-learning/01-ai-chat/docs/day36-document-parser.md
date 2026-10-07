# Day 36：文档解析（PDF / Word / Markdown 统一解析）

> 日期：2026-10-07

## 今日目标

- [x] 实现 PDF / Word / Markdown 三种格式的解析
- [x] 统一解析接口：`parseDocument(file)` → `{ type, text }`
- [x] 修复 Day 32 的 Markdown `*` Bug
- [x] 对比三种格式的解析质量

## 解析器实现

### 统一接口

```typescript
async function parseDocument(filePath: string): Promise<ParsedDocument> {
  const ext = filePath.split(".").pop()!.toLowerCase();
  switch (ext) {
    case "md":   return parseMarkdown(...);
    case "pdf":  return parsePDF(...);
    case "docx": return parseWord(...);
  }
}
```

### 各格式解析器

| 格式 | 库 | 方法 |
|---|---|---|
| Markdown | 自研 | 正则去标记（修复代码区 `*` 保留） |
| PDF | pdf-parse v2 | `new PDFParse({ data }).getText()` |
| Word | mammoth | `mammoth.extractRawText({ path })` |

### Markdown 解析 Bug 修复

**问题**：Day 32 的 `parseMarkdown` 用 `text.replace(/[*_]{1,3}/g, "")` 全局去除加粗/斜体标记，把代码中的乘法运算符 `*` 也删了（`count * 2` → `count  2`）。

**修复**：先把代码块提取为占位符 `\x00CODE{n}\x00`，去标记后再还原。代码区内的 `*` 原样保留。

## 实验结果

生成 3 种格式的同内容文档（Vue3 响应式原理），分别解析：

| 格式 | 字符数 | 中文 | 代码 | 结构 |
|---|---|---|---|---|
| Markdown | 650 | ✅ 正常 | ✅ 完整 | ✅ 标题保留（去 #） |
| PDF | 237 | ❌ 乱码 | — | — |
| Word | 173 | ✅ 正常 | ✅ 完整 | ❌ 标题丢失 |

### PDF 乱码原因

pdfkit 默认使用 Helvetica 字体，**不支持 CJK 字符**。生成的 PDF 中中文被编码为 Helvetica 不存在的字形，提取时出现乱码。

**解决方案**：生成 PDF 时需嵌入中文字体（如思源黑体）：
```javascript
doc.font("path/to/NotoSansSC-Regular.ttf").text("中文内容");
```
或者用支持中文的 PDF 生成库。**解析侧无需改动**——只要 PDF 生成时正确嵌入字体，pdf-parse 就能正确提取中文。

## 分析与学习笔记

1. **文档解析是 RAG 的第一道工序**：解析质量直接决定后续 Chunk 和 Embedding 的质量。Markdown 解析质量最高（结构信息保留好），Word 次之，PDF 最脆弱（依赖字体嵌入）。
2. **PDF 解析的两大坑**：(1) 字体不嵌入导致中文乱码；(2) 扫描版 PDF 是图片，需要 OCR。生产环境中 PDF 解析质量参差不齐，通常需要预处理（字体检查、OCR）。
3. **统一接口的价值**：下游 Chunk/Embedding 只关心纯文本，不关心来源格式。`parseDocument` 把格式差异屏蔽在上层。
4. **Markdown 是技术文档的最佳格式**：纯文本、结构清晰、解析简单、代码保真。企业知识库如果能让作者用 Markdown 写作，能省很多解析麻烦。

## 概念卡片

- **文档解析（Document Parsing）**：将 PDF/Word/Markdown 等格式转为纯文本的过程。
- **字体嵌入（Font Embedding）**：PDF 中可以嵌入字体文件，保证查看和提取时字形正确。不嵌入 CJK 字体会导致中文乱码。
- **OCR（Optical Character Recognition）**：光学字符识别，将图片中的文字转为文本。扫描版 PDF 需要 OCR。
- **mammoth**：Word 文档解析库，可提取纯文本或带样式的 HTML。
- **pdf-parse**：PDF 文本提取库，基于 pdf.js。

## 面试题

### Q1：为什么 PDF 提取的中文是乱码？
A：因为生成 PDF 时没有嵌入支持中文的字体。PDF 的文本提取依赖字体的编码映射（ToUnicode CMap）。如果 PDF 使用了不支持中文的字体（如 Helvetica），中文字符被映射到了错误的字形位置，提取时就会出现乱码。解决方案：生成 PDF 时嵌入中文字体（如思源黑体、微软雅黑），并确保字体包含正确的 ToUnicode 映射。如果是扫描版 PDF（图片），则需要 OCR。

### Q2：企业知识库中，Markdown、Word、PDF 各有什么优劣？
A：Markdown 最优——纯文本、结构清晰、解析简单、代码保真；Word 次之——mammoth 能提取纯文本但标题层级丢失；PDF 最差——可能乱码、可能是图片需 OCR、结构信息难保留。企业知识库的最佳实践是：尽量让文档以 Markdown 格式入库，Word/PDF 在上传时自动转 Markdown 或提取纯文本并尽量保留结构。

### Q3：统一解析接口的设计思路是什么？
A：用策略模式——根据文件扩展名选择对应的解析器，所有解析器返回统一结构 `{ type, text }`。下游（Chunk、Embedding）只依赖纯文本，不关心格式。新增格式时只需加一个 case 分支，符合开闭原则。生产环境可以用工厂模式 + 注册表，让解析器可插拔。

## 成本

| 项目 | 值 |
|---|---|
| 模型 | 无（纯解析，无 LLM/Embedding） |
| API 花费 | ¥0 |
| 新增依赖 | mammoth, pdf-parse, pdfkit, docx, @types/pdfkit |

## 明日目标

Day 37：Chunk 策略优化——按 Markdown 标题结构切分（H1/H2/H3），替代固定长度切分。
