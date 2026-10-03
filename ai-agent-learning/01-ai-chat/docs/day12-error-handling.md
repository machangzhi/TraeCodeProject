# Day 12：错误处理实验

> 日期：2026-10-03
> 模型：mock fetch（零成本）+ deepseek-chat（真实烟雾场景）
> 任务：验证 LLM 结构化调用在超时 / API 错误 / 限流 / 空响应 / 截断 / 非法 JSON / Schema 错误下的恢复与降级

## 错误处理决策矩阵

| 错误类型 | 识别方式 | 可重试 | 处理策略 |
|---|---|---|---|
| 超时 | `APIConnectionTimeoutError` | ✅ | 指数退避重试，预算耗尽降级 |
| 连接失败 | `APIConnectionError`（DNS/拒连） | ✅ | 指数退避重试 |
| 429 限流 | `RateLimitError` | ✅ | 优先按 `Retry-After` 等待，否则退避 |
| 5xx | `InternalServerError` | ✅ | 指数退避重试 |
| 401 鉴权 | `AuthenticationError` | ❌ | 立即失败，告警/检查 Key |
| 403 权限 | `PermissionDeniedError` | ❌ | 立即失败 |
| 400/404/409/422 | `BadRequestError` 等 | ❌ | 立即失败，修参数/代码（重试无意义） |
| choices 空 / content null | 响应健全性检查 | ✅（恢复轮） | 重新请求 |
| finish_reason=length | 截断检测 | ✅（恢复轮） | max_tokens ×4 后重发 |
| JSON.parse 失败 | 语法检查 | ✅（恢复轮，限次数） | 带格式提示重试 |
| Zod Schema 失败 | Schema 校验 | ✅（恢复轮，限次数） | 错误清单回喂修复 |
| 未知错误 | 兜底 | ❌ | 降级 + 记录原始错误名 |

关键工程点：**SDK 自带重试（默认 2 次）被显式关闭（maxRetries: 0），重试策略由应用层统一控制**，
否则错误分类、等待时长和调用次数都会被 SDK 黑盒接管，无法观测和测试。

## 场景总览

| # | 层 | 场景 | 触发方式 | 最终分类 | 结局 | API 调用次数 | 退避等待合计(ms) | 耗时(ms) |
|---|---|---|---|---|---|---|---|---|
| M1 | mock 网络层 | 连续两次 500 后成功 | `mock 依次返回 500 / 500 / 200` | success | ✅ 成功 | 3 | 32 | 75 |
| M2 | mock 网络层 | 429 限流（Retry-After: 0）后成功 | `mock 返回 429 且 Retry-After: 0，再返回 200` | success | ✅ 成功 | 2 | 0 | 16 |
| M3 | mock 网络层 | 持续 429，重试预算耗尽降级 | `mock 恒定返回 429（Retry-After: 0）` | rate_limit | ⚠️ 降级 | 3 | 0 | 30 |
| M4 | mock 网络层 | 401 鉴权失败，立即失败不重试 | `mock 返回 401` | auth_error | ⚠️ 降级 | 1 | 0 | 2 |
| M5 | mock 网络层 | 400 参数错误，立即失败不重试 | `mock 返回 400` | bad_request | ⚠️ 降级 | 1 | 0 | 0 |
| M6 | mock 恢复层 | 空响应：choices 为空数组 | `mock 首次返回 {choices: []}，二次正常` | success | ✅ 成功 | 2 | 0 | 2 |
| M7 | mock 恢复层 | 空内容：content 为 null | `mock 首次 content=null/finish_reason=stop，二次正常` | success | ✅ 成功 | 2 | 0 | 1 |
| M8 | mock 网络层 | 请求挂死触发超时（快速失败，不陪等） | `mock hang；timeout=50ms，maxRetries=3，baseDelay=10` | timeout | ⚠️ 降级 | 4 | 51 | 321 |
| M9 | mock 恢复层 | JSON 截断：finish_reason=length | `首次返回半截 JSON/finish_reason=length（max_tokens=8），二次正常` | success | ✅ 成功 | 2 | 0 | 1 |
| M10 | mock 恢复层 | LLM 输出散文：JSON.parse 失败 | `首次返回中文解释（finish_reason=stop），二次正常` | success | ✅ 成功 | 2 | 0 | 1 |
| M11 | mock 恢复层 | Schema 不合法：字段类型错误 | `首次返回 {"module":123,...}，错误回喂后二次正常` | success | ✅ 成功 | 2 | 0 | 1 |
| R1 | 真实 API | 真实 API：10ms 超时 | `timeout=10ms，maxRetries=1（真实 DeepSeek）` | timeout | ⚠️ 降级 | 2 | 12 | 74 |
| R2 | 真实 API | 真实 API：不存在的模型 | `model=no-such-model-xyz` | bad_request | ⚠️ 降级 | 1 | 0 | 130 |
| R3 | 真实 API | 真实 API：截断 JSON 自动恢复 | `max_tokens=8 强制 length，第二轮自动加大（真实 DeepSeek）` | success | ✅ 成功 | 3 | 0 | 2502 |
| R4 | 真实 API | 真实 API：正常基线 | `max_tokens=512，标准一轮成功（真实 DeepSeek）` | success | ✅ 成功 | 1 | 0 | 1270 |

