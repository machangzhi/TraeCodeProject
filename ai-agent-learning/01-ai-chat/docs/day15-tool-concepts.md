# Day 15：Tool 概念 —— Function Calling 协议观察

> 日期：2026-10-04
> 模型：deepseek-chat（temperature=0）
> 总调用：5 个场景；Prompt Tokens 2337，Completion Tokens 312

## 核心命题

```text
LLM + Tool = 可以操作外部世界
LLM 负责决策（要不要调、调哪个、参数是什么）
程序负责执行（真正运行函数、回传结果）
```

## 场景总览

| 场景 | 说明 | 工具 | 首轮 finish_reason | 是否调用工具 | Prompt Tokens | Completion Tokens |
|---|---|---|---|---|---|---|
| S1 | 无工具 + 问实时时间（没有手的模型） | 无 | stop | 否 | 35 | 34 |
| S2 | 有工具 + 问实时时间（完整两阶段协议） | 有 | tool_calls | 是 → 1 次 | 796 | 66 |
| S3 | 有工具 + 问常识（应该不调用） | 有 | stop | 否 | 346 | 28 |
| S4 | 有工具 + 参数信息不足 | 有 | tool_calls | 是 → 1 次 | 807 | 124 |
| S5 | 有工具 + 用户要求绕过工具 | 有 | stop | 否 | 353 | 60 |

---

## S1：无工具 + 问实时时间（没有手的模型）

- 用户输入：现在几点了？请直接告诉我具体时间。
- 是否提供工具：否
- 模型本轮未请求任何工具，直接给出普通答复

**最终答复**：

```text
我无法直接告诉你当前的具体时间，因为我需要实时获取信息，而我目前没有可用的工具来查询。建议你查看手机、电脑或手表上的时间。
```

### 协议原始记录

**第 1 轮 · 模型响应（finish_reason=stop）**

```json
{
  "finish_reason": "stop",
  "message": {
    "role": "assistant",
    "content": "我无法直接告诉你当前的具体时间，因为我需要实时获取信息，而我目前没有可用的工具来查询。建议你查看手机、电脑或手表上的时间。"
  }
}
```

---

## S2：有工具 + 问实时时间（完整两阶段协议）

- 用户输入：现在几点了？请直接告诉我具体时间。
- 是否提供工具：是（get_current_time）
- 模型在本轮请求了 **1** 次工具调用：
  - `get_current_time` id=`call_00_RSZofroTimaPW2mLcQcg9229` args=`{"timezone": "Asia/Shanghai"}` → 执行结果 `{"timezone":"Asia/Shanghai","now":"2026年10月04日星期日 10:59:05","iso":"2026-10-04T02:59:05.640Z"}`

**最终答复**：

```text
现在是北京时间（Asia/Shanghai）2026年10月4日 星期日 10:59:05。
```

### 协议原始记录

**第 1 轮 · 模型响应（finish_reason=tool_calls）**

```json
{
  "finish_reason": "tool_calls",
  "message": {
    "role": "assistant",
    "content": "",
    "tool_calls": [
      {
        "index": 0,
        "id": "call_00_RSZofroTimaPW2mLcQcg9229",
        "type": "function",
        "function": {
          "name": "get_current_time",
          "arguments": "{\"timezone\": \"Asia/Shanghai\"}"
        }
      }
    ]
  }
}
```

**第 1 轮 · 程序执行后回传的 tool 消息**

```json
[
  {
    "role": "tool",
    "tool_call_id": "call_00_RSZofroTimaPW2mLcQcg9229",
    "content": "{\"timezone\":\"Asia/Shanghai\",\"now\":\"2026年10月04日星期日 10:59:05\",\"iso\":\"2026-10-04T02:59:05.640Z\"}"
  }
]
```

**第 2 轮 · 模型响应（finish_reason=stop）**

```json
{
  "finish_reason": "stop",
  "message": {
    "role": "assistant",
    "content": "现在是北京时间（Asia/Shanghai）2026年10月4日 星期日 10:59:05。"
  }
}
```

---

## S3：有工具 + 问常识（应该不调用）

- 用户输入：用一句话解释什么是时区。
- 是否提供工具：是（get_current_time）
- 模型本轮未请求任何工具，直接给出普通答复

**最终答复**：

```text
时区是地球上按经度划分的、各自采用同一标准时间的区域，目的是让各地的时间与当地的昼夜变化大致对应。
```

### 协议原始记录

**第 1 轮 · 模型响应（finish_reason=stop）**

```json
{
  "finish_reason": "stop",
  "message": {
    "role": "assistant",
    "content": "时区是地球上按经度划分的、各自采用同一标准时间的区域，目的是让各地的时间与当地的昼夜变化大致对应。"
  }
}
```

---

## S4：有工具 + 参数信息不足

