# Day 19：Tool Registry —— 统一注册 / 查找 / 校验 / 执行 / 错误处理

> 日期：2026-10-04
> 模型：deepseek-chat（temperature=0）

## Part A：Registry 能力单元测试（10/10，零 API 成本）

| 用例 | 能力 | 实际值 | 结果 |
|---|---|---|---|
| U1 | 注册/查找：已注册工具存在 | `true` | ✅ |
| U2 | 查找：未注册工具不存在 | `false` | ✅ |
| U3 | 执行：calculator 正确求值 | `{"ok":true,"data":{"expression":"(15+27)*13","result":546}}` | ✅ |
| U4 | 错误处理-lookup：未注册名 | `{"ok":false,"stage":"lookup","error":"未注册的工具：\"fake_tool\""}` | ✅ |
| U5 | 错误处理-parse：参数非 JSON | `"parse"` | ✅ |
| U6 | 参数校验：expression 非字符串 | `"validate"` | ✅ |
| U7 | 参数校验：缺必填 city | `"validate"` | ✅ |
| U8 | 错误处理-execute：除零 | `{"ok":false,"stage":"execute","error":"除数不能为 0"}` | ✅ |
| U9 | 错误处理-execute：未知城市 | `"execute"` | ✅ |
| U10 | 注册：definitions 集合 | `["calculator","get_current_time","get_weather"]` | ✅ |

## Part B：真实 LLM 集成（4/4；Prompt Tokens 4785，Completion Tokens 464）

| 场景 | 说明 | API 轮数 | 工具调用 | 结果 |
|---|---|---|---|---|
| L1 | 单工具（时间） | 2 | 1 | ✅ |
| L2 | 并行双工具（天气+计算器） | 2 | 2 | ✅ |
| L3 | 链式（两城天气→温差） | 3 | 3 | ✅ |
| L4 | 常识不调用 | 1 | 0 | ✅ |

---

## L1：单工具（时间）

- 判分：✅ gold=17:45，答复=17:45
- API 轮数：2
- 工具轨迹：
    - get_current_time args `{"timezone": "Asia/Shanghai"}` → `{"timezone":"Asia/Shanghai","hourMinute":"17:45","date":"2026-10-04","weekday":"星期日"}`
- 最终答复：

```text
现在是 **2026年10月4日（星期日）17:45**，时区为 Asia/Shanghai（北京时间）。
```

---

## L2：并行双工具（天气+计算器）

- 判分：✅ 深圳27°C 命中=true；折扣169.15 命中=true
- API 轮数：2
- 工具轨迹：
    - get_weather args `{"city": "深圳"}` → `{"city":"深圳","observedAt":"2026-10-04T10:00:00+08:00","dataSource":"mock","temperatureC":27,"condition":"中雨","precipitationMm":8}`
    - calculator args `{"expression": "199*0.85"}` → `{"expression":"199*0.85","result":169.15}`
- 最终答复：

```text
两件事都办好了：

**深圳天气**（以下为 Mock 模拟数据，非真实气象信息）
- 观测时间：2026-10-04 10:00（北京时间）
- 气温：27°C
- 天气：中雨
- 降水量：8 mm

出门记得带伞，中雨天气路面湿滑。

**折扣计算**
- 199 × 0.85 = **169.15 元**，即便宜了 29.85 元。
```

---

## L3：链式（两城天气→温差）

- 判分：✅ 两城温度命中=true；温差2命中=true；方向(上海更高)命中=true
- API 轮数：3
- 工具轨迹：
    - get_weather args `{"city": "北京"}` → `{"city":"北京","observedAt":"2026-10-04T10:00:00+08:00","dataSource":"mock","temperatureC":22,"condition":"晴","precipitationMm":0}`
    - get_weather args `{"city": "上海"}` → `{"city":"上海","observedAt":"2026-10-04T10:00:00+08:00","dataSource":"mock","temperatureC":24,"condition":"多云","precipitationMm":0}`
    - calculator args `{"expression": "24-22"}` → `{"expression":"24-22","result":2}`
- 最终答复：

```text
根据工具返回的 Mock 数据（2026-10-04 10:00 观测）：

- **北京**：22°C，晴
- **上海**：24°C，多云

**北京比上海低 2°C。**

注：以上为模拟数据，非真实实时天气。
```

---

## L4：常识不调用

- 判分：✅ 光合作用要素（光合/CO2/O2）齐全=true
- API 轮数：1
- 工具轨迹：
（未调用工具）
- 最终答复：

```text
植物通过叶片气孔吸收二氧化碳、甲醛等气体，并借助光合作用将其转化为氧气和有机物，同时叶面还能吸附粉尘颗粒，从而起到净化空气的作用。
```

---

## 学习笔记

### 1. Registry 的本质：把「工具」从代码分支变成「数据表驱动」

Day 16-18 的编排循环里藏着三处工具相关的硬编码：工具定义数组、执行时的 if/分发、各自的 try/catch。新增第四个工具要改循环、改分发、再抄一遍错误处理。今天的 Registry 让工具成为**注册进表的数据**：

- 工具自描述（definition 给 LLM）、自带校验（zod schema）、自带执行体（run）；
- 编排循环只认识 Registry 一个对象——`tools: registry.definitions()` 决定 LLM 能选什么，`registry.execute(name, args)` 决定请求如何落地。

新增工具 = 一次 `register`，循环零改动。这正是 Day 18 Provider 抽象的升级：Provider 解耦的是"数据来源"，Registry 解耦的是"工具本身"。

### 2. 四阶段流水线：错误被分类，才有可能被针对性处理

execute 把失败明确切成四个 stage，这是今天最有价值的设计：

