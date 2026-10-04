# Day 24：MAX_ITERATIONS —— 给 Agent 循环装上硬上限

> 日期：2026-10-04
> 模型：deepseek-chat（temperature=0；Part A 为脚本化 Mock，零 API 成本）

## 设计要点

- `MAX_ITERATIONS = 10`：第 10 轮的 tool_calls 仍执行完（协议不允许悬空），随后**去掉 tools 强制收尾**一次，让模型基于已有信息总结；收尾失败写入明确兜底答复。
- 预算守恒：`llmCalls = iteration + (强制收尾?1:0) ≤ MAX_ITERATIONS + 1`，死循环最坏成本可计算。
- 不变量检查器 R1-R6 随每次运行校验（含 A7 对检查器本身的校准）。

## Part A：Mock 死循环单测（7/7，零 API）

| 用例 | 断言 | 结果 | 详情 |
|---|---|---|---|
| A1 | 正常流程：2 轮结束、上限未触发、不变量全部通过 | ✅ | `stopReason=finished iter=2 llmCalls=2 违规=0` |
| A2 | 死循环复现：恰好第 10 轮截停、强制收尾成功、不变量通过 | ✅ | `iter=10 llmCalls=11 tools=10 answer="[Mock 收尾] 已执行 10 轮计算，均为 1+1=2，" 违规=0` |
| A3 | 上限可配置：MAX=3 恰好第 3 轮截停、llmCalls=4 | ✅ | `iter=3 llmCalls=4 违规=0` |
| A4 | 收尾失败兜底：forcedFinalOk=false、兜底答复入历史、不变量通过 | ✅ | `forcedFinalOk=false answer="[Agent 已达到最大迭代次数（4），收尾调用失败：Mock 强制收尾调用网络" 违规=0` |
| A5 | 预算守恒：llmCalls = iteration+1 = MAX_ITERATIONS+1 ≤ 11 | ✅ | `llmCalls=11，公式=iteration(10)+收尾(1)` |
| A6 | 并行调用：单轮 2 个 tool_calls 均有对应 tool 回传、不变量通过 | ✅ | `tools=2 iter=2 违规=0` |
| A7 | 校准检查器：抽走 tool 回传后必须报 R2/R3 违规（防止检查器形同虚设） | ✅ | `违规数=2，首条=R2 违规：第 2 条 assistant 的 1 个 tool_calls 未被等量同 id 的 tool 消息紧跟` |

## Part B：真实 LLM（4/4；Prompt Tokens 4707，Completion Tokens 517）

| 场景 | 说明 | MAX | 轮数 | llmCalls | 工具次数 | stopReason | 结果 |
|---|---|---|---|---|---|---|---|
| B1 | 正常链式·search→calculator（上限不误伤） | 10 | 3 | 3 | 3 | finished | ✅ |
| B2 | 零工具·常识（1 轮即结束） | 10 | 1 | 1 | 0 | finished | ✅ |
| B3 | 中毒工具·第 1 次（MAX=3 观察放弃行为） | 3 | 2 | 2 | 1 | finished | ✅ |
| B4 | 中毒工具·第 2 次（MAX=3 报分布） | 3 | 2 | 2 | 1 | finished | ✅ |

---

## B1：正常链式·search→calculator（上限不误伤）

- 判分：✅ gold 差额=11.64 命中=true；gold 涨幅=4.84% 命中=true；stopReason=finished；序列=search → calculator → calculator
- 用户输入：特斯拉股价相比上一交易日收盘价涨了多少美元？涨幅百分之多少？
- MAX_ITERATIONS=10；状态快照：`{"status":"finished","stopReason":"finished","iteration":3,"maxIterations":10,"llmCalls":3,"forcedFinalAttempted":false,"forcedFinalOk":false,"messageCount":8,"toolCallCount":3,"promptTokens":2010,"completionTokens":228,"lastRole":"assistant","updatedAt":"2026-10-04T12:23:31.349Z"}`
- 不变量检查：✅ 零违规
- 工具记录：
    ✓ #1 第1轮 search `{"query": "特斯拉 TSLA 股价 今日 涨跌幅"}` → `{"query":"特斯拉 TSLA 股价 今日 涨跌幅","searchedAt":"2026-10-04T12:23:29.546Z","dataSource":"mock","results":[{"title":"TSLA 行情（Mock）","snippet":"特斯拉(TSLA)报 252.14 美元，上一...`
    ✓ #2 第2轮 calculator `{"expression": "252.14 - 240.50"}` → `{"expression":"252.14 - 240.50","result":11.639999999999986}`
    ✓ #3 第2轮 calculator `{"expression": "(252.14 - 240.50) / 240.50 * 100"}` → `{"expression":"(252.14 - 240.50) / 240.50 * 100","result":4.839916839916834}`
