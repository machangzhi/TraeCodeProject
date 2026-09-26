<script setup lang="ts">
import { ref, nextTick } from 'vue'

interface Message {
  role: 'user' | 'assistant'
  content: string
  // 标记请求失败/空回复的消息：仅用于界面提示，组装请求历史时必须过滤掉，
  // 不能把“请求失败”这类客户端文案或半截残文当作模型回复发给 LLM
  isError?: boolean
}

// 消息列表，初始为空
const messages = ref<Message[]>([])

// 输入框内容
const input = ref('')

// 发送中状态，防止重复点击
const loading = ref(false)

// 消息列表容器的 DOM 引用，用于自动滚动到底部
const messagesEl = ref<HTMLDivElement | null>(null)

// 等 Vue 把新消息渲染进 DOM 后，再把滚动条拉到底部
function scrollToBottom() {
  nextTick(() => {
    const el = messagesEl.value
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  })
}

async function send() {
  const text = input.value.trim()
  if (!text || loading.value) return

  // 先把用户消息入列，再占位一条空的 AI 消息，流式过程中往里追加文字
  messages.value.push({ role: 'user', content: text })
  scrollToBottom()
  input.value = ''
  loading.value = true

  messages.value.push({ role: 'assistant', content: '' })
  const aiIndex = messages.value.length - 1

  try {
    // EventSource 只支持 GET、发不了 POST body，所以用 fetch 手动读流
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 只发本轮占位之前的历史，并剔除历次失败/中断消息，避免污染上下文
      body: JSON.stringify({
        messages: messages.value
          .filter((_, i) => i < aiIndex)
          .filter((m) => !m.isError),
      }),
    })
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      // stream: true：处理被网络分包切断的多字节中文字符
      buffer += decoder.decode(value, { stream: true })

      // SSE 消息以空行（\n\n）分隔；最后一段可能是半条消息，留在 buffer 等下一包
      const parts = buffer.split('\n\n')
      buffer = parts.pop() || ''

      for (const part of parts) {
        const line = part.trim()
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') break
        const data = JSON.parse(payload)
        if (data.error) throw new Error(data.error)
        if (data.delta) {
          messages.value[aiIndex].content += data.delta
          scrollToBottom()
        }
      }
    }

    // 整流没有任何 delta（如内容被审核拦截、finish_reason=content_filter），
    // 给占位气泡兜底提示并标记错误，避免空白气泡残留，也防止空消息进入下一轮历史
    if (!messages.value[aiIndex].content) {
      messages.value[aiIndex].content = '（模型未返回内容）'
      messages.value[aiIndex].isError = true
    }
  } catch (error) {
    // 统一在占位气泡上提示：无内容直接显示失败；已有半截内容则追加中断说明。
    // 两种情况都打 isError，下一轮组装请求历史时会被过滤，不会污染上下文
    const ai = messages.value[aiIndex]
    ai.content = ai.content
      ? `${ai.content}\n（请求中断，以上内容未计入对话历史）`
      : '请求失败'
    ai.isError = true
    scrollToBottom()
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="chat">
    <h1>AI Chat</h1>

    <div class="messages" ref="messagesEl">
      <div
        v-for="(m, i) in messages"
        :key="i"
        :class="['msg', m.role, { error: m.isError }]"
      >
        <strong>{{ m.role === 'user' ? '我' : 'AI' }}:</strong>
        <span>{{
          m.content ||
          (loading && i === messages.length - 1 ? 'AI 思考中...' : '')
        }}</span>
      </div>
    </div>

    <div class="input-row">
      <input v-model="input" @keyup.enter="send" placeholder="输入消息，回车发送" />
      <button :disabled="loading" @click="send">发送</button>
    </div>
  </div>
</template>

<style scoped>
.chat {
  max-width: 640px;
  margin: 40px auto;
  padding: 0 16px;
}
.messages {
  border: 1px solid #ddd;
  border-radius: 8px;
  height: 400px;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.msg {
  line-height: 1.5;
}
.msg.user {
  color: #2563eb;
}
.msg.assistant {
  color: #1f2937;
}
.msg.assistant.error {
  color: #dc2626;
}
.msg span {
  /* 保留 LLM 回复中的换行；中断说明也能单独成行 */
  white-space: pre-wrap;
}
.input-row {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.input-row input {
  flex: 1;
  padding: 10px;
  border: 1px solid #ddd;
  border-radius: 6px;
}
.input-row button {
  padding: 0 20px;
  border: none;
  background: #2563eb;
  color: white;
  border-radius: 6px;
  cursor: pointer;
}
.input-row button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