| stage | 触发条件 | 今天的实测用例 | 合理的处理方向 |
|---|---|---|---|
| lookup | 调用了未注册名 | U4 fake_tool | 检查注册/模型幻觉，不应重试 |
| parse | 参数字符串非 JSON | U5 | 可回喂错误让模型修正 |
| validate | zod 校验不通过 | U6 类型错 / U7 缺字段 | 回喂字段错误清单 |
| execute | 执行体抛业务错误 | U8 除零 / U9 未知城市 | 看错误是否可重试，或转述用户 |

关键设计：**execute 永不抛异常**——所有失败收敛为 `{ok:false, stage, error, details}`。这样编排循环不需要为每个工具写 catch，而且日志里能按 stage 统计失败分布。Day 12 错误分类的思想在工具层完整落地：错误分类是正确处理的前提。validate 的 details 直接给出 zod 的字段路径+消息（如 `city: city 不能为空`），可以原样回喂给模型——错误信息天然可消费。

注册时还有两道一致性检查：重名注册报错、handler.name 与 definition.function.name 不一致报错——防止"模型按 A 名申请、表里按 B 名查找"的低级事故。

### 3. L3 链式调用是今天最好的观察：模型连减法都不心算

L3 用户只问"低几度"，模型自主完成了 3 轮规划：

1. 先并行查北京、上海（同一轮两个 weather 调用）→ 拿到 22°C、24°C；
2. 它没有直接回答，而是**又调了一次 calculator 算 `24-22`** → 2；
3. 才给出"北京比上海低 2°C"。

这个行为超出我的预期——24−22 是最简单的减法，但 system 说"数值计算必须走工具"，它严格执行了。对照 Day 16 的坏行为（无工具时伪造计算器），今天是**同一倾向的好出口**：模型想用工具不可怕，只要 Registry 能接住每一次申请。同时注意三轮链路中每一步的输入都是前一步的真实返回——这就是明天 Day 20 和下周 Agent Loop 的雏形：LLM 不仅选工具，还在多轮间自主规划"下一步需要什么信息"。

### 4. 两种多工具形态的区分

- **L2 并行型**：两件事互不依赖，模型同一轮发出 weather + calculator，2 轮完成；
- **L3 链式型**：第二步的参数（24−22）依赖第一步结果，必须等 weather 返回后才能发起，3 轮完成。

模型对两种形态的选择完全正确，没有把链式问题错误并行（它无法在第一轮就知道温度，也就构造不出减法表达式）。这说明 Function Calling 的"调用规划"包含依赖分析——这是单靠 Prompt 规则写不出来的智能部分。

### 5. 工程纪律今天的复用情况

- 确定性先行：Part A 10 断言全过才放行 Part B（脚本内置 gate），基础设施错误零成本暴露；
- gold 全部来自内置实现；Mock 数据模型照常披露（L2/L3 都标注"非真实气象"）；
- 今天一次通过零返工：编排、校验、错误穿透全部是成熟模式的组装。

成本：Part B 仅 5249 tokens ≈ ¥0.007，是本周工具实验中最低的——工具数量增多反而单次更便宜，因为 system 短、答复精简。真正的成本大头是多轮调用（L3 三轮），而非工具种类。

## 概念卡片

- **ToolRegistry**：name → ToolHandler 的注册表，提供 definitions（喂给 LLM）与 execute（四阶段流水线）两个出口。
- **ToolHandler**：工具的自描述单元 = name + definition(JSON Schema) + schema(zod) + run(执行体)。
- **执行流水线（lookup→parse→validate→execute）**：按失败位置分类的统一执行入口，不抛异常、错误带 stage 返回。
- **数据表驱动**：能力扩展通过注册数据而非修改分发代码实现（开闭原则）。
- **链式工具调用**：后一个调用的参数依赖前一个调用的结果，需跨轮规划；与并行调用相对。

## 面试题

Q：Tool Registry 解决什么问题？没有它会怎样？
> A：没有 Registry 时，工具的定义、分发、参数校验、错误处理散落在编排循环里，每加一个工具都要改循环、抄一遍 try/catch。Registry 让工具成为自描述的注册数据（definition+zod schema+run），编排循环只依赖 registry.definitions() 和 registry.execute()，新增工具零改动循环。今天三个工具注册后，10 条单测全过、4 个 LLM 场景全过。

Q：工具调用失败有哪几种？你们怎么区分？
> A：execute 分四个 stage：lookup（未注册名，多为幻觉/配置错误，不该重试）、parse（参数非 JSON，可回喂修正）、validate（zod 校验不通过，带字段错误清单回喂）、execute（执行体业务错误，如除零/未知城市，按错误性质决定）。统一返回 {ok:false, stage, error} 且不抛异常，编排层无需逐个 catch，还能按 stage 统计失败分布。

Q：LLM 自主规划能力体现在哪？举个例子。
> A：L3 问"北京比上海低几度"，模型先并行查两城天气拿到 22/24，再发起 calculator 算 24-22，三轮后才作答——它识别出这是链式依赖（减法参数要等天气结果），且连最简单的减法都不心算。对比 L2 互不依赖的两件事它正确选择同轮并行。依赖分析与多步规划是模型提供的核心智能，Registry 负责接住每一步申请。

Q：为什么 execute 设计成不抛异常？
> A：工具的错误种类和发生位置需要被分类处理（四阶段），抛异常会迫使编排层为每个工具写 catch、且丢失"错在哪个阶段"的结构信息。返回统一结果对象后，错误可以被序列化进 tool 消息回喂模型、被日志统计、被上层按 stage 路由——错误本身成为可流转的数据，这与 Day 12 错误分类、Day 16 错误穿透一脉相承。
