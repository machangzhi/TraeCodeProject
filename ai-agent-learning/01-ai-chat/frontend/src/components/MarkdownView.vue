<script setup lang="ts">
import { computed } from 'vue'
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/common'
import 'highlight.js/styles/github.css'

const props = defineProps<{ content: string }>()

// highlight 回调里用到 md.utils，需显式标注类型避免循环推断
const md: InstanceType<typeof MarkdownIt> = new MarkdownIt({
  // html: false 会转义 LLM 输出里的原始 HTML 标签，防 XSS 的第一道防线
  html: false,
  linkify: true,
  breaks: true,
  highlight(code, lang): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value
      } catch {
        // 高亮失败降级为纯文本转义，不能中断渲染
      }
    }
    return md.utils.escapeHtml(code)
  },
})

const html = computed(() => md.render(props.content))
</script>

<template>
  <!-- v-html 渲染的是 markdown-it 产物；html:false 已转义原始 HTML，相对安全 -->
  <div class="markdown" v-html="html"></div>
</template>

<style scoped>
/* v-html 渲染出的标签不在 scoped 作用域内，必须用 :deep() 才能命中 */
.markdown {
  line-height: 1.6;
  word-break: break-word;
}
.markdown :deep(p) {
  margin: 0.4em 0;
}
.markdown :deep(pre) {
  background: #f6f8fa;
  border-radius: 6px;
  padding: 12px;
  overflow-x: auto;
}
.markdown :deep(code) {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 0.9em;
}
/* 行内 code 样式；pre 里的 code 不重复加背景 */
.markdown :deep(:not(pre) > code) {
  background: #eff1f3;
  border-radius: 4px;
  padding: 2px 5px;
}
.markdown :deep(ul),
.markdown :deep(ol) {
  margin: 0.4em 0;
  padding-left: 1.4em;
}
.markdown :deep(table) {
  border-collapse: collapse;
  margin: 0.6em 0;
}
.markdown :deep(th),
.markdown :deep(td) {
  border: 1px solid #ddd;
  padding: 4px 10px;
}
.markdown :deep(blockquote) {
  margin: 0.4em 0;
  padding-left: 10px;
  border-left: 3px solid #ddd;
  color: #666;
}
</style>
