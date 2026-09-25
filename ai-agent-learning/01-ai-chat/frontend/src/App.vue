<script setup lang="ts">
import { ref, nextTick } from 'vue'

interface Message {
  role: 'user' | 'assistant'
  content: string
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

  // TODO(Day3·你来写)：
  // 1. 把用户消息加入 messages 列表（role: 'user', content: text）
  messages.value.push({ role: 'user', content: text })
  scrollToBottom()
  // 2. 清空输入框 input
  input.value = ''
  // 3. loading.value = true
  loading.value = true
  // 4. 调接口 POST /api/chat，body: { messages: messages.value }
  //    注意：fetch 的 URL 写 '/api/chat'（相对路径，Vite 会代理到 3000）
  // 5. 拿到响应里的 reply，作为 assistant 消息追加到 messages
  // 6. 出错时也要给用户反馈（比如追加一条 "请求失败" 的 assistant 消息）
  // 7. finally 里 loading.value = false
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messages.value }),
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} `)
}
    const data = await res.json()
    messages.value.push({ role: 'assistant', content: data.reply })
    scrollToBottom()
  } catch (error) {
    messages.value.push({ role: 'assistant', content: '请求失败' })
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
      <div v-for="(m, i) in messages" :key="i" :class="['msg', m.role]">
        <strong>{{ m.role === 'user' ? '我' : 'AI' }}:</strong>
        <span>{{ m.content }}</span>
      </div>
      <div v-if="loading" class="msg assistant">AI 思考中...</div>
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