---

## 恢复链路详情

### M6：空响应：choices 为空数组

触发：mock 首次返回 {choices: []}，二次正常

- 轮次 1：**empty_response** — 响应体 choices 为空数组
- 轮次 2：**success** — 请求成功，JSON 语法与 Schema 均通过

最终数据：

```json
{
  "module": "演示模块",
  "pages": [
    "页面A"
  ],
  "components": [
    "组件A"
  ],
  "api": [
    "接口A"
  ],
  "risks": [
    "风险A"
  ]
}
```

### M7：空内容：content 为 null

触发：mock 首次 content=null/finish_reason=stop，二次正常

- 轮次 1：**empty_content** — content 为空（finish_reason=stop）
- 轮次 2：**success** — 请求成功，JSON 语法与 Schema 均通过

最终数据：

```json
{
  "module": "演示模块",
  "pages": [
    "页面A"
  ],
  "components": [
    "组件A"
  ],
  "api": [
    "接口A"
  ],
  "risks": [
    "风险A"
  ]
}
```

### M9：JSON 截断：finish_reason=length

触发：首次返回半截 JSON/finish_reason=length（max_tokens=8），二次正常

- 轮次 1：**truncated** — finish_reason=length，输出 22 字符半截 JSON；下一轮 max_tokens 8→32
- 轮次 2：**success** — 请求成功，JSON 语法与 Schema 均通过

最终数据：

```json
{
  "module": "演示模块",
  "pages": [
    "页面A"
  ],
  "components": [
    "组件A"
  ],
  "api": [
    "接口A"
  ],
  "risks": [
    "风险A"
  ]
}
```

### M10：LLM 输出散文：JSON.parse 失败

触发：首次返回中文解释（finish_reason=stop），二次正常

- 轮次 1：**json_parse** — JSON.parse 失败：输出是散文/解释文字而非 JSON
- 轮次 2：**success** — 请求成功，JSON 语法与 Schema 均通过

最终数据：

```json
{
  "module": "演示模块",
  "pages": [
    "页面A"
  ],
  "components": [
    "组件A"
  ],
  "api": [
    "接口A"
  ],
  "risks": [
    "风险A"
  ]
}
```

### M11：Schema 不合法：字段类型错误

触发：首次返回 {"module":123,...}，错误回喂后二次正常

- 轮次 1：**schema_invalid** — module: Expected string, received number
- 轮次 2：**success** — 请求成功，JSON 语法与 Schema 均通过

最终数据：

```json
{
  "module": "演示模块",
  "pages": [
    "页面A"
  ],
  "components": [
    "组件A"
  ],
  "api": [
    "接口A"
  ],
  "risks": [
    "风险A"
  ]
}
```

### R3：真实 API：截断 JSON 自动恢复

触发：max_tokens=8 强制 length，第二轮自动加大（真实 DeepSeek）

