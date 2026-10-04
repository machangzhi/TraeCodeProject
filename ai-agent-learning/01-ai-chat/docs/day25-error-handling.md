# Day 25：错误处理 —— 五类错误的分类学与循环级韧性

> 日期：2026-10-04
> 模型：deepseek-chat（temperature=0；Part A 为 Mock 注入，零 API 成本）

## 错误分类学

| 层 | 阶段 | 处理方式 |
|---|---|---|
| 工具层 | lookup 工具不存在 | 错误 JSON 回喂（`未注册的工具`） |
| 工具层 | parse 参数非 JSON | 解析错误回喂 |
| 工具层 | validate Zod 失败 | 字段级 details 回喂 |
| 工具层 | execute 执行异常 | 业务错误回喂（可含修复引导） |
| 模型层 | LLM 调用失败 | 循环层重试 3 次 → 耗尽抛 AgentFailureError（携带部分状态，不伪造 finished） |
| 组合 | 无限循环 | Day 24 MAX_ITERATIONS 强制收尾兜底 |

计账口径：`llmCalls` = 成功决策数（R6 不变量），`llmAttempts` = 全部尝试（含重试）。

## Part A：Mock 注入单测（7/7，零 API）

| 用例 | 断言 | 结果 | 详情 |
|---|---|---|---|
| A1 | lookup：未注册工具返回错误 JSON、循环存活、不变量通过 | ✅ | `stage=lookup error="{"error":"未注册的工具：\"get_stock\"","stage":"lookup"}" 违规=0` |
| A2 | parse：坏 JSON 参数返回解析错误、循环存活 | ✅ | `stage=parse error="{"error":"参数不是合法 JSON：Expected ',' or '}' after property value in JSON at positi" 违规=0` |
| A3 | validate：Zod 失败回喂字段级 details、循环存活 | ✅ | `stage=validate details=true output="{"error":"参数校验失败","stage":"validate","details":["expression: String must contain"` |
| A4 | execute：业务异常回喂且错误自带覆盖引导、循环存活 | ✅ | `stage=execute error="{"error":"未知城市：\"重庆\"，当前覆盖：北京、上海、深圳","stage":"execute"}"` |
| A5 | LLM 自愈：前 2 次 500、第 3 次成功，llmAttempts=4、llmCalls=2 | ✅ | `iter=2 llmCalls=2 llmAttempts=4 lastErr="Mock LLM 网络错误（模拟服务端 500）" 违规=0` |
| A6 | LLM 耗尽：抛 AgentFailureError、状态保留为 running、不伪造答案 | ✅ | `message="LLM 连续 3 次调用失败，任务中止：Mock LLM 网络错误（模拟服务端 500）" iter=0 llmAttempts=3 status=running 违规=0` |
| A7 | 组合兜底：3 轮重试全败 → 上限截停 + 强制收尾，协议一致 | ✅ | `iter=3 tools=3(全败=true) forcedFinalOk=true 违规=0` |

## Part B：真实 LLM（3/3；Prompt Tokens 4171，Completion Tokens 405）

| 场景 | 说明 | 轮数 | llmAttempts | 工具次数 | 结果 | 判分摘要 |
|---|---|---|---|---|---|---|
| B1 | 瞬时故障·第 1 次（错误文案鼓励重试，观察自愈 vs 放弃） | 3 | 3 | 2 | ✅ | `路径=自愈重试成功；get_weather 调用 2 次（成功 1）；温度 22°C 命中` |
| B2 | 瞬时故障·第 2 次（报分布） | 3 | 3 | 2 | ✅ | `路径=自愈重试成功；get_weather 调用 2 次（成功 1）；温度 22°C 命中` |
| B3 | 未知城市引导（execute 错误含覆盖列表 → 转述质量） | 2 | 2 | 1 | ✅ | `execute 失败=true；如实转述=true；提及覆盖城市/替代=true；工具次数=1` |

---

## B1：瞬时故障·第 1 次（错误文案鼓励重试，观察自愈 vs 放弃）

- 判分：✅ 路径=自愈重试成功；get_weather 调用 2 次（成功 1）；温度 22°C 命中
- 用户输入：北京现在天气怎么样？多少度？
- 状态快照：`{"status":"finished","stopReason":"finished","iteration":3,"maxIterations":10,"llmCalls":3,"llmAttempts":3,"forcedFinalAttempted":false,"forcedFinalOk":false,"lastLLMError":null,"messageCount":7,"toolCallCount":2,"promptTokens":1597,"completionTokens":163,"lastRole":"assistant","updatedAt":"2026-10-04T12:40:07.171Z"}`
- 不变量检查：✅ 零违规
- 工具记录：
    ✗ #1 第1轮 get_weather `{"city": "北京"}` → `{"error":"天气服务瞬时过载（瞬时故障，立即重试一次通常即可成功）","stage":"execute"}` [execute]
    ✓ #2 第2轮 get_weather `{"city": "北京"}` → `{"city":"北京","observedAt":"2026-10-04T10:00:00+08:00","dataSource":"mock","temperatureC":22,"condition":"晴","precipitationMm":0}`