- 最终答复：

```text
**特斯拉（TSLA）股价变动**

- 当前价：252.14 美元
- 上一交易日收盘价：240.50 美元
- **上涨金额：11.64 美元**
- **涨幅：约 4.84%**

⚠️ 说明：以上数据来自 Mock（模拟）数据源，并非真实市场行情，仅供参考。如需真实股价，请查询实际行情终端。
```

---

## B2：零工具·常识（1 轮即结束）

- 判分：✅ gold=100；iteration=1；工具=0；stopReason=finished
- 用户输入：水在标准大气压下沸点是多少？
- MAX_ITERATIONS=10；状态快照：`{"status":"finished","stopReason":"finished","iteration":1,"maxIterations":10,"llmCalls":1,"forcedFinalAttempted":false,"forcedFinalOk":false,"messageCount":3,"toolCallCount":0,"promptTokens":507,"completionTokens":91,"lastRole":"assistant","updatedAt":"2026-10-04T12:23:32.182Z"}`
- 不变量检查：✅ 零违规
- 工具记录：
（零调用）
- 最终答复：

```text
水在标准大气压（1 atm = 101.325 kPa）下的沸点是 **100 °C**（摄氏度），即 **212 °F**，对应热力学温度 **373.15 K**。

这是常识性物理常数，无需调用工具。需要说明的是，沸点会随气压变化：气压降低沸点下降（如高原上水不到 100 °C 就沸腾），气压升高则沸点上升。
```

---

## B3：中毒工具·第 1 次（MAX=3 观察放弃行为）

- 判分：✅ get_weather 尝试=1 次；stopReason=finished；如实转述=true；llmCalls=2
- 用户输入：北京现在天气怎么样？多少度？
- MAX_ITERATIONS=3；状态快照：`{"status":"finished","stopReason":"finished","iteration":2,"maxIterations":3,"llmCalls":2,"forcedFinalAttempted":false,"forcedFinalOk":false,"messageCount":5,"toolCallCount":1,"promptTokens":1087,"completionTokens":88,"lastRole":"assistant","updatedAt":"2026-10-04T12:23:33.506Z"}`
- 不变量检查：✅ 零违规
- 工具记录：
    ✗ #1 第1轮 get_weather `{"city": "北京"}` → `{"error":"天气服务临时不可用（查询了 \"北京\"），请稍后重试","stage":"execute"}` [execute]
- 最终答复：

```text
抱歉，天气服务临时不可用，我暂时查不到北京当前的天气和温度。

建议你稍后再让我重试一次，或者直接查看手机天气 App / 中国天气网获取实时数据。需要我过一会儿再试吗？
```

---

## B4：中毒工具·第 2 次（MAX=3 报分布）

- 判分：✅ get_weather 尝试=1 次；stopReason=finished；如实转述=true；llmCalls=2
- 用户输入：帮我看看深圳今天多少度，要不要带伞？
- MAX_ITERATIONS=3；状态快照：`{"status":"finished","stopReason":"finished","iteration":2,"maxIterations":3,"llmCalls":2,"forcedFinalAttempted":false,"forcedFinalOk":false,"messageCount":5,"toolCallCount":1,"promptTokens":1103,"completionTokens":110,"lastRole":"assistant","updatedAt":"2026-10-04T12:23:35.436Z"}`
- 不变量检查：✅ 零违规
- 工具记录：
    ✗ #1 第1轮 get_weather `{"city": "深圳"}` → `{"error":"天气服务临时不可用（查询了 \"深圳\"），请稍后重试","stage":"execute"}` [execute]
- 最终答复：

```text
抱歉，天气服务临时不可用，我暂时查不到深圳今天的实时天气。

建议你：
- 稍等片刻让我再试一次；
- 或者直接打开手机自带天气 App / 中国天气网查看深圳实时温度与降水概率。

需要我过一会儿再帮你查一次吗？
```

---

## 学习笔记