- 轮次 1：**truncated** — finish_reason=length，输出 19 字符半截 JSON；下一轮 max_tokens 8→32
- 轮次 2：**truncated** — finish_reason=length，输出 80 字符半截 JSON；下一轮 max_tokens 32→128
- 轮次 3：**success** — 请求成功，JSON 语法与 Schema 均通过

最终数据：

```json
{
  "module": "用户认证",
  "pages": [
    "登录页"
  ],
  "components": [
    "登录表单",
    "用户名输入框",
    "密码输入框",
    "登录按钮",
    "错误提示"
  ],
  "api": [
    "POST /api/auth/login",
    "GET /api/auth/session"
  ],
  "risks": [
    "未明确登录方式（账号密码/手机号/邮箱/第三方）",
    "未明确是否需要验证码、记住我、找回密码",
    "未明确登录成功后的跳转与权限控制",
    "未明确错误提示与安全策略（锁定、限流）"
  ]
}
```

### R4：真实 API：正常基线

触发：max_tokens=512，标准一轮成功（真实 DeepSeek）

- 轮次 1：**success** — 请求成功，JSON 语法与 Schema 均通过

最终数据：

```json
{
  "module": "账户查询",
  "pages": [
    "账户查询首页",
    "账户详情页",
    "交易明细页"
  ],
  "components": [
    "账户卡片",
    "余额展示组件",
    "交易列表",
    "筛选器",
    "分页控件",
    "加载状态",
    "错误提示"
  ],
  "api": [
    "GET /api/accounts",
    "GET /api/accounts/{accountId}",
    "GET /api/accounts/{accountId}/transactions",
    "POST /api/auth/verify"
  ],
  "risks": [
    "身份验证方式未明确（密码、指纹、人脸？）",
    "交易明细的查询范围与分页策略待确认",
    "账户余额实时性要求（是否需要实时刷新？）",
    "敏感信息展示是否需要脱敏？",
    "自助终端硬件交互（如凭条打印）是否需集成？"
  ]
}
```

---

## 分析与学习笔记

### 1. 错误处理的核心不是 try/catch，而是「分类 → 决策 → 留痕」

同样是抛异常，恢复语义完全不同：超时/5xx/429 重试可能成功；401 重试 100 次还是 401（Key 不会自己变对）；400 重试更是纯浪费。M4/M5 实测立即失败、只调用 1 次，M3 则把 3 次预算用满——**重试预算只该花在"病因可能自行消失"的错误上**。决策结果还必须留痕（原始错误构造名、status、等待时长），否则线上失败时只能看到一句"LLM 调用失败"，无法定位。

### 2. 快速失败比慢成功重要：超时是给"不确定性"定价

M8 是最有说服力的数字对比：服务端挂死时，若不显式设超时（SDK 默认 10 分钟），4 次尝试最坏要陪等约 **2400 秒**；设置 timeout=50ms 后总耗时 **321ms** 即收敛为降级结果。这与 Day 9 遇到的"静默挂死 4 分钟"、记忆中"默认超时长达 10 分钟"是同一类问题——**网络请求的不确定性必须用显式超时定价**，否则一个挂死连接会拖垮整个请求链路（Express 中还会占用连接池）。

### 3. 退避的两个工程细节：jitter 与 Retry-After

- **jitter（抖动）**：指数退避若所有客户端用同一公式，失败后会在同一时刻集体重试，形成"重试风暴"把正在恢复的服务再次压垮（二次雪崩）。本次用 0.5~1.0 随机系数打散。
- **Retry-After 是服务端的权威信号**：M2 中服务端明确说"等 0 秒"，就不该机械执行本地退避公式。M3 里每条 429 都带 Retry-After: 0，因此 3 次尝试 30ms 快速打满预算——快速失败本身也是成本保护。

### 4. 真实场景的教训：恢复参数一次可能不够，所以要分层 + 限轮数

R3 与 mock M9 的行为差异是本次最真实的收获：

