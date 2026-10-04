# Day 27：Agent UI —— 前端显示完整思考链

> 日期：2026-10-04
> 目标：前端显示完整思考链：思考 → 调用 Weather → Weather 返回 → 生成答案。

## 实现概览

Day 22 的 AgentStep 当时就明确了三重用途之一是「UI 数据源」，今天兑现：把 Day 22-26 的 Agent 循环成果改造成**事件化**版本，通过 SSE 逐条推给前端渲染成时间线。

| 层 | 文件 | 内容 |
|---|---|---|
| 后端·工具 | `server/src/agent/tools.ts` | calculator / get_current_time / get_weather（Day 16-18 正式版迁移） |
| 后端·注册表 | `server/src/agent/registry.ts` | 四阶段执行流水线，永不抛出（Day 19/25） |
| 后端·循环 | `server/src/agent/agent.ts` | 事件化 Agent 循环：Day 22 终止权交给模型 + Day 24 上限强制收尾 + Day 25 重试/错误回喂 + Day 26 历史消息（full Memory） |
| 后端·接口 | `server/src/index.ts` | `POST /api/agent/stream`（SSE） |
| 前端·组件 | `frontend/src/components/AgentSteps.vue` | 思考链时间线：💭 思考 / 🔧 调用工具（参数）/ ✅❌ 工具返回（JSON+耗时）/ 运行中指示 |
| 前端·集成 | `frontend/src/App.vue` | Agent 模式开关（默认开）、SSE 事件解析、steps 随会话持久化 |
| 前端·LLM 层 | `server/src/llm.ts` | 新增 `chatComplete`：带工具定义、30s 超时、不内部重试 |

### SSE 事件协议

请求体 `{ messages }`：最后一条 user 消息作为本轮任务，之前的 user/assistant 文本作为历史。响应事件流：

```text
data: {"type":"thinking","content":"我来查询北京的实时天气。"}
data: {"type":"tool_call","name":"get_weather","args":"{\"city\": \"北京\"}"}
data: {"type":"tool_result","name":"get_weather","ok":true,"output":{...},"elapsedMs":1}
data: {"type":"thinking","content":"北京当前天气情况如下：..."}
data: {"type":"answer","content":"（最终 Markdown 答复）"}
data: {"type":"done","stopReason":"finished","iterations":2,"toolCalls":1,"promptTokens":1077,"completionTokens":116}
data: [DONE]
```

断连检测沿用 Day 4 教训：监听 `res` 的 `close` + `writableFinished`，不监听 `req`。

## 真实验证

### curl 直连（1 次完整 Agent 运行，精确 1193 tokens）

对 `/api/agent/stream` 发送「北京现在天气怎么样？多少度？」，事件序列完整：

1. `thinking`：我来查询北京的实时天气。
2. `tool_call`：get_weather `{"city": "北京"}`
3. `tool_result`：`ok=true`，`{temperatureC: 22, condition: "晴", ...}`，耗时 1ms
4. `thinking`：模型整理结果并附 Mock 数据说明
5. `answer`：Markdown 答复（22°C、晴、降水量 0、Mock 声明）
6. `done`：`stopReason=finished, iterations=2, toolCalls=1`
7. `[DONE]`

### 浏览器端到端（browser 自动化，6/6 通过）

1. 页面正常渲染（侧边栏 + 聊天区 + Agent 复选框）✅
2. Agent 复选框默认勾选 ✅
3. 发送天气问题触发 SSE 流 ✅
4. 思考链时间线完整：💭 思考 → 🔧 get_weather（参数）→ ✅ 返回（JSON+耗时）→ 💭 思考 → Markdown 答复含 22°C 与 Mock 说明 ✅
5. 完成状态截图 ✅
6. 「帮我算一下 123 乘 456」：calculator 链正常，返回 56088 ✅

## 学习笔记

