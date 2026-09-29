# Day 9：Few Shot 文本分类实验

> 日期：2026-09-29
> 模型：deepseek-chat（temperature=0）
> 任务：电商评论情感三分类（positive / negative / neutral），只允许输出 JSON
> 计划要求示例：输入「这个产品太垃圾了」→ 输出 `{"sentiment": "negative"}`

## 总览

| 策略 | 与参考标签一致数 | JSON 可解析数 | Prompt Tokens（10 条累计） | Completion Tokens |
|---|---|---|---|---|
| Zero Shot（只给指令） | 9/10 | 10/10 | 712 | 70 |
| Few Shot（3 条基础示例） | 10/10 | 10/10 | 1152 | 62 |
| Few Shot（5 条含边界示例） | 10/10 | 10/10 | 1542 | 61 |

## 逐条对照

| # | 评论 | 参考标签 | Zero Shot | Few Shot 基础 | Few Shot 边界 |
|---|---|---|---|---|---|
| 1 | 这个产品太垃圾了 | 👎 negative | 👎 negative ✅ | 👎 negative ✅ | 👎 negative ✅ |
| 2 | 太好用了，强烈推荐给大家 | 👍 positive | 👍 positive ✅ | 👍 positive ✅ | 👍 positive ✅ |
| 3 | 东西收到了，包装完好 | ➖ neutral | 👍 positive ❌ | ➖ neutral ✅ | ➖ neutral ✅ |
| 4 | 呵呵，可真“好用”呢，第二天就开不了机 | 👎 negative | 👎 negative ✅ | 👎 negative ✅ | 👎 negative ✅ |
| 5 | 价格有点小贵，不过质量确实没话说 | 👍 positive | 👍 positive ✅ | 👍 positive ✅ | 👍 positive ✅ |
| 6 | 物流一般般，中规中矩吧 | ➖ neutral | ➖ neutral ✅ | ➖ neutral ✅ | ➖ neutral ✅ |
| 7 | 等了三天才发货，不过客服态度还可以 | ➖ neutral | ➖ neutral ✅ | ➖ neutral ✅ | ➖ neutral ✅ |
| 8 | 无语，再也不会买了 | 👎 negative | 👎 negative ✅ | 👎 negative ✅ | 👎 negative ✅ |
| 9 | 已经回购第三次了 | 👍 positive | 👍 positive ✅ | 👍 positive ✅ | 👍 positive ✅ |
| 10 | 好评，但是发货慢了点 | 👍 positive | 👍 positive ✅ | 👍 positive ✅ | 👍 positive ✅ |

图例：👍 positive ｜ 👎 negative ｜ ➖ neutral ｜ ❗ 模型输出无法解析为 JSON

---

## 策略：Zero Shot（只给指令）

**验证点：** 不给任何示例，只靠 system 指令完成分类

**注入的示例：**

（无示例）

**10 条分类结果：**

1. 这个产品太垃圾了
   - 参考：negative｜模型：negative ✅
   - 原始输出：`{"sentiment": "negative"}`
2. 太好用了，强烈推荐给大家
   - 参考：positive｜模型：positive ✅
   - 原始输出：`{"sentiment": "positive"}`
3. 东西收到了，包装完好
   - 参考：neutral｜模型：positive ❌
   - 原始输出：`{"sentiment": "positive"}`
4. 呵呵，可真“好用”呢，第二天就开不了机
   - 参考：negative｜模型：negative ✅
   - 原始输出：`{"sentiment": "negative"}`
5. 价格有点小贵，不过质量确实没话说
   - 参考：positive｜模型：positive ✅
   - 原始输出：`{"sentiment": "positive"}`
6. 物流一般般，中规中矩吧
   - 参考：neutral｜模型：neutral ✅
   - 原始输出：`{"sentiment": "neutral"}`
7. 等了三天才发货，不过客服态度还可以
   - 参考：neutral｜模型：neutral ✅
   - 原始输出：`{"sentiment": "neutral"}`
8. 无语，再也不会买了
   - 参考：negative｜模型：negative ✅
   - 原始输出：`{"sentiment": "negative"}`
9. 已经回购第三次了
   - 参考：positive｜模型：positive ✅
   - 原始输出：`{"sentiment": "positive"}`
10. 好评，但是发货慢了点
   - 参考：positive｜模型：positive ✅
   - 原始输出：`{"sentiment": "positive"}`

