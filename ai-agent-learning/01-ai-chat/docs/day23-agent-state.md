# Day 23：Agent State —— messages / toolCalls / iteration 显式化

> 日期：2026-10-04
> 模型：deepseek-chat（temperature=0）

## Part A：状态转换单元测试（7/7，零 API）

| 用例 | 断言 | 结果 | 详情 |
|---|---|---|---|
| T1 | 初始：2 条消息、iteration=0、running | ✅ | `{"status":"running","iteration":0,"messageCount":2,"toolCallCount":0,"promptTokens":0,"com...` |
| T2 | nextIteration：iteration=1 | ✅ | `iteration=1` |
| T3 | 一轮后：消息 +3（assistant+tool）、1 次工具记录 | ✅ | `messages=4, toolCalls=1` |
| T4 | 工具记录 seq 单调、绑定 iteration=1 | ✅ | `{"seq":1,"iter":1}` |
| T5 | 收尾：status=finished、iteration=2、answer 已存 | ✅ | `{"status":"finished","iteration":2,"messageCount":5,"toolCallCount":1,"promptTokens":0,"co...` |
| T6 | 失败记录保留 failedStage=execute | ✅ | `stage=execute` |
| T7 | snapshot 可 JSON 序列化 | ✅ | `{"status":"finished","iteration":2,"messageCount":5,"toolCallCount":1,"promptTokens":0,"co...` |

## Part B：真实 LLM（4/4；Prompt Tokens 4677，Completion Tokens 477）

| 场景 | 说明 | iteration | 消息数 | 工具记录 | 结果 |
|---|---|---|---|---|---|
| B1 | 单步·时间 | 2 | 5 | 1 | ✅ |
| B2 | 链式·搜索→计算 | 3 | 8 | 3 | ✅ |
| B3 | 错误穿透·未覆盖城市 | 2 | 5 | 1 | ✅ |
| B4 | 零工具·常识 | 1 | 3 | 0 | ✅ |

---

## B1：单步·时间

- 判分：✅ gold=18:31 答复=18:31；{"status":"finished","iteration":2,"messageCount":5,"toolCallCount":1,"promptTokens":1084,"completionTokens":62,"lastRole":"assistant","updatedAt":"2026-10-04T10:31:11.744Z"}
- 最终状态快照：`{"status":"finished","iteration":2,"messageCount":5,"toolCallCount":1,"promptTokens":1084,"completionTokens":62,"lastRole":"assistant","updatedAt":"2026-10-04T10:31:11.744Z"}`
- 工具记录：
    ✓ #1 第1轮 get_current_time `{"timezone": "Asia/Shanghai"}` → `{"timezone":"Asia/Shanghai","hourMinute":"18:31","date":"2026-10-04"}`
- 最终答复：

```text
现在是北京时间 2026 年 10 月 4 日 18:31。
```

---

## B2：链式·搜索→计算

- 判分：✅ 差额命中=true 涨幅命中=true；{"status":"finished","iteration":3,"messageCount":8,"toolCallCount":3,"promptTokens":2010,"completionTokens":231,"lastRole":"assistant","updatedAt":"2026-10-04T10:31:14.368Z"}
- 最终状态快照：`{"status":"finished","iteration":3,"messageCount":8,"toolCallCount":3,"promptTokens":2010,"completionTokens":231,"lastRole":"assistant","updatedAt":"2026-10-04T10:31:14.368Z"}`
- 工具记录：
    ✓ #1 第1轮 search `{"query": "特斯拉 TSLA 股价 今日 涨跌幅"}` → `{"query":"特斯拉 TSLA 股价 今日 涨跌幅","searchedAt":"2026-10-04T10:31:12.378Z","dataSource":"mock","results":[{"title":"TSLA 行情（Mock）","snippet":"特斯拉(TSLA)报 252.14 美元，上一交易日收盘价 240.50 美元。","url":"https://exampl...`
    ✓ #2 第2轮 calculator `{"expression": "252.14 - 240.50"}` → `{"expression":"252.14 - 240.50","result":11.639999999999986}`
    ✓ #3 第2轮 calculator `{"expression": "(252.14 - 240.50) / 240.50 * 100"}` → `{"expression":"(252.14 - 240.50) / 240.50 * 100","result":4.839916839916834}`
- 最终答复：

