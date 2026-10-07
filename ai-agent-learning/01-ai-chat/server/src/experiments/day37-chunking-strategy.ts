/**
 * Day 37：Chunk 策略优化
 *
 * 学习点：
 *   - 按标题结构切分（H1/H2/H3）vs 固定长度切分
 *   - 结构化 Chunk 的优势：语义完整、边界清晰
 *   - 递归切分：大 section 再按固定长度二次切分
 *
 * 实验设计：
 *   1. 用一个含多级标题的 Markdown 文档
 *   2. 按 H2 切分（每个 H2 及其内容为一个 chunk）
 *   3. 对超长 section 再按固定长度二次切分（带 overlap）
 *   4. 对比结构化切分 vs 固定长度切分的 chunk 质量
 *
 * 运行：cd server && npx tsx src/experiments/day37-chunking-strategy.ts
 */
import "../env";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const DOCS_DIR = join(process.cwd(), "data", "docs");

// 修复版 Markdown 解析（代码区保留 *）
function parseMarkdown(md: string): string {
  const codeBlocks: string[] = [];
  let text = md.replace(/```[\s\S]*?```/g, (match) => {
    const code = match.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
    codeBlocks.push(code);
    return `\x00CODE${codeBlocks.length - 1}\x00`;
  });
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^[-*]\s+/gm, "");
  text = text.replace(/^\d+\.\s+/gm, "");
  text = text.replace(/[*_]{1,3}/g, "");
  text = text.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

// ---------------- 固定长度切分（Day 32 方案） ----------------

function chunkByFixedLength(text: string, size: number = 500, overlap: number = 50): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = end - overlap;
  }
  return chunks.filter((c) => c.length > 0);
}

// ---------------- 结构化切分（按标题） ----------------

interface StructuredChunk {
  heading: string;   // 标题路径，如 "Vue3 组件开发规范 > 响应式原理"
  content: string;   // 该 section 的纯文本
  level: number;     // 标题层级
}

function chunkByHeadings(md: string, maxChunkSize: number = 800): StructuredChunk[] {
  const lines = md.split("\n");
  const sections: StructuredChunk[] = [];
  let currentHeading = "";
  let currentLevel = 0;
  let currentContent: string[] = [];

  const flush = () => {
    if (currentContent.length > 0) {
      const content = currentContent.join("\n").trim();
      if (content) {
        sections.push({
          heading: currentHeading || "(无标题)",
          content,
          level: currentLevel,
        });
      }
    }
    currentContent = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flush();
      currentLevel = headingMatch[1].length;
      currentHeading = headingMatch[2].trim();
    } else {
      currentContent.push(line);
    }
  }
  flush();

  // 对超长 section 做二次切分
  const result: StructuredChunk[] = [];
  for (const section of sections) {
    if (section.content.length <= maxChunkSize) {
      result.push(section);
    } else {
      const subChunks = chunkByFixedLength(section.content, maxChunkSize, 80);
      subChunks.forEach((sub, i) => {
        result.push({
          heading: `${section.heading} (${i + 1}/${subChunks.length})`,
          content: sub,
          level: section.level,
        });
      });
    }
  }
  return result;
}

// ---------------- 主实验 ----------------

async function main() {
  console.log("=== Day 37：Chunk 策略优化 ===\n");

  // 读取一个含多级标题的文档
  const mdFile = join(DOCS_DIR, "vue3.md");
  const rawMd = readFileSync(mdFile, "utf-8");
  const parsedText = parseMarkdown(rawMd);

  console.log(`原文：${rawMd.length} 字符，解析后：${parsedText.length} 字符\n`);

  // 方案 1：固定长度切分
  const fixedChunks = chunkByFixedLength(parsedText, 500, 50);
  console.log("=== 方案 1：固定长度切分（500 字符 + 50 overlap）===");
  console.log(`  Chunk 数：${fixedChunks.length}`);
  fixedChunks.forEach((c, i) => {
    console.log(`  [${i}] ${c.length} 字符 | ${c.slice(0, 60).replace(/\n/g, " ")}...`);
  });

  // 方案 2：按标题结构化切分
  const structuredChunks = chunkByHeadings(rawMd);
  console.log(`\n=== 方案 2：按标题结构化切分（max 800 字符）===`);
  console.log(`  Chunk 数：${structuredChunks.length}`);
  structuredChunks.forEach((c, i) => {
    console.log(`  [${i}] H${c.level} "${c.heading}" | ${c.content.length} 字符`);
    console.log(`       ${c.content.slice(0, 60).replace(/\n/g, " ")}...`);
  });

  // 对比
  console.log(`\n=== 对比 ===`);
  console.log(`  指标              | 固定长度 | 结构化`);
  console.log(`  ----------------- | -------- | --------`);
  console.log(`  Chunk 数          | ${fixedChunks.length}        | ${structuredChunks.length}`);
  console.log(`  语义完整性        | ❌ 可能切断 | ✅ 按标题边界`);
  console.log(`  边界清晰度        | ❌ 任意位置 | ✅ 标题分隔`);
  console.log(`  超长 section 处理 | ✅ 自动切分 | ✅ 二次切分`);
  console.log(`  溯源信息          | 仅文件   | 文件 + 标题路径`);
  console.log(``);
  console.log(`  结论：结构化切分更优——chunk 边界与语义边界一致，`);
  console.log(`  且可携带标题路径作为 metadata，提升检索和溯源质量。`);

  // 输出结构化切分的 metadata 示例
  console.log(`\n=== 结构化 Chunk 的 Metadata 示例 ===`);
  structuredChunks.forEach((c, i) => {
    console.log(`  chunk ${i}: { heading: "${c.heading}", level: ${c.level} }`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