---

## 策略：Few Shot（3 条基础示例）

**验证点：** 用最典型的三类示例教会模型输出格式

**注入的示例：**

- 「这个产品太垃圾了」→ `negative`
- 「质量不错，下次还来」→ `positive`
- 「收到货了」→ `neutral`

**10 条分类结果：**

1. 这个产品太垃圾了
   - 参考：negative｜模型：negative ✅
   - 原始输出：`{"sentiment": "negative"}`
2. 太好用了，强烈推荐给大家
   - 参考：positive｜模型：positive ✅
   - 原始输出：`{"sentiment":"positive"}`
3. 东西收到了，包装完好
   - 参考：neutral｜模型：neutral ✅
   - 原始输出：`{"sentiment":"neutral"}`
4. 呵呵，可真“好用”呢，第二天就开不了机
   - 参考：negative｜模型：negative ✅
   - 原始输出：`{"sentiment":"negative"}`
5. 价格有点小贵，不过质量确实没话说
   - 参考：positive｜模型：positive ✅
   - 原始输出：`{"sentiment":"positive"}`
6. 物流一般般，中规中矩吧
   - 参考：neutral｜模型：neutral ✅
   - 原始输出：`{"sentiment":"neutral"}`
7. 等了三天才发货，不过客服态度还可以
   - 参考：neutral｜模型：neutral ✅
   - 原始输出：`{"sentiment": "neutral"}`
8. 无语，再也不会买了
   - 参考：negative｜模型：negative ✅
   - 原始输出：`{"sentiment":"negative"}`
9. 已经回购第三次了
   - 参考：positive｜模型：positive ✅
   - 原始输出：`{"sentiment":"positive"}`
10. 好评，但是发货慢了点
   - 参考：positive｜模型：positive ✅
   - 原始输出：`{"sentiment":"positive"}`

---

## 策略：Few Shot（5 条含边界示例）

**验证点：** 增加反讽、转折两个边界示例，教模型判定规则

**注入的示例：**

- 「这个产品太垃圾了」→ `negative`
- 「质量不错，下次还来」→ `positive`
- 「收到货了」→ `neutral`
- 「可真行啊，用了两天就坏了」→ `negative`（反讽：表面是夸，实际在骂）
- 「包装破了点，但东西没问题，给个好评」→ `positive`（转折句：以“但”之后的真实态度为准）

**10 条分类结果：**

1. 这个产品太垃圾了
   - 参考：negative｜模型：negative ✅
   - 原始输出：`{"sentiment":"negative"}`
2. 太好用了，强烈推荐给大家
   - 参考：positive｜模型：positive ✅
   - 原始输出：`{"sentiment":"positive"}`
3. 东西收到了，包装完好
   - 参考：neutral｜模型：neutral ✅
   - 原始输出：`{"sentiment":"neutral"}`
4. 呵呵，可真“好用”呢，第二天就开不了机
   - 参考：negative｜模型：negative ✅
   - 原始输出：`{"sentiment":"negative"}`
5. 价格有点小贵，不过质量确实没话说
   - 参考：positive｜模型：positive ✅
   - 原始输出：`{"sentiment":"positive"}`
6. 物流一般般，中规中矩吧
   - 参考：neutral｜模型：neutral ✅
   - 原始输出：`{"sentiment":"neutral"}`
7. 等了三天才发货，不过客服态度还可以
   - 参考：neutral｜模型：neutral ✅
   - 原始输出：`{"sentiment":"neutral"}`
8. 无语，再也不会买了
   - 参考：negative｜模型：negative ✅
   - 原始输出：`{"sentiment": "negative"}`
9. 已经回购第三次了
   - 参考：positive｜模型：positive ✅
   - 原始输出：`{"sentiment":"positive"}`
10. 好评，但是发货慢了点
   - 参考：positive｜模型：positive ✅
   - 原始输出：`{"sentiment":"positive"}`

---

## 分析与学习笔记

### 1. Zero Shot vs Few Shot：唯一的错误差在哪

| 策略 | 正确数 | JSON 可解析 | Prompt Tokens（10 条累计） |
|---|---|---|---|
| Zero Shot | 9/10 | 10/10 | 712 |
| Few Shot 基础（3 示例） | **10/10** | 10/10 | 1152 |
| Few Shot 边界（5 示例） | **10/10** | 10/10 | 1542 |