```text
**特斯拉（TSLA）股价变动**

- 当前价：252.14 美元
- 上一交易日收盘价：240.50 美元
- **上涨：11.64 美元**
- **涨幅：约 4.84%**

⚠️ 说明：以上数据来自搜索工具返回的 **Mock（模拟）数据源**，并非真实市场行情，仅供参考，请以实际交易平台数据为准。
```

---

## B3：错误穿透·未覆盖城市

- 判分：✅ execute 失败=true 转述=true；{"status":"finished","iteration":2,"messageCount":5,"toolCallCount":1,"promptTokens":1076,"completionTokens":73,"lastRole":"assistant","updatedAt":"2026-10-04T10:31:15.789Z"}
- 最终状态快照：`{"status":"finished","iteration":2,"messageCount":5,"toolCallCount":1,"promptTokens":1076,"completionTokens":73,"lastRole":"assistant","updatedAt":"2026-10-04T10:31:15.789Z"}`
- 工具记录：
    ✗ #1 第1轮 get_weather `{"city": "重庆"}` → `{"error":"未知城市：\"重庆\"，覆盖：北京、上海、深圳","stage":"execute"}` [execute]
- 最终答复：

```text
抱歉，天气工具目前只覆盖北京、上海、深圳三个城市，无法查询重庆的天气。

如果你想了解这三个城市中任意一个的天气，我可以帮你查。
```

---

## B4：零工具·常识

- 判分：✅ gold=100；{"status":"finished","iteration":1,"messageCount":3,"toolCallCount":0,"promptTokens":507,"completionTokens":111,"lastRole":"assistant","updatedAt":"2026-10-04T10:31:16.889Z"}
- 最终状态快照：`{"status":"finished","iteration":1,"messageCount":3,"toolCallCount":0,"promptTokens":507,"completionTokens":111,"lastRole":"assistant","updatedAt":"2026-10-04T10:31:16.889Z"}`
- 工具记录：
（零调用）
- 最终答复：

```text
水在标准大气压（1 atm = 101.325 kPa）下的沸点是 **100 摄氏度（100 °C）**，即 **212 华氏度（212 °F）**，热力学温度为 **373.15 K**。

这是摄氏温标的定义基准点之一（另一个是冰点 0 °C）。需要说明的是，沸点会随气压变化：气压降低沸点下降（如高原上水不到 100 °C 就沸腾），气压升高沸点上升（如高压锅内）。
```

---

## 学习笔记

### 1. 为什么要把状态显式化：从"过程变量"到"一等公民"

Day 22 的 runAgent 结束后，messages、iteration、工具结果全部随栈帧销毁。这带来三个实际问题：循环中途无法从外部观察发生了什么；任务无法被保存或从断点恢复；"是否超步数""累计花了多少 token"这类判断无处附着。

AgentState 把它们收敛为一个对象后，循环的每一步都变成**显式的状态转换**：

| 循环动作 | 状态转换 |
|---|---|
| 进入下一轮 | `nextIteration()` iteration+1 |
| 模型返回 | `recordUsage()` 累计 token |
| 模型决策/工具结果入历史 | `append(...)` messages 增加 |
| 记录一次工具调用 | `recordToolCall(...)` toolCalls 增加（seq 自动编号） |
| 任务结束 | `finish(answer)` status → finished |

这与前端把组件 data 显式声明是同一个道理：状态散落在闭包里就不可预测，显式化后每一次变化都可追踪、可断言。

### 2. 状态不变量：单测盯住的不是值，而是关系

Part A 的 7 条单测验证的是状态间的**不变量关系**，而非具体数字：

- iteration 单调递增，且与 toolCall 的 iteration 字段一致（T4：工具记录绑定发生轮次）；
- 每次 assistant 工具调用后，必有对应 tool 消息（T3：一轮后消息 +2，加 assistant 自身共 +3）；
- toolCall 的 seq 全局单调（1,2,3…），失败调用也占用序号、保留 failedStage（T6）；
- finished 是终态：status 切换后 answer 已固化（T5）。

这些不变量在真实 LLM 场景中同样成立——看 B2 快照 `iteration=3, messageCount=7, toolCallCount=3, lastRole=assistant`：3 轮 LLM、3 次工具调用、最终停在 assistant，结构自洽。**单测先验证状态机正确，真实 API 只验证模型行为，两层零成本分离。**

### 3. 今天最重要的实证：同一输入两次运行，工具调用数 4 vs 3

B2 在定稿前后两次真实运行，输入完全相同、temperature=0：