- 用户输入：我那边现在是白天还是晚上？
- 是否提供工具：是（get_current_time）
- 模型在本轮请求了 **1** 次工具调用：
  - `get_current_time` id=`call_00_oxgTPUobz1BsdxThg8iC8232` args=`{"timezone": "Asia/Shanghai"}` → 执行结果 `{"timezone":"Asia/Shanghai","now":"2026年10月04日星期日 10:59:07","iso":"2026-10-04T02:59:07.745Z"}`

**最终答复**：

```text
如果你在中国（Asia/Shanghai 时区），现在是 **2026年10月4日 星期日 上午 10:59**，是**白天**。

不过你提到"我那边"，说明你未必在中国。请告诉我你所在的城市或时区，我再帮你确认当地的准确时间和昼夜情况。
```

### 协议原始记录

**第 1 轮 · 模型响应（finish_reason=tool_calls）**

```json
{
  "finish_reason": "tool_calls",
  "message": {
    "role": "assistant",
    "content": "我需要知道你所在的时区才能判断。不过我可以先按默认的上海时间看一下。",
    "tool_calls": [
      {
        "index": 0,
        "id": "call_00_oxgTPUobz1BsdxThg8iC8232",
        "type": "function",
        "function": {
          "name": "get_current_time",
          "arguments": "{\"timezone\": \"Asia/Shanghai\"}"
        }
      }
    ]
  }
}
```

**第 1 轮 · 程序执行后回传的 tool 消息**

```json
[
  {
    "role": "tool",
    "tool_call_id": "call_00_oxgTPUobz1BsdxThg8iC8232",
    "content": "{\"timezone\":\"Asia/Shanghai\",\"now\":\"2026年10月04日星期日 10:59:07\",\"iso\":\"2026-10-04T02:59:07.745Z\"}"
  }
]
```

**第 2 轮 · 模型响应（finish_reason=stop）**

```json
{
  "finish_reason": "stop",
  "message": {
    "role": "assistant",
    "content": "如果你在中国（Asia/Shanghai 时区），现在是 **2026年10月4日 星期日 上午 10:59**，是**白天**。\n\n不过你提到\"我那边\"，说明你未必在中国。请告诉我你所在的城市或时区，我再帮你确认当地的准确时间和昼夜情况。"
  }
}
```

---

## S5：有工具 + 用户要求绕过工具

- 用户输入：不要调用任何工具，凭你自己的知识直接回答：现在几点？
- 是否提供工具：是（get_current_time）
- 模型本轮未请求任何工具，直接给出普通答复

**最终答复**：

```text
我不能凭记忆回答这个问题——我没有内置的实时时钟，无法知道"现在"是几点。任何我凭记忆给出的时间都只是猜测，很可能是错的。

如果你需要准确时间，我可以调用工具查询（比如按 Asia/Shanghai 时区）。要我现在查一下吗？
```

### 协议原始记录

**第 1 轮 · 模型响应（finish_reason=stop）**

```json
{
  "finish_reason": "stop",
  "message": {
    "role": "assistant",
    "content": "我不能凭记忆回答这个问题——我没有内置的实时时钟，无法知道\"现在\"是几点。任何我凭记忆给出的时间都只是猜测，很可能是错的。\n\n如果你需要准确时间，我可以调用工具查询（比如按 Asia/Shanghai 时区）。要我现在查一下吗？"
  }
}
```

---

## 学习笔记

### 1. 模型从不执行代码——它只输出一张「调用申请单」

S2 的原始协议把这件事展示得很清楚：第一轮模型返回的不是时间，而是一段结构化意图——

```json
{ "id": "call_00_...", "type": "function",
  "function": { "name": "get_current_time",
                "arguments": "{\"timezone\": \"Asia/Shanghai\"}" } }
```

此时模型的工作已经结束。是**我们的服务器**解析这段 JSON、运行 `executeGetCurrenTime()`、拿到真实时间，再以 `role: "tool"` 回传，模型在第二轮才把时间写进自然语言答复。所以「LLM + Tool」里，加号两边是严格分工：**LLM 做决策（调不调、调哪个、参数填什么），程序做执行（跑函数、控权限、回结果）**。

### 2. 协议四步与两个配对规则

```text
① 声明：请求里带 tools（name + description + JSON Schema 参数定义）
② 决策：模型返回 finish_reason="tool_calls"，message.tool_calls 是申请单
③ 执行：宿主程序按 name 找到真实函数、校验参数、执行
④ 回传：把 assistant(tool_calls) 原样入历史，再追加 role="tool" 消息，第二轮得到最终答复
```

今天实测出的两条硬规则：

- **每个 tool_call_id 都必须有一条 tool 消息回应**。S4 首次运行时代码只处理了 `tool_calls[0]`，API 直接以 400 拒绝：`An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'`——因为**一轮里可以并行返回多个 tool_calls**，少回一个都不行。
- **assistant 的调用意图必须原样保留在历史中**，tool 消息挂在它后面，模型才知道结果对应哪次申请。