1. **AgentStep 的「事件化」改造是 UI 的关键一步。** 实验版的循环是"跑完返回 state"，UI 需要的是"边跑边说"。改造方式是把 state 的每次变更换成 `onEvent` 回调：thinking（模型叙述）、tool_call/tool_result（工具过程）、answer（终稿）、done（统计）。数据没变，变的是**输出节奏**——SSE 的价值就是把 Agent 的中间状态变成用户的实时反馈。
2. **"思考"事件天然来自 assistant 消息的 content 字段。** 带 tool_calls 的决策消息里，content 就是大模型的自然语言叙述（"我来查询北京的实时天气"）——不需要额外的"思考模型"，Function Calling 协议本身就携带思考链。但要注意它**可能为空**（模型直接发 tool_calls 不叙述），所以 UI 不能假设每轮都有 thinking 步骤，tool_call 卡片才是稳定锚点。
3. **前端只持久化最终答复，工具过程存进 steps 但不进历史。** 发给后端的 messages 只含 user/assistant 文本（isError 与半截内容过滤规则沿用 Day 6），Agent 中间过程（tool_call/tool_result）只留在气泡里供回看。这是 UI 层 Memory 策略的选择：过程事件对下一轮生成没有价值，白烧 token（Day 26 结论的直接应用）。
4. **done 事件让前端能展示透明化的统计**（本轮 2 轮决策、1 次工具调用、1193 tokens）——Agent 不再是黑盒，成本和路径都可见。这是 Day 23「AgentState 可序列化」判分/调试/UI 三用途中 UI 一途的落地。
5. **调试教训：tsx 非 watch 模式 + 旧进程占端口。** 启动新服务报 EADDRINUSE，原因是上次会话的旧 server 进程仍在 3000 端口跑旧代码（没有 agent 路由）——`netstat -ano | findstr :3000` 找到 PID 后 `taskkill /F` 杀掉重启才生效。「代码改了不生效先核对进程启动时间与文件修改时间」这条教训再次验证。

## 概念卡片

- **思考链（Chain of Thought UI）**：把 Agent 运行中的决策叙述、工具调用与返回按时间顺序渲染给用户的时间线组件，本质是 SSE 事件流的视觉化。
- **事件化 Agent**：把"跑完返回完整状态"的循环改成"每个动作即时发出事件"的循环；数据同源（AgentState），输出节奏不同。
- **SSE 事件协议**：在 `data: {json}\n\n` 报文里增加 `type` 字段区分事件种类（thinking/tool_call/tool_result/answer/done/error），`[DONE]` 结束。
- **过程与答复分离**：工具调用过程只做 UI 展示与调试，不写入对话历史；下一轮请求只带最终答复文本。

## 面试题

**Q1：Agent 的"思考过程"是怎么拿到并展示到前端的？是额外调用了一次思考模型吗？**

A：不需要额外调用。Function Calling 协议中，模型返回的 assistant 消息同时可以携带 content（自然语言叙述）和 tool_calls（调用申请单），content 就是现成的思考叙述——本实验的 thinking 事件直接取自 `msg.content`（SSE 直连验证：第 1 轮 "我来查询北京的实时天气"）。要注意 content 可能为空（模型不叙述直接调用），所以前端时间线把 tool_call 卡片作为稳定锚点，thinking 只是增强。整个过程与普通 SSE 流一样只有一条消息通道，靠 `type` 字段区分事件。

**Q2：前端怎么处理 Agent 的中间过程消息？为什么工具调用记录不放进对话历史？**

A：分两条路。展示路：SSE 的 thinking/tool_call/tool_result 事件逐条 push 进当前消息的 `steps` 数组，随会话存 localStorage，刷新后时间线还在。历史路：组装下一轮请求时只取 user/assistant 文本（过滤 isError），工具过程完全不进 messages。原因有二：一是工具结果已经在最终答复里被模型消化了，重复携带只烧 token（Day 26 实证：消息数是成本粗代理）；二是历史里没有 tool_call_id 对应的完整协议上下文，混入反而有协议风险。

**Q3：SSE 推送 Agent 事件和 Day 4 推送聊天 delta 有什么不同？断连处理要注意什么？**

A：结构上不同：聊天流每条 data 是 `{delta: "文本片段"}`，纯追加；Agent 流每条 data 是带 type 的完整事件，前端按类型分发（steps push / content 覆写），且多了 error/done 两种控制事件。断连处理完全沿用 Day 4 的教训：必须监听 `res` 的 `close` 事件并用 `writableFinished` 区分"真断开"与"正常结束"，不能监听 `req`——Node 16+ 上 POST body 被 express.json() 读完后 req 流会立即触发 close，与连接是否断开无关，会导致整个流静默零输出。
