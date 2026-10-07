/**
 * Day 36：文档解析（PDF / Word / Markdown 统一解析）
 *
 * 学习点：
 *   - 不同格式文档的解析方法
 *   - 统一解析接口：DocumentParser.parse(file) → { text, metadata }
 *   - 解析质量对比
 *
 * 实验设计：
 *   1. 生成 3 种格式的样例文档（内容相同：Vue3 响应式原理）
 *      - PDF（pdfkit 生成）
 *      - Word/docx（docx 生成）
 *      - Markdown（已存在）
 *   2. 用对应解析器解析：
 *      - PDF → pdf-parse
 *      - Word → mammoth
 *      - Markdown → 自研解析器（修复 * Bug）
 *   3. 输出解析结果，对比格式保留情况
 *
 * 运行：cd server && npx tsx src/experiments/day36-document-parser.ts
 */
import "../env";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createRequire } from "module";
import mammoth from "mammoth";
import PDFDocument from "pdfkit";
import { Document, Packer, Paragraph, TextRun } from "docx";

// pdf-parse v2 导出 PDFParse 类，ESM 中用 createRequire 加载 CJS 入口
const require = createRequire(import.meta.url);
const { PDFParse } = require("pdf-parse");

const DOCS_DIR = join(process.cwd(), "data", "docs");
const SAMPLE_TEXT = `Vue3 响应式原理
Vue3 使用 Proxy 替代 Vue2 的 Object.defineProperty。
Proxy 可以拦截对象的所有操作，包括属性新增、删除、数组索引修改。
因此 Vue3 无需 Vue.set 和 Vue.delete。
Vue3 组件使用 Composition API，通过 setup 函数组织逻辑。`;

// ---------------- 生成样例文档 ----------------

async function generateSamplePDF(): Promise<void> {
  const filePath = join(DOCS_DIR, "vue3-reactivity.pdf");
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const stream = writeFileSync(filePath, "");
    const writeStream = require("fs").createWriteStream(filePath);
    doc.pipe(writeStream);
    doc.fontSize(14).text(SAMPLE_TEXT, 50, 50);
    doc.end();
    writeStream.on("finish", resolve);
    writeStream.on("error", reject);
  });
}

async function generateSampleWord(): Promise<void> {
  const filePath = join(DOCS_DIR, "vue3-reactivity.docx");
  const lines = SAMPLE_TEXT.split("\n");
  const doc = new Document({
    sections: [{
      properties: {},
      children: lines.map((line) => new Paragraph({ children: [new TextRun(line)] })),
    }],
  });
  const buffer = await Packer.toBuffer(doc);
  writeFileSync(filePath, buffer);
}

// ---------------- 解析器 ----------------

interface ParsedDocument {
  type: string;
  text: string;
  charCount: number;
}

// Markdown 解析器（修复：代码区保留 *，只去非代码区的标记）
function parseMarkdown(md: string): string {
  // 先提取代码块，替换为占位符
  const codeBlocks: string[] = [];
  let text = md.replace(/```[\s\S]*?```/g, (match) => {
    const code = match.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
    codeBlocks.push(code);
    return `\x00CODE${codeBlocks.length - 1}\x00`;
  });
  // 去标题
  text = text.replace(/^#{1,6}\s+/gm, "");
  // 去列表标记
  text = text.replace(/^[-*]\s+/gm, "");
  text = text.replace(/^\d+\.\s+/gm, "");
  // 去加粗/斜体（此时代码区已被占位，不会误删代码中的 *）
  text = text.replace(/[*_]{1,3}/g, "");
  // 还原代码块
  text = text.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);
  // 合并空行
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

async function parsePDF(filePath: string): Promise<string> {
  const dataBuffer = readFileSync(filePath);
  const parser = new PDFParse({ data: dataBuffer });
  const result = await parser.getText();
  return result.text.trim();
}

async function parseWord(filePath: string): Promise<string> {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value.trim();
}

// 统一解析接口
async function parseDocument(filePath: string): Promise<ParsedDocument> {
  const ext = filePath.split(".").pop()!.toLowerCase();
  let text: string;
  switch (ext) {
    case "md":
      text = parseMarkdown(readFileSync(filePath, "utf-8"));
      break;
    case "pdf":
      text = await parsePDF(filePath);
      break;
    case "docx":
      text = await parseWord(filePath);
      break;
    default:
      throw new Error(`不支持的文件格式：.${ext}`);
  }
  return { type: ext, text, charCount: text.length };
}

// ---------------- 主实验 ----------------

async function main() {
  console.log("=== Day 36：文档解析 ===\n");

  if (!existsSync(DOCS_DIR)) mkdirSync(DOCS_DIR, { recursive: true });

  // 1. 生成样例文档
  console.log("生成样例文档...");
  await generateSamplePDF();
  await generateSampleWord();
  console.log("  ✅ vue3-reactivity.pdf");
  console.log("  ✅ vue3-reactivity.docx");
  console.log("  📄 vue3.md（已存在）\n");

  // 2. 解析三种格式
  const files = [
    join(DOCS_DIR, "vue3.md"),
    join(DOCS_DIR, "vue3-reactivity.pdf"),
    join(DOCS_DIR, "vue3-reactivity.docx"),
  ];

  console.log("=== 解析结果 ===\n");
  for (const file of files) {
    const result = await parseDocument(file);
    const fileName = file.split("\\").pop();
    console.log(`  📄 ${fileName} (${result.type})`);
    console.log(`     字符数：${result.charCount}`);
    console.log(`     内容预览：`);
    const preview = result.text.slice(0, 150).replace(/\n/g, " ");
    console.log(`     ${preview}...\n`);
  }

  // 3. 对比解析质量
  console.log("=== 解析质量对比 ===\n");
  console.log("  格式      | 代码保留 | 标题保留 | 格式标记 | 适用场景");
  console.log("  --------- | -------- | -------- | -------- | ----------------");
  console.log("  Markdown  | ✅ 完整  | ✅ 纯文本 | ✅ 已清除 | 技术文档首选");
  console.log("  PDF       | ✅ 完整  | ❌ 纯文本 | ✅ 已清除 | 扫描件/论文");
  console.log("  Word      | ✅ 完整  | ❌ 纯文本 | ✅ 已清除 | 企业文档");
  console.log("");
  console.log("  结论：统一接口将不同格式转为纯文本，下游 Chunk/Embedding 无需关心格式。");
  console.log("  Markdown 保留的结构信息最多，PDF/Word 的标题层级在解析后丢失。");
  console.log("  如需保留结构，需用带样式提取的解析器（如 pdfjs-dist、mammoth.extractRawText）。");
}

main().catch((e) => { console.error(e); process.exit(1); });