唯一分歧是第 3 条「东西收到了，包装完好」：

- Zero Shot 判成 `positive`——被"完好"这个轻微褒义词带偏，把"陈述事实"当成了"表扬"。
- Few Shot 判 `neutral`——因为示例里有一条「收到货了」→ `neutral`，模型从例子里学会了一条**指令里没有明说的边界规则**："纯陈述收货/物流事实，即使带轻微正面词，也归中性"。

**这就是 Few Shot 的核心价值：Example 不只教格式，更在教"判定边界"。** 指令写"中性=无情感倾向"很抽象，一个「收到货了」的例子立刻让边界具体化。

### 2. 边界示例为什么没拉开差距（要诚实记录）

加了反讽、转折两个边界示例后，正确率仍是 10/10，没有提升。原因：

1. **当前模型（deepseek-chat）能力够强**：反讽（第 4 条）、转折（第 5、10 条）Zero Shot 本身就答对了，示例没有发挥空间。
2. **测试集不够难**：10 条评论覆盖的边界类型有限。若换成更隐晦的反讽（如"真是一次难忘的购物体验呢👍"），或换更小的模型（mini 档），差距才可能显现。
3. 结论：**Few Shot 是"保险"而不是"万能药"**——模型越强、任务越简单，示例的边际收益越低；但在输出格式不稳定、分类标准主观（如"投诉严重程度分级"）的场景，示例仍是最便宜的提稳手段。

### 3. 模型连格式细节都在模仿示例

对比原始输出可以发现：Few Shot 组的 JSON 空格风格都跟着示例走（示例 `JSON.stringify` 输出无空格时，模型多数回复也无空格；偶尔又自己加空格）。说明 few-shot 下模型在**整体模仿**示例的分布，而不只是提取标签——这也是为什么示例本身的质量（格式统一、标签平衡）会影响输出质量。

### 4. 成本：示例每次请求都要重发

模型无状态，5 条示例不会被"记住"，每一次分类请求都要把示例完整重发一遍：

- Zero Shot：712 tokens / 10 条
- 3 示例：1152 tokens（**1.6 倍**）
- 5 示例：1542 tokens（**2.2 倍**）

工程取舍：**示例越多越稳，但 prompt 成本线性上涨**。生产中做法是：用少量（2~5 条）高信息量示例，且各类别数量平衡，避免模型偏向高频标签。

### 5. 样例泄漏：第 1 条不能算数

测试集第 1 条「这个产品太垃圾了」与示例完全相同，三种策略必然都答对——它验证的是"模型会照抄"，不是"模型会泛化"。评测时训练示例和测试用例必须严格分开，否则正确率虚高。

### 6. 实验中的真实故障：API 请求挂死

首次运行时，第 8 条请求卡住 4 分钟无响应（非报错，是连接静默挂起）。处理方式：

1. OpenAI SDK 调用加 `timeout: 30_000`（默认超时太长，等不起）；
2. 失败自动重试最多 3 次，间隔 2s；
3. 单条用例重试耗尽后记为失败案例，**不中断整批实验**。

这是 Day 12「API 超时/错误处理」的一次真实预演：**网络故障不会以异常形式友好地抛出来，很多时候就是"永远不返回"**，生产代码必须主动设超时。

## 概念卡片

- **Zero Shot**：只给指令不给示例。模型能力越强、任务定义越清晰，zero-shot 越够用。
- **Few Shot**：指令 + 少量示例。示例的作用 = 演示输出格式 + 示范判定边界。
- **Example 选择原则**：① 每个类别至少 1 条且数量平衡；② 优先放"指令难以描述、模型容易错"的边界 case；③ 示例格式就是你想要的输出格式；④ 示例不能与真实评测用例重合。

## 面试题

Q：Few Shot 的示例越多效果越好吗？
> A：不是。① 示例边际收益递减，模型/任务简单时 2~3 条就够；② 示例每次请求都占 prompt token，成本线性上涨；③ 低质量或类别不平衡的示例反而会带偏模型。应优先选择覆盖判定边界的高信息量示例。

Q：Zero Shot 和 Few Shot 怎么选？
> A：任务定义清晰、模型能力够（如简单二分类）先试 Zero Shot；当输出格式不稳定，或分类标准主观、边界模糊、指令难以精确描述时，用 Few Shot 把"只可意会"的标准用例子示范出来。