| | 第 1 次 | 定稿第 2 次 |
|---|---|---|
| 工具调用数 | **4** | **3** |
| 差异 | 第 1 轮多了一个无关的 `get_current_time` | 无 |
| 共同部分 | search → 两个并行 calculator | 相同 |

模型第 1 次在用户完全没问时间的情况下"顺手"查了时间，第 2 次没有。这与 Day 16"temperature=0 下 Q1/Q4/Q8 状态漂移"、Day 20 S4 过度调用的观察互相印证，且进一步明确：

- **连工具选择本身都是采样，不是确定性函数**——temperature=0 只压缩方差、不消除方差（服务端可能存在内部路由/批处理的不确定性）；
- 因此"过度调用率"这类行为指标必须多次运行报分布，单次 4/3 的差异可能只是噪声；
- 工程上更说明**不能把成本控制寄托于模型自觉**：无关的 get_current_time 若发生在按次计费的真实工具上就是浪费，确定性手段（场景级工具白名单、调用预算）仍有必要。

### 4. snapshot 的三个用途与"可恢复"的边界

snapshot() 返回可 JSON 序列化的轻量摘要（状态、轮次、消息数、工具数、token、最后角色、时间戳）：

1. **可观测**：报告中每个场景的快照一行说清运行规模；
2. **可调试**：B2 首跑看快照 toolCallCount=4 立刻发现异常，再查 toolCalls 定位是多了时间调用；
3. **为持久化铺路**：snapshot 可序列化意味着状态可以落盘、跨进程传递。

但要诚实区分：今天的 snapshot 是**摘要**（不含完整消息体），Day 26 的 Memory/真正的断点恢复需要序列化完整 messages——这是下一步的工作，今天只验证了"状态可序列化"这个前提。

### 5. 与 Day 24/26 的衔接

- 明天的 `MAX_ITERATIONS=10` 只需读 `state.iteration` 判断——状态显式后，循环上限从"临时 if"变成正式的守卫条件；
- Day 26 的 conversation history 直接就是 `state.messages`，届时核心问题不是"怎么存"，而是"存多少、怎么裁剪"（记忆 ≠ 无限保存）。

成本：定稿 Part B 共 prompt 4677 / completion 477 tokens，是本周真实调用中较低的一次——单测零成本、一次定稿。

## 概念卡片

- **AgentState**：Agent 运行状态的显式容器（messages / toolCalls / iteration / status / token 用量），循环的每一步都是对它的转换。
- **状态不变量**：状态字段之间必须恒成立的关系（iteration 单调、toolCall 必有对应 tool 消息等），由单元测试守护。
- **StateSnapshot**：可 JSON 序列化的状态摘要，用于观测、调试与未来的持久化。
- **工具选择噪声**：同输入 temperature=0 下工具调用仍可能不同（B2 实测 4 vs 3），行为指标需多轮报分布。

## 面试题

Q：为什么要设计 AgentState？状态不显式化会怎样？
> A：不显式时 messages、iteration、工具记录都是循环局部变量，任务结束即丢失：无法中途观测、无法保存恢复、无法判断超步数和累计成本。AgentState 让循环每一步变成显式转换（nextIteration/append/recordToolCall/finish），7 条单测验证状态不变量，snapshot 可序列化用于观测调试，并直接支撑 Day 24 的步数上限和 Day 26 的 Memory。

Q：temperature=0 时模型行为是确定的吗？
> A：不是完全确定。B2 同输入两次真实运行，工具调用数 4 vs 3——第 1 次模型无关地多查了时间，第 2 次没有。结合 Day 16 的状态漂移，说明工具选择本身也是采样。行为指标要多次运行报分布，成本控制不能只靠模型自觉，需要工具白名单和调用预算。

Q：工具调用的状态记录包含什么？怎么保证记录可靠？
> A：每次调用记录序号、callId、发生轮次、名称、参数、是否成功、输出、失败阶段、时间戳。可靠性靠不变量：seq 全局单调、iteration 与当前轮一致、失败也记录并标 stage。单测 T3/T4/T6 零成本验证这些关系，真实场景 B3 的 execute 失败也完整保留在状态中。

Q：snapshot 能直接用于断点恢复吗？
> A：不能直接用——今天的 snapshot 是摘要，不含完整消息体，只解决观测和"状态可序列化"的前提。真正的断点恢复/Day 26 Memory 需要序列化完整 messages，是下一步工作。