### 3. 调用决策本身是智能的，且 content 与 tool_calls 能共存

| 场景 | 模型的决策 | 证据 |
|---|---|---|
| S2 明确需要 | 调用，参数填默认时区 | finish_reason=tool_calls |
| S3 纯知识问题 | **不调用**，直接回答 | finish_reason=stop，省下一整轮 |
| S4 参数不足 | 用默认值先查，同时在 content 里声明"我先按上海时间"，最终答复邀请用户补充时区 | content 与 tool_calls 同时非空 |

S4 尤其说明模型不是"见到工具就用"：它知道信息不完整，于是用「默认假设 + 显式声明 + 请求澄清」的方式推进，而不是把默认值伪装成确定答案——这正是 Day 11「待澄清」机制在工具场景的再现。

### 4. S5 的张力：用户指令、系统规则与工具之间谁说了算

用户明令"不要调用工具，凭知识回答现在几点"，模型没有调用（用户指令成功压制了工具使用），但也没有编造时间，而是选择第三条路：**拒绝猜测 + 反问"要我现在查一下吗？"**。这给出一条重要边界：

- "是否使用工具"同时受 system 和 user 影响，用户可以让模型**不用**工具；
- 但 system 中"禁止凭记忆猜测当前时间"的规则，让模型在不用工具时也**不敢硬答**。

推到生产环境：如果某个工具涉及删数据、退款、发消息等不可逆操作，**绝不能只依赖模型自觉调用或用户一句话授权**——必须在程序执行层做权限校验和二次确认。工具给了模型手，但手能碰什么，由程序决定。

### 5. 工具补上的是「能力缺口」，同时是「幻觉护栏」

S1 vs S2 是最直观的对照：同一个问题，无工具时模型回答"我无法获取实时信息"（诚实），有工具时 10:59:05 的答案与本地执行结果逐字一致。需要注意不造稻草人——今天 S1 的模型本身是诚实的，工具主要是在**给它本来没有的能力（实时时钟）**；但对于更容易硬答的场景（如 Day 13 的计算类问题），工具同时承担"让答案基于确定结果而非概率生成"的护栏作用。

## 概念卡片

- **Tool（Function）**：写给模型看的能力说明书，含 name、description、按 JSON Schema 描述的 parameters；它与真正的执行函数是两份东西，仅靠 name 关联。
- **tool_call**：模型输出的结构化调用申请单，含全局唯一 id、函数名、JSON 字符串形式的参数；出现时 `finish_reason="tool_calls"`。
- **两阶段协议**：决策轮（模型给申请）→ 程序执行并以 `role:"tool"` 回传 → 第二轮模型给最终自然语言答复。
- **tool_call_id 配对**：assistant 的 tool_calls 与后续 tool 消息必须一一对应，支持一轮多个并行调用，缺失即 400。
- **编排循环（Agent Loop 雏形）**：宿主程序循环执行"收到响应 → 有 tool_calls 就执行回传 → 再请求"，直到模型返回 stop；必须设轮数上限防死循环。

## 面试题

Q：讲一下 Function Calling 的完整流程，模型真的执行函数了吗？
> A：没有。流程是：① 请求中通过 tools 声明工具（名称、描述、JSON Schema 参数）；② 模型若判断需要，返回 `finish_reason="tool_calls"`，内容是结构化申请单（id、函数名、JSON 参数），它本身不接触任何运行环境；③ 宿主程序解析申请、校验参数、执行真实函数；④ 把模型的 assistant 消息和 `role:"tool"` 的结果消息一起发回，模型第二轮基于真实结果组织答复。今天 S2 实测：申请参数 Asia/Shanghai → 程序返回 10:59:05 → 最终答复逐字使用该结果。

Q：「LLM 负责决策，程序负责执行」这种分工有什么安全意义？
> A：模型能决定的只是"想调什么、参数是什么"，真正的执行权、权限边界都在程序手里。第一，工具实现在我们服务器上，API Key 和内部系统不暴露给模型和前端；第二，程序可以在执行前做参数校验、权限检查和不可逆操作的二次确认，模型即使给出危险申请也会被拦住；第三，一轮多个并行调用时程序可以统一控制。今天还实测到用户可以指令模型不调用工具（S5），说明工具决策并非纯靠模型自觉——敏感操作必须在执行层设防。

Q：如果用户说"别调用工具，直接凭你的知识告诉我现在几点"，模型该怎么处理？
> A：今天的 S5 给出了标准答案：既不调用工具（尊重用户指令），也不编造时间（遵守 system 中"禁止凭记忆猜测实时信息"的规则），而是明确告知"我没有实时时钟，凭记忆给出的时间只会是猜测"，并反问"需要我调用工具查一下吗？"。这比"听话硬答"和"无视用户直接调用"都更稳妥——把决策权交还给用户，同时不牺牲事实可靠性。
