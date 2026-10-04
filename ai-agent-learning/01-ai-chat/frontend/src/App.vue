<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import MarkdownView from './components/MarkdownView.vue'
import AgentSteps, { type AgentStep } from './components/AgentSteps.vue'

interface Message {
  role: 'user' | 'assistant'
  content: string
  // 标记请求失败/中断/空回复的消息：仅用于界面提示，组装请求历史时必须过滤掉，
  // 不能把“请求失败”这类客户端文案或半截残文当作模型回复发给 LLM
  isError?: boolean
  // Day 27：Agent 思考链步骤（Agent 模式下由 SSE 事件逐条填充）
  steps?: AgentStep[]
}

// Day6：Conversation 数据模型 —— 一个会话是一串有序消息
interface Conversation {
  id: string
  title: string
  messages: Message[]
  createdAt: number
}

const STORAGE_KEY = 'ai-chat:conversations'
const CURRENT_KEY = 'ai-chat:currentId'

// 从 localStorage 恢复上次的会话列表
function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Conversation[]) : []
  } catch {
    return []
  }
}

const conversations = ref<Conversation[]>(loadConversations())

// 恢复上次激活的会话；存的 id 已不在列表里（比如换了浏览器数据被清过）就回退到第一个
const storedId = localStorage.getItem(CURRENT_KEY)
const currentId = ref<string>(
  storedId && conversations.value.some((c) => c.id === storedId)
    ? storedId
    : (conversations.value[0]?.id ?? ''),
)

// 当前会话；模板里的 messages 都从它取
const current = computed(
  () => conversations.value.find((c) => c.id === currentId.value) ?? null,
)
const messages = computed(() => current.value?.messages ?? [])

// 首次打开或全部删完时，兜底建一个空会话
if (!current.value) {
  const c: Conversation = {
    id: crypto.randomUUID(),
    title: '新会话',
    messages: [],
    createdAt: Date.now(),
  }
  conversations.value.push(c)
  currentId.value = c.id
}

// 消息变化持久化到 localStorage（刷新不丢）。
// 流式期间每个 delta 都会触发 deep watch，如果同步 stringify 全量列表
// 会造成 O(token数 × 总数据量) 的卡顿，所以用 300ms 防抖合并写入。
let saveTimer: ReturnType<typeof setTimeout> | undefined
watch(
  conversations,
  (list) => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
    }, 300)
  },
  { deep: true },
)

// 切换会话时立即记录当前 id，刷新后能回到同一会话
watch(currentId, (id) => localStorage.setItem(CURRENT_KEY, id))

// 新建会话并切换过去
function newConversation() {
  const c: Conversation = {
    id: crypto.randomUUID(),
    title: '新会话',
    messages: [],
    createdAt: Date.now(),
  }
  conversations.value.unshift(c)
  currentId.value = c.id
}

// 输入框内容
const input = ref('')

// 发送中状态：控制 Stop 按钮显示、防止重复发送
const loading = ref(false)

// Day 27：Agent 模式开关——开启后走 /api/agent/stream，
// 气泡内会实时显示 思考 → 调用工具 → 工具返回 的完整思考链
const agentMode = ref(true)

// 当前请求的取消控制器；null 表示没有在途请求
const abortCtrl = ref<AbortController | null>(null)

// 消息列表容器的 DOM 引用，用于自动滚动到底部
const messagesEl = ref<HTMLDivElement | null>(null)

// 等 Vue 把新消息渲染进 DOM 后，再把滚动条拉到底部
function scrollToBottom() {
  nextTick(() => {
    const el = messagesEl.value
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  })
}

// 点击 Stop：中断在途流式请求，已生成的半截内容保留在气泡里
function stop() {
  abortCtrl.value?.abort()
}