1. **上限逻辑必须用确定性手段验证，真实模型反而测不出来。** Part A 用脚本化 Mock LLM 复现死循环（永远重复同一个工具调用），A2 证实恰好第 10 轮截停（`iter=10, llmCalls=11, tools=10`），A3 证实上限可配置（MAX=3 恰好第 3 轮）。而 Part B 真实模型配合度太高，中毒场景（B3/B4）根本触发不了上限——上限是**基础设施逻辑**而非模型行为逻辑，用测试替身（Mock）验证是唯一可靠路径，且零 API 成本。
2. **协议一致性优先于"及时止损"。** 触发上限时第 10 轮的 tool_calls 仍全部执行并回传（A2：tools=10），因为悬空的 assistant tool_calls 会让消息历史违反 OpenAI 协议（R2 不变量）——下次带着这种历史调 API 会被直接拒绝，状态既不能恢复也不能审计。正确顺序：先执行完、再收尾。
3. **强制收尾是"软着陆"，物理断绝而非口头劝阻。** 达到上限后去掉 `tools` 参数再调一次 LLM（A2 答复是总结性文字而非占位符）——模型想继续调工具也没有工具可调，比在 prompt 里求它"别再调了"可靠得多。A4 验证收尾调用自身失败时的兜底：明确失败答复写入历史，R4 不变量仍成立，不会静默挂掉。
4. **真实模型对"请重试"类错误的反应比预期保守。** 中毒工具 2/2 场景（B3 北京、B4 深圳）都只调用 1 次 get_weather 就放弃并如实转述（"天气服务临时不可用，我暂时查不到"），B4 还把"过一会儿再查"的决策权交还用户（"需要我过一会儿再帮你查一次吗？"）。推论：这条错误文案把重试责任推给了用户侧，模型选择不冒险；若工具返回"空成功"或文案是"请自行重试"，行为很可能不同。所以上限仍是必需兜底，但**工具错误策略（Day 25）才是控制重试行为的第一道闸门**。
5. **上限对正常链路零误伤。** B1 链式 search→calculator×2（第 2 轮并行两个 calculator，序列 `search → calculator → calculator`）3 轮自然结束；B2 零工具 1 轮结束。都远低于 10，`forcedFinalAttempted=false`，上限完全透明。
6. **预算守恒把死循环从"可用性事故"变成"容量规划问题"。** A5：最坏 `llmCalls = MAX_ITERATIONS + 1 = 11`。死循环的最坏成本从"无限"变成"可计算"，这正是生产环境敢开 Agent 功能的前提——先知道最坏花多少钱，再决定上限设多少。

## 概念卡片

- **MAX_ITERATIONS**：Agent 循环的硬上限（本实验取 10），限制 LLM 决策轮数；达到后不再依赖模型自觉，强制进入收尾流程。
- **强制收尾（forced finalize）**：达到上限后去掉 tools 参数再调用一次 LLM，要求基于已获取的信息总结作答的"软着陆"机制；失败时写入明确兜底答复。
- **悬空 tool_calls**：assistant 消息带了 tool_calls 却没有等量同 id 的 tool 回传消息，违反 OpenAI 协议，后续调用会被拒——截停前必须先把工具执行完。
- **预算守恒**：`llmCalls = iteration + (强制收尾?1:0) ≤ MAX_ITERATIONS + 1`，使死循环的最坏成本可静态计算。
- **测试替身（Mock LLM）**：用脚本化决策函数替换真实模型，确定性复现死循环等真实运行中罕见的路径，零成本验证基础设施逻辑。

## 面试题

**Q1：Agent 循环为什么必须有最大迭代次数？达到上限时直接 break 退出有什么问题？**

A：模型决定是否调用工具，而采样天然带方差（Day 23 B2 实证过同一输入工具调用数 4 vs 3），异常情况下可能无限请求工具，烧掉无上限的 token。但"直接 break"有两个问题：一是悬空 tool_calls 违反消息协议，历史不可恢复；二是用户只拿到一句生硬的占位符，前 10 轮获取的信息全部浪费。更好的做法（本实验 A2/A4）：执行完最后一轮工具 → 去掉 tools 强制收尾一次让模型总结 → 收尾失败再写明确兜底答复，同时用 `llmCalls ≤ MAX+1` 保证最坏成本可计算。

**Q2：一个"正常运行时永远不会触发"的保护逻辑（如死循环上限），怎么测试它真的有效？**

A：用测试替身。把 LLM 抽象为可注入的决策函数（本实验 `LLMFn` 接口），测试时换成脚本化 Mock——脚本耗尽后永远重复同一工具调用，即确定性的无限循环。这样可以精确断言：恰好第 N 轮截停、LLM 调用次数 = N+1、消息历史满足协议不变量、收尾失败时的兜底路径（A1-A7，零 API 成本）。真实模型只用来验证"保护不误伤正常流程"（B1/B2），因为它配合度太高、根本无法稳定触发死循环。

**Q3：达到上限的那一轮，assistant 的 tool_calls 应该丢弃还是执行完？为什么？**

A：必须执行完。OpenAI 协议要求每个带 tool_calls 的 assistant 消息后紧跟等量同 id 的 tool 消息（本实验 R2 不变量），否则下次调用 API 直接被拒，且状态无法持久化/恢复。本实验 A2 显示第 10 轮的工具照常执行（tools=10），全部回传后才进入强制收尾；A7 还校准了检查器本身——故意抽走一条 tool 回传，R2/R3 立即报违规，防止检查器形同虚设。