| 轮次 | max_tokens | 真实结果 |
|---|---|---|
| 1 | 8 | length，19 字符半截 JSON |
| 2 | 32 | **仍然 length**，80 字符半截 JSON |
| 3 | 128 | ✅ 成功 |

mock 里 ×4 一次就够，真实模型输出更长——**任何"我算过一次就够"的假设在真实分布面前都可能失效**。由此得出三条结论：① 恢复必须限制总轮数（本次 4 轮），防止坏输入下无限重试烧钱；② "检测到截断就加大预算"的自适应方向正确，两轮收敛；③ 更优策略是**首次就给结构化输出足够的 max_tokens**（DeepSeek 官方文档明确建议），恢复轮只是兜底而非常规路径。

### 5. 降级不是崩溃：给下游一个可读、可决策的结果

M3/M4/M5/M8/R1/R2 六个失败场景全部返回结构化 fallback（含错误分类与消息），而不是把异常堆栈抛给前端。调用方拿到 fallback 后可以：向用户展示友好提示（"服务繁忙，请稍后再试"）、触发告警（401 → 通知运维查 Key）、或走备用模型/缓存。**错误处理的终点是"系统在失败路径下仍有定义明确的行为"，这与正常路径同等重要。**

### 6. 方法论：错误处理逻辑用注入式 mock 测试，真实 API 只做烟雾验证

500、429、空 choices、content=null 这类错误在真实 API 上不可控、不可复现，还烧钱。通过 OpenAI 构造参数注入自定义 `fetch`，11 个场景确定性复现、零成本、可重复运行；真实 API 只跑 4 个场景验证分类器对**真实**错误（`APIConnectionTimeoutError`、400 包装类）的识别。这与前端单测中 mock axios 测试错误分支是同一思路——**先让错误处理代码本身可测试，它才会在真正出故障时可信。**

### 7. 成本

mock 场景零 API 成本；真实场景共 7 次调用（R1×2 超时无 token、R2×1 报错无 token、R3×3、R4×1），估算 token 消耗极低，整体 ≈ ¥0.002。

## 概念卡片

- **错误分类（Error Classification）**：把 SDK 错误映射为带 `retryable` 标记的业务错误类型，是重试/降级决策的依据。
- **指数退避 + jitter**：等待时长按重试次数指数增长并随机打散，避免重试风暴。
- **Retry-After**：429/503 响应中服务端给出的权威等待时长，优先于本地退避公式。
- **快速失败（Fail Fast）**：用显式超时为请求的不确定性定价，避免无界等待拖垮系统。
- **优雅降级（Graceful Degradation）**：重试预算耗尽后返回定义明确的 fallback 结果，而非抛出未处理异常。
- **注入式测试**：通过构造参数替换 `fetch` 实现，确定性地制造错误，让错误处理逻辑可单测。

## 面试题

Q：LLM API 请求超时应该怎么设计？为什么不能无限等？
> A：每次请求显式设置超时（如 30s，SDK 默认可能长达 10 分钟）；超时被分类为可恢复错误，按指数退避 + jitter 重试有限次数；预算耗尽后降级返回友好结果。无限等的代价是：挂死连接会占满服务端资源/连接池、用户请求被无限阻塞，且真实故障（Day 9 遇到过静默挂死 4 分钟）永远无法自愈。实验中 hang 场景设超时后 321ms 收敛，不设则最坏陪等约 2400 秒。

Q：哪些 LLM API 错误不应该重试？
> A：病因不会自行消失的错误：401（Key 错误/过期）、403（权限不足）、400（请求参数本身不合法）、404/409/422。重试这些只会浪费时间、加剧限流，正确动作是立即失败并告警/修代码。可重试的是超时、连接失败、5xx 和 429——且 429 要尊重 Retry-After。

Q：生产环境的错误处理逻辑怎么验证？
> A：两层：① 通过依赖注入替换 HTTP 层（如 OpenAI SDK 的自定义 fetch），用 mock 确定性构造 500/429/空响应/截断等场景做可重复的单测，零成本；② 用真实 API 跑少量烟雾场景，验证对真实 SDK 错误类型的分类。不能靠"等线上真的出故障"来检验错误处理代码。