async function send() {
  const text = input.value.trim()
  const conv = current.value
  if (!text || loading.value || !conv) return

  // 捕获当前会话的引用：流式过程中用户可能切换会话，
  // 后续所有写入都必须落在发起时的这个会话上，不能用 current.value
  const convMessages = conv.messages

  // 首条用户消息作为会话标题（取前 20 字）
  if (convMessages.length === 0) {
    conv.title = text.slice(0, 20)
  }

  // 先把用户消息入列，再占位一条空的 AI 消息，流式过程中往里追加文字
  convMessages.push({ role: 'user', content: text })
  scrollToBottom()
  input.value = ''
  loading.value = true

  // Agent 模式下预置 steps 数组，SSE 事件逐条填入形成思考链时间线
  convMessages.push({
    role: 'assistant',
    content: '',
    ...(agentMode.value ? { steps: [] as AgentStep[] } : {}),
  })
  const aiIndex = convMessages.length - 1
  const ai = convMessages[aiIndex]

  // 每条请求独立一个 AbortController，结束后在 finally 里清空
  const ctrl = new AbortController()
  abortCtrl.value = ctrl

  try {
    // EventSource 只支持 GET、发不了 POST body，所以用 fetch 手动读流。
    // Agent 模式走 /api/agent/stream，事件为 {type: thinking|tool_call|tool_result|answer|...}
    const res = await fetch(agentMode.value ? '/api/agent/stream' : '/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      // 只发本轮占位之前的历史，并剔除历次失败/中断消息，避免污染上下文
      body: JSON.stringify({
        messages: convMessages
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

        if (agentMode.value) {
          // Agent 事件流：把过程事件逐条填进 steps，最终 answer 写入正文
          if (data.type === 'error') throw new Error(data.message || 'Agent 运行失败')
          else if (data.type === 'thinking')
            ai.steps!.push({ type: 'thinking', text: data.content, at: Date.now() })
          else if (data.type === 'tool_call')
            ai.steps!.push({ type: 'tool_call', name: data.name, args: data.args, at: Date.now() })
          else if (data.type === 'tool_result')
            ai.steps!.push({
              type: 'tool_result', name: data.name, ok: data.ok,
              output: JSON.stringify(data.output), elapsedMs: data.elapsedMs, at: Date.now(),
            })
          else if (data.type === 'answer') {
            ai.content = data.content || ''
            scrollToBottom()
          }
          // done：统计事件，答复已写入，无需处理
        } else {
          if (data.error) throw new Error(data.error)
          if (data.delta) {
            ai.content += data.delta
            scrollToBottom()
          }
        }
      }
    }

    // 整流没有任何内容（如内容被审核拦截、finish_reason=content_filter），
    // 给占位气泡兜底提示并标记错误，避免空白气泡残留，也防止空消息进入下一轮历史
    if (!ai.content) {
      ai.content = '（模型未返回内容）'
      ai.isError = true
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      // 用户主动 Stop：保留半截内容并标注，打 isError 不进下一轮历史
      ai.content = ai.content
        ? `${ai.content}\n（已停止，以上内容未计入对话历史）`
        : '（已停止）'
      ai.isError = true
    } else {
      // 统一在占位气泡上提示：无内容直接显示失败；已有半截内容则追加中断说明。
      // 两种情况都打 isError，下一轮组装请求历史时会被过滤，不会污染上下文
      ai.content = ai.content
        ? `${ai.content}\n（请求中断，以上内容未计入对话历史）`
        : '请求失败'
      ai.isError = true
    }
    scrollToBottom()
  } finally {
    loading.value = false
    abortCtrl.value = null
  }
}
</script>

<template>
  <div class="layout">
    <aside class="sidebar">
      <button class="new-btn" @click="newConversation">+ 新建会话</button>
      <div
        v-for="c in conversations"
        :key="c.id"
        :class="['conv-item', { active: c.id === currentId }]"
        @click="currentId = c.id"
      >
        {{ c.title }}
      </div>
    </aside>

    <div class="chat">
      <h1>AI Chat</h1>

      <div class="messages" ref="messagesEl">
        <div
          v-for="(m, i) in messages"
          :key="i"
          :class="['msg-row', m.role]"
        >
          <div :class="['bubble', m.role, { error: m.isError }]">
            <div class="sender">{{ m.role === 'user' ? '我' : 'AI' }}</div>
            <!-- 用户消息是纯输入，直接纯文本展示；AI 消息走 Markdown 渲染 -->
            <span v-if="m.role === 'user'">{{ m.content }}</span>
            <template v-else>
              <!-- Day 27：Agent 思考链时间线（Agent 模式消息才有 steps） -->
              <AgentSteps
                v-if="m.steps"
                :steps="m.steps"
                :running="loading && i === messages.length - 1 && !m.content"
              />
              <MarkdownView v-if="m.content" :content="m.content" />
              <!-- 纯聊天模式流式等待动画；Agent 模式的进行中状态由时间线内 running 行负责 -->
              <span
                v-else-if="loading && i === messages.length - 1 && !m.steps"
                class="dots"
                ><i></i><i></i><i></i
              ></span>
            </template>
          </div>
        </div>
      </div>

      <div class="input-row">
        <label class="agent-toggle" title="开启后 AI 可调用工具，并实时显示思考链">
          <input type="checkbox" v-model="agentMode" /> Agent
        </label>
        <input v-model="input" @keyup.enter="send" placeholder="输入消息，回车发送" />
        <button v-if="loading" class="stop" @click="stop">停止</button>
        <button v-else :disabled="!input.trim()" @click="send">发送</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  max-width: 960px;
  margin: 40px auto;
  padding: 0 16px;
  gap: 16px;
}
/* 会话列表侧边栏 */
.sidebar {
  width: 200px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.new-btn {
  padding: 8px;
  border: 1px dashed #2563eb;
  background: #fff;
  color: #2563eb;
  border-radius: 6px;
  cursor: pointer;
}
.conv-item {
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  /* 标题过长时单行省略 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.conv-item:hover {
  background: #f3f4f6;
}
.conv-item.active {
  background: #dbeafe;
  color: #1d4ed8;
}
.chat {
  flex: 1;
  min-width: 0;
}
.messages {
  border: 1px solid #ddd;
  border-radius: 8px;
  height: 480px;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
/* 行容器控制左右对齐：用户靠右、AI 靠左 */
.msg-row {
  display: flex;
}
.msg-row.user {
  justify-content: flex-end;
}
.msg-row.assistant {
  justify-content: flex-start;
}
.bubble {
  max-width: 85%;
  padding: 8px 12px;
  border-radius: 10px;
}
.bubble.user {
  background: #2563eb;
  color: #fff;
  /* 保留用户输入里的换行 */
  white-space: pre-wrap;
}
.bubble.assistant {
  background: #f3f4f6;
  color: #1f2937;
}
.bubble.assistant.error {
  background: #fef2f2;
  color: #dc2626;
}
.sender {
  font-size: 12px;
  opacity: 0.7;
  margin-bottom: 2px;
}
/* Loading 三点跳动动画 */
.dots i {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 4px;
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
  0%,
  60%,
  100% {
    transform: translateY(0);
  }
  30% {
    transform: translateY(-4px);
  }
}
.input-row {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  align-items: center;
}
.agent-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: #1d4ed8;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
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
.input-row button.stop {
  background: #dc2626;
}
.input-row button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