- 最终答复：

```text
北京当前天气（数据为 Mock 模拟数据，观测时间 2026-10-04 10:00，北京时间）：

- **天气状况**：晴
- **气温**：22 ℃
- **降水量**：0 mm

补充说明：第一次查询时天气服务出现瞬时过载，重试后成功返回。以上为模拟数据，仅供参考，实际出行请以官方气象台信息为准。
```

---

## B2：瞬时故障·第 2 次（报分布）

- 判分：✅ 路径=自愈重试成功；get_weather 调用 2 次（成功 1）；温度 22°C 命中
- 用户输入：北京今天天气如何？
- 状态快照：`{"status":"finished","stopReason":"finished","iteration":3,"maxIterations":10,"llmCalls":3,"llmAttempts":3,"forcedFinalAttempted":false,"forcedFinalOk":false,"lastLLMError":null,"messageCount":7,"toolCallCount":2,"promptTokens":1599,"completionTokens":151,"lastRole":"assistant","updatedAt":"2026-10-04T12:40:09.288Z"}`
- 不变量检查：✅ 零违规
- 工具记录：
    ✗ #1 第1轮 get_weather `{"city": "北京"}` → `{"error":"天气服务瞬时过载（瞬时故障，立即重试一次通常即可成功）","stage":"execute"}` [execute]
    ✓ #2 第2轮 get_weather `{"city": "北京"}` → `{"city":"北京","observedAt":"2026-10-04T10:00:00+08:00","dataSource":"mock","temperatureC":22,"condition":"晴","precipitationMm":0}`
- 最终答复：

```text
北京今天（2026-10-04 10:00 观测）天气如下：

- **天气状况**：晴
- **气温**：22 ℃
- **降水量**：0 mm

数据来源为 Mock（模拟）数据，仅供参考，实际出行请以官方气象台发布为准。
```

---

## B3：未知城市引导（execute 错误含覆盖列表 → 转述质量）

- 判分：✅ execute 失败=true；如实转述=true；提及覆盖城市/替代=true；工具次数=1
- 用户输入：重庆现在天气怎么样？多少度？
- 状态快照：`{"status":"finished","stopReason":"finished","iteration":2,"maxIterations":10,"llmCalls":2,"llmAttempts":2,"forcedFinalAttempted":false,"forcedFinalOk":false,"lastLLMError":null,"messageCount":5,"toolCallCount":1,"promptTokens":975,"completionTokens":91,"lastRole":"assistant","updatedAt":"2026-10-04T12:40:11.124Z"}`
- 不变量检查：✅ 零违规
- 工具记录：
    ✗ #1 第1轮 get_weather `{"city": "重庆"}` → `{"error":"未知城市：\"重庆\"，当前覆盖：北京、上海、深圳","stage":"execute"}` [execute]
- 最终答复：

```text
抱歉，天气工具目前只覆盖北京、上海、深圳三个城市，无法查询重庆的天气，所以暂时给不出重庆现在的天气和温度。

如果你需要，我可以帮你查北京、上海或深圳的天气；或者你也可以告诉我其他可用的信息来源。
```

---

## 学习笔记

