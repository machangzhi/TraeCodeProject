<script setup lang="ts">
/**
 * Day 27：Agent 思考链时间线组件
 *
 * 渲染一次 Agent 运行的完整步骤：思考 → 调用工具 → 工具返回 → （最终答案在气泡正文）。
 * 数据来自后端 /api/agent/stream 的 SSE 事件，逐条 push 进 steps 数组。
 */
export interface AgentStep {
  type: 'thinking' | 'tool_call' | 'tool_result'
  /** thinking 内容 */
  text?: string
  /** 工具名 */
  name?: string
  /** 调用参数（JSON 字符串） */
  args?: string
  /** tool_result 是否成功 */
  ok?: boolean
  /** tool_result 输出（JSON 字符串） */
  output?: string
  /** tool_result 耗时 ms */
  elapsedMs?: number
  at: number
}

defineProps<{
  steps: AgentStep[]
  running: boolean
}>()

// 工具返回的 JSON 美化展示；过长截断，完整内容不重要（Mock 数据）
function fmt(json: string | undefined): string {
  if (!json) return ''
  try {
    const pretty = JSON.stringify(JSON.parse(json), null, 2)
    return pretty.length > 300 ? `${pretty.slice(0, 300)}…` : pretty
  } catch {
    return json.length > 300 ? `${json.slice(0, 300)}…` : json
  }
}

// 参数通常是一行紧凑 JSON，格式化后更易读
function fmtArgs(args: string | undefined): string {
  if (!args) return ''
  try {
    return JSON.stringify(JSON.parse(args), null, 2)
  } catch {
    return args
  }
}
</script>

<template>
  <div class="steps">
    <div v-for="(s, i) in steps" :key="i" class="step" :class="s.type">
      <!-- 思考 -->
      <template v-if="s.type === 'thinking'">
        <div class="head"><span class="icon">💭</span> 思考</div>
        <div class="body think">{{ s.text }}</div>
      </template>

      <!-- 调用工具 -->
      <template v-else-if="s.type === 'tool_call'">
        <div class="head"><span class="icon">🔧</span> 调用工具 <code class="tool-name">{{ s.name }}</code></div>
        <pre class="body json">{{ fmtArgs(s.args) }}</pre>
      </template>

      <!-- 工具返回 -->
      <template v-else>
        <div class="head">
          <span class="icon">{{ s.ok ? '✅' : '❌' }}</span>
          工具返回 <code class="tool-name">{{ s.name }}</code>
          <span v-if="s.elapsedMs !== undefined" class="elapsed">{{ s.elapsedMs }}ms</span>
        </div>
        <pre class="body json" :class="{ err: s.ok === false }">{{ fmt(s.output) }}</pre>
      </template>
    </div>

    <!-- Agent 仍在运行、还没有新步骤时的等待指示 -->
    <div v-if="running" class="step running">
      <div class="head">Agent 运行中 <span class="dots"><i></i><i></i><i></i></span></div>
    </div>
  </div>
</template>

<style scoped>
.steps {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 6px;
}
.step {
  border: 1px solid #e5e7eb;
  border-left: 3px solid #9ca3af;
  border-radius: 6px;
  background: #fff;
  padding: 4px 8px;
  font-size: 13px;
}
.step.tool_call {
  border-left-color: #f59e0b;
}
.step.tool_result {
  border-left-color: #10b981;
}
.step.tool_result:has(.err) {
  border-left-color: #dc2626;
}
.step.thinking {
  border-left-color: #6366f1;
}
.head {
  font-size: 12px;
  color: #6b7280;
  display: flex;
  align-items: center;
  gap: 4px;
}
.icon {
  font-size: 12px;
}
.tool-name {
  background: #f3f4f6;
  padding: 0 4px;
  border-radius: 4px;
  color: #1d4ed8;
}
.elapsed {
  color: #9ca3af;
  margin-left: 4px;
}
.body {
  margin: 4px 0 2px;
  white-space: pre-wrap;
  word-break: break-word;
}
.body.think {
  color: #4b5563;
}
.body.json {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  background: #f9fafb;
  border-radius: 4px;
  padding: 4px 6px;
  margin-right: 0;
  overflow-x: auto;
}
.body.json.err {
  color: #dc2626;
  background: #fef2f2;
}
.dots i {
  display: inline-block;
  width: 5px;
  height: 5px;
  margin-left: 3px;
  border-radius: 50%;
  background: #9ca3af;
  animation: bounce 1.2s infinite ease-in-out;
}
.dots i:nth-child(2) {
  animation-delay: 0.15s;
}
.dots i:nth-child(3) {
  animation-delay: 0.3s;
}
@keyframes bounce {
  0%, 60%, 100% { transform: translateY(0); }
  30% { transform: translateY(-3px); }
}
</style>
