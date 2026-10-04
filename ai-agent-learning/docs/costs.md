# AI 学习成本记录（成本纪律，Day 1 建立）

> 规则：
> 1. 开发默认用便宜档位（DeepSeek 当前 deepseek-chat 即低价档），非必要不切旗舰模型。
> 2. 明显的实验批量都要记录；先跑 10 条数据验证，再跑全量。
> 3. Embedding / Rerank 结果做本地缓存，同一段文本不重复计费。
> 4. Day 81 汇总本文件，产出"如何把成本降一半"分析。

## 模型档位选择（Day 1）

| 用途 | 模型 | 选择理由 |
|---|---|---|
| 日常开发/对话 | deepseek-chat | 价格低、OpenAI 兼容、国内直连 |
| （预留）复杂推理 | 待定 | 仅在评测对照或卡 bug 时临时使用 |
| Embedding | Day 29 再定 | 届时评估本地模型 vs API |

## 花费流水

| 日期 | 用途 | 模型 | 估算花费(¥) | 备注 |
|---|---|---|---|---|
| 2026-09-24 | 注册充值/首日环境 | - | - | 待填：实际充值金额 |
| 2026-09-28 | Day 8 Prompt 策略对比实验（5 组） | deepseek-chat | ≈0.005 | 共 2776 tokens（prompt 206 + completion 2570）；结论：强 Instruction 策略 token 消耗最低且可控性最好 |
| 2026-09-29 | Day 9 Few Shot 情感分类实验（10 条 × 3 策略 + 首次挂起重跑） | deepseek-chat | ≈0.005 | 成功批次 3599 tokens；示例使 prompt 成本达 zero-shot 的 1.6~2.2 倍；结论：few-shot 修正了 zero-shot 的中性误判，3 条示例即达 10/10 |
| 2026-09-29 | Day 10 Structured Output 意图识别实验（8 条 × 3 策略 + 1 次修复） | deepseek-chat | ≈0.005 | 17 次调用，3309 tokens；结论：json_object 不防 max_tokens 截断（finish_reason=length），Zod 校验 + 错误回喂修复 1 次即救回 |
| 2026-10-03 | Day 11 需求分析器实验（8 条 × 2 策略，0 修复） | deepseek-chat | ≈0.005 | 16 次调用，6044 tokens（prompt 3792 / completion 2252）；结论：基础 prompt 会脑补（把"吃什么"做成推荐系统），反幻觉 prompt 靠"待澄清"机制守住忠实度，代价是 prompt token 约 1.9 倍、偶发过度提问 |
| 2026-10-03 | Day 12 错误处理实验（11 个 mock 场景 + 4 个真实场景共 7 次调用） | deepseek-chat | ≈0.002 | mock 场景零成本；真实场景中 R1 超时×2 / R2 报错×1 无 token，R3 截断恢复×3 + R4 基线×1，估算 ≈1400 tokens；结论：显式超时使挂死场景 321ms 快速失败（vs 最坏陪等约 2400s），401/400 立即失败不重试，真实截断需 max_tokens 8→32→128 两轮自适应才恢复 |
| 2026-10-04 | Day 13 Prompt 优化实验（工单分诊 V1/V2/V3，共 30 次调用） | deepseek-chat | ≈0.02 | 共 12595 tokens（input 10655 / output 1940）；三版类别 0/10→10/10、优先级 0/10→9/10→10/10；关键结论：问题须跑出而非想出，边界示例（闪退≥P1 vs 显示延迟=P2）比堆砌规则有效，规则越清晰 completion 越短（1017→369） |
| 2026-10-04 | Day 15 Tool 概念实验（5 场景，含 1 次两阶段工具调用链路） | deepseek-chat | ≈0.004 | 共 2649 tokens（input 2337 / output 312）；S4 首跑因只回 1 条 tool 消息触发 400，修正并行 tool_calls 编排后全通过；关键结论：模型只输出调用申请单不执行函数，S5 用户压制工具时模型拒猜并反问，敏感操作须在执行层设权限 |
| 2026-10-04 | Day 16 Calculator Tool 实验（8 题 × A/B，含判分器迭代共运行 3 轮） | deepseek-chat | ≈0.035 | 三轮共 ≈25344 tokens（定稿轮 8490：A 1260 / B 7230）；定稿正确率 A 5/8（✅5/⚠️2/🎭1）→ B 8/8；关键结论：temperature=0 下 Q1/Q4/Q8 三轮间状态漂移，判分器从二值升级四态并识别三种伪装（`<calculator>` 伪标签、DSML 内部标记泄漏、口头自称调用），禁用 eval 手写递归下降解析器，除零错误以 `{error}` 穿透两阶段 |
| 2026-10-04 | Day 17 Time Tool 实验（8 场景，判分器修正共 3 轮） | deepseek-chat | ≈0.03 | 定稿轮精确 7768 tokens（prompt 6797 / completion 971，14 API 轮）；前两轮精确值被覆盖（其一 7735）；定稿 8/8；关键结论：Intl 探针校验时区（S7 Atlantis/Nowhere 被拦截），S6 火星模型调用门前直接拒绝，S4/S5 并行 tool_calls 处理同一瞬间两时区；判分器误杀修复两轮（中文硬匹配→构造式正则兼容年/月日/前导零），7 条单测校准通过 |
| 2026-10-04 | Day 18 Weather Tool 实验（8 场景，首轮通过） | deepseek-chat | ≈0.012 | 精确 8724 tokens（prompt 6911 / completion 1813，15 API 轮）；8/8 一次通过零迭代；关键结论：WeatherProvider 抽象 + Mock 固定快照可替换真实 API，dataSource 标签下模型全程披露非真实观测，工具层归一化（后缀/英文/拼音 7 条单测校准），S4 决策型（带伞）/S6 对比型（广州更热）验证"工具给事实模型做判断" |
| 2026-10-04 | Day 19 Tool Registry 实验（Part A 单测 10 条零成本 + Part B LLM 4 场景） | deepseek-chat | ≈0.007 | Part B 精确 5249 tokens（prompt 4785 / completion 464），Part A 零 API；单测 10/10、LLM 4/4 一次通过；关键结论：ToolHandler 自描述 + Registry 数据表驱动，execute 四阶段流水线（lookup/parse/validate/execute）不抛异常，L3 链式三轮（两城天气→calculator 24-22）验证模型自主依赖规划，注册含重名/名称一致性检查 |
| 2026-10-04 | Day 20 多个 Tool 实验（4 工具 8 场景，gold 修复共 2 轮） | deepseek-chat | ≈0.017 | 定稿轮精确 12768 tokens（prompt 11617 / completion 1151），gold 修复前一轮明细被报告覆盖；定稿选择 7/8、答案 8/8；关键结论：S4 过度调用（只问股价却主动加算涨幅，两轮稳定复现，allowedTools 白名单捕获），S6 链式 search→calculator 涨幅 4.84%、S8 并行天气+搜索；S1 gold 手误（误写 7007542，真实 7006652）沉淀 gold 同源原则；工具固定税使 prompt 为 Day 19 的 2.4 倍 |
| 2026-10-04 | Day 22 Agent Loop 实验（7 场景，判分修正共 2 轮） | deepseek-chat | ≈0.014 | 定稿轮精确 9843 tokens（prompt 8781 / completion 1062，14 LLM 轮）；首轮 6 场景明细被报告覆盖；定稿 7/7 全部 finished；关键结论：终止权交给模型（无 tool_calls 即 finished），A4 火星基地零调用=调用前语义拦截、A7 重庆=execute 错误穿透（两防线对照），AgentStep 结构化记录可判分/调试/为 Day 27 思考链 UI 铺路，临时安全上限 8（Day 24 正式 MAX_ITERATIONS=10） |
| 2026-10-04 | Day 23 Agent State 实验（Part A 状态单测 7 条零成本 + Part B LLM 4 场景，共 3 轮运行） | deepseek-chat | ≈0.007（定稿轮，前两轮见注） | 定稿轮精确 5154 tokens（prompt 4677 / completion 477）；前两轮（含补 token 字段的中间轮）用量因报告覆盖未保留；定稿单测 7/7、LLM 4/4；关键结论：AgentState 显式容器（messages/toolCalls/iteration/status/token），状态不变量由单测守护；B2 同输入两次运行工具调用数 4 vs 3（一次多了无关 get_current_time）实证工具选择噪声，snapshot 可序列化但仅摘要，Day 24 读 iteration 设上限、Day 26 复用 messages 做 Memory |
| 2026-10-04 | Day 24 MAX_ITERATIONS 实验（Part A Mock 死循环单测 7 条零成本 + Part B 真实 4 场景，共 2 轮全量运行） | deepseek-chat | ≈0.015 | 两轮全量共 ≈10533 tokens（定稿轮 prompt 4707 / completion 517；前一轮 5309 因 TS 类型修复后复跑，首跑止于 Part A 零 API）；单测 7/7、真实 4/4；关键结论：Mock 无限循环恰好第 10 轮截停且第 10 轮 tool_calls 先执行完（协议不允许悬空），强制收尾=去 tools 物理断绝+失败兜底，llmCalls=MAX+1=11 预算守恒；中毒工具（永远返回请重试）2/2 只调 1 次即放弃并如实转述，真实模型未触发上限——上限靠 Mock 验证、真实模型只验证不误伤；不变量检查器 R1-R6 含 A7 抽走 tool 回传自校准 |
| 2026-10-04 | Day 25 错误处理实验（Part A 五类错误 Mock 注入 7 条零成本 + Part B 真实 3 场景，1 轮通过） | deepseek-chat | ≈0.006 | Part B 精确 4576 tokens（prompt 4171 / completion 405，8 次 LLM 调用），Part A 零 API；单测 7/7、真实 3/3 一次通过；关键结论：五类错误闭环——lookup/parse/validate/execute 错误 JSON 回喂循环存活（registry 永不抛出），LLM 失败循环层重试（llmAttempts 与 llmCalls 分账）耗尽抛 AgentFailureError 携带部分状态不伪造 finished，组合故障靠 Day 24 上限兜底；错误文案即协议：瞬时故障文案下模型 2/2 自愈重试成功（vs Day 24「请稍后重试」2/2 放弃），失败路径也要过不变量（iteration 自增时机修正） |
| 2026-10-04 | Day 26 Agent Memory 实验（Part A 三策略+协议闸 Mock 单测 7 条零成本 + Part B 真实 full vs window 对比 2 场景×3 轮，共 2 轮运行：首轮 T5/T6 设计缺陷修复后复跑，Part B 仅定稿轮跑 1 遍） | deepseek-chat | ≈0.009 | Part B 精确 6561 tokens（prompt 6074 / completion 487，8 次 LLM 调用），Part A 零 API；单测 7/7、真实 2/2；关键结论：Memory=messages 管理策略（探针 T5/T6 同 LLM 同问题仅策略不同→记得/不知道），失忆后模型称「你从未告诉过我」——裁剪改写模型眼中的历史；裁剪必须以轮为原子（T3 R2' 协议零违规，防悬空 tool_calls）；窗口 K 语义=保留最近 K 轮，失忆发生在提问轮−记忆轮>K（初版两轮设计踩坑改三轮）；成本实证：B1 消息数 2→6→10 但 promptTokens 1027→1372→739（消息数是粗代理），B2 第 3 轮 531 vs B1 739 省 28% 但全失忆；工具能力是请求级、记忆是消息级 |
| 2026-10-04 | Day 27 Agent UI（事件化 Agent 循环 + /api/agent/stream SSE + 前端思考链时间线；curl 1 次 + 浏览器端到端 2 次 Agent 运行验证） | deepseek-chat | ≈0.005 | curl 直连精确 1193 tokens（prompt 1077 / completion 116，2 轮决策+1 次工具调用）；浏览器验证 2 次运行（天气+calculator）≈2.2k tokens 未逐条捕获为估算；单次天气查询 = thinking→tool_call→tool_result→thinking→answer→done 完整事件链；关键结论：思考链来自 assistant 消息 content 字段（Function Calling 协议自带叙述，可能为空不可依赖），事件化=AgentState 数据换 onEvent 输出节奏，前端过程只进 steps 不进对话历史（过程对下轮无价值白烧 token），done 事件把轮数/工具次数/tokens 透明给用户；浏览器 6/6 通过（weather 22°C+Mock 声明、calculator 56088） |