1. **错误文案就是给模型的 API，措辞直接决定重试还是放弃。** 同样的天气服务故障：Day 24 B3/B4 文案是"临时不可用，请稍后重试"→ 模型 2/2 调 1 次就放弃、把重试责任推给用户；今天 B1/B2 文案是"瞬时故障，立即重试一次通常即可成功"→ 模型 2/2 立即重试并成功（`get_weather` 调 2 次成功 1 次，答出 22°C），B1 还主动向用户披露"第一次查询出现瞬时过载，重试后成功"。两轮分布一致，这不是噪声而是文案驱动：**错误消息的措辞是隐式 prompt，写错误文案要像写 prompt 一样认真**。
2. **错误引导的质量决定恢复的质量。** B3 中错误消息自带覆盖列表（"未知城市：重庆，当前覆盖：北京、上海、深圳"），模型不仅如实转述，还主动提供替代方案（"我可以帮你查北京、上海或深圳的天气"）。对比 Day 22 A7 时代不带引导的错误只能得到干巴巴的"查不到"——错误信息里能指路的就应该指路。
3. **工具层五类错误全部"错误 JSON 回喂 + 循环存活"。** A1（lookup 未注册工具）、A2（parse 坏 JSON）、A3（validate 字段级 details）、A4（execute 业务异常）四次注入中 `registry.execute` 都没有抛出异常，模型每轮都拿到了结构化错误并正常决策——这正是 Day 19 四阶段流水线设计的回报：**工具层的错误永远不应该炸掉循环，只应该变成模型可读的信息**。
4. **LLM 层失败要与工具层失败区别对待。** 工具错误回喂给模型决策；LLM 自身失败模型根本无从知晓，只能靠循环层重试（A5：前 2 次 500，第 3 次成功，`llmAttempts=4, llmCalls=2`，R6 不变量依然成立）。重试耗尽时抛 `AgentFailureError` 携带部分状态（A6：`iter=0, llmAttempts=3, status=running`）——**宁可明确失败，也不伪造一句"任务失败"假装 finished**，否则上层无法区分"模型说失败了"和"系统崩了"。
5. **失败路径也要过不变量。** A6 暴露了一个计账细节：`iteration` 若在 LLM 调用前自增，失败轮次会造成 `llmCalls=0 ≠ iteration=1` 违反 R6。修正为决策成功后才自增——失败不计入轮次。教训：**不变量检查器在成功路径上全绿不代表正确，必须让它在失败路径上也跑一遍**。
6. **组合故障的最后兜底仍是 Day 24 的硬上限。** A7 工具永远失败 + 模型永远重试，3 轮后 MAX_ITERATIONS 截停、强制收尾成功（`forcedFinalOk=true`）、协议零违规。至此五类错误形成闭环：四类工具错误回喂自愈，LLM 错误重试降级，无限循环硬上限兜底。

## 概念卡片

- **错误回喂（error feedback）**：工具层错误不抛异常，而是序列化为 JSON 作为 tool 消息回给模型，让循环继续、模型决策下一步（换参数、换工具或如实转述）。
- **fail-first 注入**：确定性故障注入手段——前 N 次调用抛错、之后恢复，用于零成本验证"自愈重试"路径（B1/B2 与 A5/A7 均靠它构造）。
- **AgentFailureError**：LLM 重试耗尽时抛出的失败信号，携带部分状态；语义是"系统级失败"，与模型自己说"做不了"严格区分。
- **llmAttempts vs llmCalls**：前者是全部尝试次数（含重试，成本可观测），后者是成功决策数（R6 不变量口径）——重试成本 = llmAttempts - llmCalls。
- **错误文案即协议**：返回给模型的错误措辞是隐式指令，直接决定模型重试、换路还是放弃，需按 prompt 标准设计。

## 面试题

**Q1：工具调用出错时，把异常往外抛和把错误作为 tool 消息回喂给模型，分别意味着什么？**

A：往外抛意味着一次工具故障就炸掉整个 Agent 循环，用户拿到 500，前几轮获取的信息全部作废。回喂则把错误变成模型可读的信息：模型可以换参数重试（B1 瞬时故障后重试成功）、换工具、或如实告知用户（B3 转述"只覆盖北京、上海、深圳"并给出替代）。本实验用 Mock 注入验证了 lookup/parse/validate/execute 四类错误全部能"错误 JSON 回喂 + 循环存活"（A1-A4），前提是 registry.execute 四阶段流水线永不抛出（Day 19 设计）。只有循环层自己撑不住时（LLM 连续失败）才往外抛。

**Q2：LLM API 调用失败时 Agent 该怎么办？重试耗尽后为什么不返回一句"任务失败"的文本而是抛异常？**

A：与工具错误分开处理——工具错误模型看得见，LLM 错误模型看不见，只能由循环层重试（本实验 A5：前 2 次 500 第 3 次成功，`llmAttempts=4` 与 `llmCalls=2` 分开计账）。耗尽后抛 `AgentFailureError` 携带部分状态而不伪造 finished（A6），原因有二：一是语义诚实——"模型说失败"和"系统崩了"是两回事，上层监控需要区分；二是状态可恢复——state 里保留了 messages/toolCalls/iteration（`status=running`），Day 26 Memory 或人工干预后可以从断点继续，而一旦伪造 finished 这条轨迹就被污染了。

**Q3：同样的工具故障，为什么模型有时立即重试、有时一次就放弃？这对设计工具错误消息有什么启示？**

A：错误文案决定行为。Day 24 的"临时不可用，请稍后重试"把重试责任推给用户侧，模型 2/2 选择放弃并把"过一会儿再查"的决策权交还用户；今天的"瞬时故障，立即重试一次通常即可成功"明确告知故障性质和行动建议，模型 2/2 立即重试成功。启示：错误消息是写给模型看的隐式 prompt——应包含故障性质（瞬时/永久）、置信度（重试是否值得）、可执行的下一步（覆盖哪些城市、该换什么参数）。含糊的"请稍后重试"等于把决策成本转嫁给模型，模型会用最保守的方式回应。
