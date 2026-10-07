# Day 28：第一阶段验收 + 缓冲日

> 日期：2026-10-07
> 性质：验收日（不引入新知识点）+ 缓冲日（打磨 README / 补欠债）

## 今日目标

- [x] 验收 Phase 1 全部交付物（AI Chat / Structured Output / Tool Calling / 手写 Agent / Memory / Agent 状态展示）
- [x] 跑通端到端冒烟（真实 LLM 少量调用）
- [x] 打磨 README，覆盖 Day 1–27 完整能力
- [x] npm run build 零错误
- [x] 成本记录

## 验收方法

脚本：`server/src/experiments/day28-phase1-acceptance.ts`

分两部分：

### Part A：确定性验收（零 API 成本，7 项）

| # | 验收项 | 验证内容 |
|---|---|---|
| A1 | calculator 四则运算 | `1+2*3=7`、`(1+2)*3=9`、`10/4=2.5`、`2^10=1024` |
| A2 | calculator 错误处理 | 除零抛错、缺少运算符抛错 |
| A3 | get_current_time 时区 | 上海时区返回时分+日期，非法时区（Mars/Olympus）抛错 |
| A4 | get_weather Mock | 北京 22°C / dataSource=mock，未覆盖城市抛错 |
| A5 | Registry 四阶段 | lookup（未注册）/ parse（非法 JSON）/ validate（类型错）/ execute（正常） |
| A6 | trimHistory 截断 | system + 最后一条 user 必留，中间超预算消息丢弃 |
| A7 | MAX_ITERATIONS | 常量 = 10；get_current_time 注册链路完整 |

### Part B：真实 LLM 端到端冒烟（4 项）

| # | 场景 | 结果 | token |
|---|---|---|---|
| B1 | 普通对话「1+1 等于几」 | ✅ 返回 2 | — |
| B2 | Structured Output json_object | ✅ 解析出 intent 字段 | — |
| B3 | Agent 天气查询 | ✅ thinking→tool_call(get_weather)→tool_result→answer→done(finished)，2 轮 / 1 工具 | 1070+112 |
| B4 | Agent 计算器 123×456 | ✅ calculator 返回 56088，答案含 56088 | — |

**真实 LLM 总消耗：prompt=2190 / completion=180 / total=2370 tokens**

## 验收结论

**11/11 全部通过。** 第一阶段六大交付物均已闭环：

| 交付物 | 覆盖天数 | 核心能力 |
|---|---|---|
| AI Chat | Day 1–6 | 多轮对话 / SSE 流式 / Markdown / 多会话 / Stop / token 截断 |
| Structured Output | Day 8–13 | json_object / Zod 校验 / 错误回喂修复 / Prompt 优化 |
| Tool Calling | Day 15–20 | calculator / time / weather / Registry 四阶段流水线 |
| 手写 Agent | Day 22–25 | while 循环 / 模型自主终止 / MAX_ITERATIONS=10 / LLM 重试 |
| Memory | Day 26 | 历史透传 / 轮原子裁剪 / token 预算 |
| Agent 状态展示 | Day 27 | 事件化 SSE / 思考链时间线 / 前端 UI |

## 缓冲日打磨

- README 从「第一周」扩展为「第一阶段全量」，补齐 Tool Calling / Agent / 事件流等章节
- 项目结构说明更新为 `server/src/agent/`（含 tools.ts / registry.ts / agent.ts）

## 分析与学习笔记

1. **验收脚本本身也是回归测试**：把各天的核心断言集中到一个脚本，后续重构时一键回归，比分散在各 day 脚本里更高效。
2. **`1++2` 不是非法表达式**：递归下降解析器的 parseUnary 支持一元 `+/-`，所以 `1++2` = `1 + (+2)` = 3。测试用例要理解解析器语义后再写，不能想当然。
3. **事件化 Agent 的验收只需检查事件序列**：不需要断言具体文本，只要 thinking/tool_call/tool_result/answer/done 五类事件齐全且 stopReason=finished，就证明链路完整。
4. **缓冲日的价值**：Phase 1 没有欠债，缓冲日用来打磨 README 和补验收脚本，比提前学 Phase 2 更划算——提前学会透支后面的缓冲。

## 概念卡片

- **验收冒烟（Smoke Test）**：用最少的真实调用验证端到端链路是否连通，不追求覆盖率，追求"通路没断"。
- **回归测试**：把历史功能的断言固化，每次改动后重跑，防止新代码破坏旧能力。
- **一元运算符**：`+`/`-` 可作为前缀作用于单个操作数（如 `+2`、`-3`），写解析器时需在 parseFactor 与 parsePrimary 之间插入 parseUnary 层。

## 面试题

### Q1：为什么 `1++2` 在你的计算器里等于 3 而不是报错？
A：因为解析器实现了一元运算符层（parseUnary），`+` 作为前缀时表示正号。`1++2` 被解析为 `1 + (+2)`，即 `1 + 2 = 3`。这是数学上合法的，Python/JS 等语言也遵循同样规则。测试用例需要区分"语法非法"和"语义合法但写法 unusual"。

### Q2：验收 Agent 时为什么只检查事件类型而不检查答案文本？
A：因为 LLM 输出有采样方差（即使 temperature=0，不同运行也可能有措辞差异），断言具体文本会让测试变脆。事件序列（thinking→tool_call→tool_result→answer→done）是协议级的确定性行为，只要事件齐全且 stopReason=finished，就证明工具调用链路和终止逻辑正确。答案正确性由各天的专项实验（Day 16/17/18）单独保障。

### Q3：缓冲日为什么不建议提前学下一阶段？
A：缓冲日的设计目的是"为失败路径留预算"。如果提前学后面的内容，等于把缓冲透支了——一旦后面某天滑期，就没有缓冲可用，只能熬夜追赶或砍内容。缓冲日没有欠债时，应打磨现有项目（UI、README、测试），这些是边际收益稳定的工作。

## 成本

| 项目 | 值 |
|---|---|
| 模型 | deepseek-chat |
| 调用次数 | 4 次（B1–B4） |
| tokens | prompt=2190 / completion=180 / total=2370 |
| 估算花费 | ≈¥0.004 |

## 明日目标

Day 29：Embedding —— 调通 Embedding API，对 5 句文本生成向量，结果落本地缓存。
