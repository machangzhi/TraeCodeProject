# 10年前端开发 → AI Agent 开发：4个月每日执行计划

> 周期：16周 / 112天  
> 建议投入：工作日 2～3 小时，周末 4～6 小时  
> 学习原则：30%理论 + 70%编码  
> 核心目标：从高级前端工程师转型为具备 LLM、RAG、Tool Calling、MCP、Agent、LangGraph、Node.js 后端能力的 AI 应用 / AI Agent 开发工程师。

---

# 0. 使用说明

## 每天固定节奏

### 工作日 2～3小时

- 30分钟：理论 / 官方文档
- 60～90分钟：编码
- 30分钟：加入项目
- 15～30分钟：总结 / 面试题

### 周末 4～6小时

- 70%：项目开发
- 20%：技术学习
- 10%：总结和复盘

## 每天必须留下

- [ ] Git Commit
- [ ] 可运行代码
- [ ] 1条学习笔记
- [ ] 1个面试问题
- [ ] 遇到的问题及解决方案

## 四个月最终项目

1. AI Chat
2. 企业知识库 RAG
3. Vue Project MCP
4. Enterprise AI Coding Agent

---

# 第一阶段：LLM 应用开发基础

## 第1周：LLM API + Streaming

### Day 1：AI应用开发环境

目标：

- [ ] Node.js环境确认
- [ ] TypeScript环境确认
- [ ] Vue3 + Vite项目创建
- [ ] Node.js后端项目创建
- [ ] Git仓库创建

实践：

```text
ai-agent-learning/
├── 01-ai-chat/
├── 02-rag/
├── 03-mcp/
└── 04-ai-coding-agent/
```

验收：

- [ ] 前端能启动
- [ ] Node后端能启动
- [ ] Git正常提交

---

### Day 2：第一次调用LLM

学习：

- Model
- API Key
- Messages
- System
- User
- Assistant

编码：

```text
用户输入
↓
Node.js
↓
LLM API
↓
返回答案
```

验收：

- [ ] 能通过Node调用LLM
- [ ] API Key不出现在前端
- [ ] 能解释System/User/Assistant区别

---

### Day 3：Chat API

实现：

- [ ] Chat接口
- [ ] POST /api/chat
- [ ] 前端发送消息
- [ ] 后端调用LLM
- [ ] 返回答案

验收：

```text
Vue
 ↓
POST /api/chat
 ↓
Node
 ↓
LLM
 ↓
Response
```

---

### Day 4：Streaming

学习：

- Streaming
- SSE
- Chunk
- Connection

实践：

```text
LLM
 ↓
Stream
 ↓
Node SSE
 ↓
Vue
 ↓
逐字显示
```

验收：

- [ ] AI回答逐步出现
- [ ] 不需要等待完整回答
- [ ] 能解释SSE工作过程

---

### Day 5：Chat UI

实现：

- [ ] Markdown
- [ ] Code Highlight
- [ ] 用户消息
- [ ] AI消息
- [ ] Loading
- [ ] Stop按钮

---

### Day 6：Conversation

实现：

```text
conversation
├── message1
├── message2
├── message3
└── message4
```

学习：

- Context
- Conversation History
- Token限制

---

### Day 7：周复盘

必须完成：

- [ ] AI Chat可运行
- [ ] Streaming
- [ ] Markdown
- [ ] Conversation

回答：

1. Token是什么？
2. Context Window是什么？
3. SSE为什么适合LLM Streaming？
4. API Key为什么不能放前端？
5. 多轮对话为什么会增加Token消耗？

产出：

```text
01-ai-chat/README.md
```

---

# 第2周：Prompt + Structured Output

## Day 8：Prompt基础

学习：

- System Prompt
- User Prompt
- Role
- Context
- Instruction

实践：

对同一个问题使用不同Prompt，对比输出。

---

## Day 9：Few Shot

学习：

- Zero Shot
- Few Shot
- Example

实践：

实现：

```text
文本分类Agent
```

输入：

```text
这个产品太垃圾了
```

输出：

```json
{
  "sentiment": "negative"
}
```

---

## Day 10：Structured Output

学习：

- JSON Output
- JSON Schema
- Schema Validation

实现：

```json
{
  "intent": "",
  "entities": [],
  "confidence": 0
}
```

---

## Day 11：需求分析器

实现：

```text
用户需求
↓
LLM
↓
结构化JSON
```

例如：

```text
我要做银行自助终端账户查询功能
```

输出：

```json
{
  "module": "账户查询",
  "pages": [],
  "components": [],
  "api": [],
  "risks": []
}
```

---

## Day 12：错误处理

处理：

- [ ] JSON解析失败
- [ ] LLM输出格式错误
- [ ] API超时
- [ ] API错误
- [ ] 空响应

---

## Day 13：Prompt优化

比较：

```text
Prompt V1
Prompt V2
Prompt V3
```

记录：

- 输入
- 输出
- 问题
- 修改
- 最终效果

---

## Day 14：周复盘

完成：

- [ ] AI需求分析器
- [ ] Structured Output
- [ ] JSON Schema
- [ ] 错误处理

面试题：

1. Structured Output解决什么问题？
2. Prompt为什么会影响结果？
3. 为什么生产环境不能完全信任LLM输出？
4. JSON Schema有什么作用？

---

# 第3周：Function Calling / Tool Calling

## Day 15：Tool概念

理解：

```text
LLM
+
Tool
=
可以操作外部世界
```

区分：

```text
LLM负责决策
程序负责执行
```

---

## Day 16：Calculator Tool

实现：

```text
calculator(expression)
```

例如：

```text
123 * 456
```

流程：

```text
User
↓
LLM
↓
calculator
↓
result
↓
LLM
```

---

## Day 17：Time Tool

实现：

```text
getCurrentTime()
```

---

## Day 18：Weather Tool

实现：

```text
getWeather(city)
```

如果暂时没有天气API，可以使用Mock数据。

---

## Day 19：Tool Registry

设计：

```typescript
tools = {
  calculator,
  getCurrentTime,
  getWeather
}
```

实现：

- [ ] Tool注册
- [ ] Tool查找
- [ ] Tool参数校验
- [ ] Tool执行
- [ ] Tool错误处理

---

## Day 20：多个Tool

实现：

```text
Calculator
Weather
Time
Search
```

让LLM自主选择Tool。

---

## Day 21：周复盘

回答：

1. Function Calling是什么？
2. Tool是谁执行的？
3. LLM为什么不能直接执行JavaScript？
4. Tool参数如何校验？
5. Tool执行失败怎么办？

---

# 第4周：手写Agent

## Day 22：Agent Loop

实现：

```text
while (!finished) {
  LLM
  ↓
  判断
  ↓
  Tool
  ↓
  Result
  ↓
  LLM
}
```

---

## Day 23：Agent State

定义：

```typescript
type AgentState = {
  messages: Message[]
  toolCalls: ToolCall[]
  iteration: number
}
```

---

## Day 24：最大循环次数

实现：

```text
MAX_ITERATIONS = 10
```

防止Agent死循环。

---

## Day 25：错误处理

处理：

- Tool不存在
- 参数错误
- Tool执行异常
- LLM异常
- 无限循环

---

## Day 26：Agent Memory

实现简单：

```text
conversation history
```

理解：

> Memory不等于无限保存全部聊天记录。

---

## Day 27：Agent UI

前端显示：

```text
思考
↓
调用Weather
↓
Weather返回
↓
生成答案
```

---

## Day 28：第一阶段验收

完成：

- [ ] AI Chat
- [ ] Structured Output
- [ ] Tool Calling
- [ ] 手写Agent
- [ ] Memory
- [ ] Agent状态展示

最终目录：

```text
01-ai-chat/
├── frontend/
├── server/
├── tools/
├── agent/
└── README.md
```

---

# 第二阶段：RAG + MCP

# 第5周：Embedding + Vector DB

## Day 29：Embedding

理解：

```text
文本
↓
Embedding Model
↓
向量
```

回答：

> 为什么语义相近的文本向量距离通常更近？

---

## Day 30：Similarity

学习：

- Cosine Similarity
- Euclidean Distance
- Top K

实践：

比较：

```text
Vue2组件开发规范
Vue3组件开发规范
React组件开发规范
```

---

## Day 31：Vector DB

选择：

```text
PostgreSQL + pgvector
```

或：

```text
Chroma
```

不要同时学习多个Vector DB。

---

## Day 32：Document入库

实现：

```text
Markdown
↓
Chunk
↓
Embedding
↓
Vector DB
```

---

## Day 33：Retrieval

实现：

```text
Query
↓
Embedding
↓
Vector Search
↓
Top K
```

---

## Day 34：RAG第一版

实现：

```text
Question
↓
Retrieval
↓
Context
↓
LLM
↓
Answer
```

---

## Day 35：周复盘

回答：

1. Embedding是什么？
2. Vector DB解决什么问题？
3. TopK是什么？
4. 为什么不能把所有文档放Prompt？
5. RAG有哪些主要步骤？

---

# 第6周：企业知识库

## Day 36：文档解析

支持：

- Markdown
- TXT
- JSON

---

## Day 37：Chunk

实现：

```text
固定长度Chunk
```

记录：

- Chunk Size
- Overlap

---

## Day 38：Markdown Chunk

升级：

```text
H1
H2
H3
```

按照文档结构切分。

---

## Day 39：Metadata

增加：

```json
{
  "file": "vue2.md",
  "section": "组件规范",
  "version": "2.x"
}
```

---

## Day 40：Metadata Filter

实现：

```text
只搜索Vue2文档
```

---

## Day 41：RAG UI

实现：

- [ ] 文档上传
- [ ] 知识库列表
- [ ] 问答
- [ ] 引用来源

---

## Day 42：周复盘

企业知识库V1完成。

---

# 第7周：RAG进阶

## Day 43：RAG问题分析

构造错误案例：

```text
明明知识库存在答案
但是Agent答错
```

定位：

```text
Chunk？
Embedding？
Retrieval？
Prompt？
```

---

## Day 44：TopK实验

测试：

```text
TopK = 1
TopK = 3
TopK = 5
TopK = 10
```

记录效果。

---

## Day 45：Similarity Threshold

增加：

```text
threshold
```

避免召回无关内容。

---

## Day 46：Rerank

实现：

```text
Vector Search
↓
Top 20
↓
Rerank
↓
Top 5
```

---

## Day 47：Query Rewrite

实现：

```text
用户原始问题
↓
LLM改写
↓
Search Query
```

---

## Day 48：Hybrid Search

了解：

```text
Keyword Search
+
Vector Search
```

---

## Day 49：RAG验收

完成：

- [ ] Chunk优化
- [ ] Metadata
- [ ] TopK
- [ ] Threshold
- [ ] Rerank
- [ ] Query Rewrite

---

# 第8周：MCP

## Day 50：MCP概念

理解：

```text
MCP Client
↓
MCP Server
↓
Tool
Resource
Prompt
```

---

## Day 51：MCP Server

创建：

```text
vue-project-mcp
```

---

## Day 52：项目结构Tool

实现：

```text
getProjectStructure()
```

---

## Day 53：代码搜索Tool

实现：

```text
searchCode(keyword)
```

---

## Day 54：文件Tool

实现：

```text
readFile(path)
```

---

## Day 55：项目Tool

实现：

```text
getPackageJson()
getVueComponent()
```

---

## Day 56：第二阶段验收

完成：

```text
02-rag/
03-mcp/
```

验收：

- [ ] 企业知识库
- [ ] RAG
- [ ] Rerank
- [ ] MCP Server
- [ ] MCP Tools
- [ ] MCP Resources

---

# 第三阶段：Agent工程化

# 第9周：LangChain.js

## Day 57：LangChain Model

学习：

```text
Model
Prompt
OutputParser
```

---

## Day 58：Runnable

理解：

```text
Input
↓
Runnable
↓
Output
```

---

## Day 59：Retriever

把之前RAG接入LangChain。

---

## Day 60：Tool

把之前Tools接入LangChain。

---

## Day 61：Agent

使用LangChain Agent重写手写Agent。

---

## Day 62：Memory

加入Conversation Memory。

---

## Day 63：对比

重点总结：

```text
手写Agent
VS
LangChain Agent
```

回答：

> LangChain到底帮我解决了什么？

---

# 第10周：LangGraph

## Day 64：Graph

学习：

```text
Graph
Node
Edge
```

---

## Day 65：State

实现：

```typescript
type State = {
  messages: Message[]
  query: string
  documents: Document[]
  result?: string
}
```

---

## Day 66：Conditional Edge

实现：

```text
是否需要搜索？
├── Yes → Search
└── No → Generate
```

---

## Day 67：Checkpoint

理解：

```text
Agent执行状态
↓
保存
↓
恢复
```

---

## Day 68：Human-in-the-loop

实现：

```text
Agent
↓
准备修改代码
↓
等待人工确认
↓
继续执行
```

---

## Day 69：Research Agent

开始开发：

```text
Research Agent
```

---

## Day 70：第三阶段第一阶段验收

完成：

- [ ] LangChain
- [ ] LangGraph
- [ ] State
- [ ] Node
- [ ] Edge
- [ ] Conditional Edge
- [ ] Checkpoint

---

# 第11周：Multi-Agent

## Day 71：Multi-Agent设计

理解：

```text
Manager
↓
Sub Agents
```

---

## Day 72：Product Agent

负责：

```text
需求分析
```

---

## Day 73：Frontend Agent

负责：

```text
页面
组件
API
```

---

## Day 74：Backend Agent

负责：

```text
数据库
API
```

---

## Day 75：QA Agent

负责：

```text
测试用例
边界条件
```

---

## Day 76：Manager

负责：

```text
拆解
调度
整合
```

---

## Day 77：Multi-Agent验收

输入：

```text
我要开发用户管理系统
```

输出：

```text
需求
+
前端方案
+
后端方案
+
测试方案
```

---

# 第12周：Memory + Agent工程化

## Day 78：短期Memory

实现：

```text
当前Task State
```

---

## Day 79：长期Memory

理解：

```text
User Preference
Project Preference
```

---

## Day 80：Context管理

实现：

```text
Context Compression
```

---

## Day 81：Token Cost

记录：

```text
Prompt Token
Completion Token
Total Token
```

---

## Day 82：Agent Logging

记录：

```text
Agent
Tool
Input
Output
Latency
Error
Token
```

---

## Day 83：错误恢复

实现：

```text
Retry
Fallback
Timeout
Max Iteration
```

---

## Day 84：第三阶段验收

完成：

- [ ] LangChain Agent
- [ ] LangGraph
- [ ] Multi-Agent
- [ ] Memory
- [ ] Logging
- [ ] Retry
- [ ] Timeout
- [ ] Token统计

---

# 第四阶段：AI Coding Agent

# 第13周：项目架构

## Day 85：需求定义

项目：

```text
Enterprise AI Coding Agent
```

核心目标：

```text
用户需求
↓
理解项目
↓
搜索代码
↓
读取规范
↓
修改代码
↓
测试
↓
Review
↓
修复
```

---

## Day 86：项目初始化

创建：

```text
04-ai-coding-agent/
├── frontend/
├── server/
├── agent/
├── rag/
├── mcp/
├── tools/
└── README.md
```

---

## Day 87：Agent State

设计：

```typescript
type CodingAgentState = {
  task: string
  plan: string[]
  files: string[]
  changes: Change[]
  review: ReviewResult
  tests: TestResult
}
```

---

## Day 88：需求分析Agent

输入：

```text
给用户列表增加Excel导出功能
```

输出：

```text
需要修改：
src/views/user/index.vue
src/api/user.js
```

---

## Day 89：代码搜索

接入：

```text
MCP
+
searchCode
```

---

## Day 90：项目知识库

接入：

```text
RAG
+
项目规范
```

---

## Day 91：架构验收

必须跑通：

```text
User
↓
Agent
↓
需求分析
↓
RAG
↓
MCP
↓
代码搜索
```

---

# 第14周：代码修改

## Day 92：Read File

实现：

```text
readFile()
```

---

## Day 93：Write File

实现：

```text
writeFile()
```

必须增加：

- [ ] 路径安全
- [ ] 文件权限
- [ ] 文件备份

---

## Day 94：Diff

实现：

```text
Before
VS
After
```

---

## Day 95：人工确认

修改代码前：

```text
Agent
↓
展示Diff
↓
用户确认
↓
Write File
```

---

## Day 96：Git

实现：

```text
git status
git diff
git add
git commit
```

---

## Day 97：完整Coding Flow

实现：

```text
需求
↓
分析
↓
搜索
↓
读取
↓
生成
↓
Diff
↓
确认
↓
修改
```

---

## Day 98：验收

完成：

- [ ] Code Search
- [ ] Read File
- [ ] Write File
- [ ] Diff
- [ ] Human Confirmation
- [ ] Git

---

# 第15周：Code Review + 自动修复

## Day 99：ESLint

执行：

```text
npm run lint
```

---

## Day 100：TypeScript检查

执行：

```text
tsc --noEmit
```

---

## Day 101：Unit Test

执行：

```text
npm test
```

---

## Day 102：AI Code Review

输入：

```text
Git Diff
```

输出：

```text
问题
严重程度
原因
修改建议
```

---

## Day 103：自动修复

流程：

```text
发现问题
↓
Agent
↓
修改代码
↓
再次Lint
```

---

## Day 104：循环验证

完整流程：

```text
Code
↓
Lint
↓
Review
↓
Fix
↓
Lint
↓
Test
↓
Review
```

设置：

```text
MAX_FIX_ROUNDS = 3
```

---

## Day 105：验收

完成：

- [ ] ESLint
- [ ] TypeScript
- [ ] Unit Test
- [ ] AI Review
- [ ] Auto Fix
- [ ] Retry
- [ ] Max Fix Round

---

# 第16周：作品集 + 面试

## Day 106：前端UI

完成：

- [ ] Chat
- [ ] Agent状态
- [ ] Tool调用过程
- [ ] Diff
- [ ] Code Review
- [ ] Test结果

---

## Day 107：错误处理

完善：

- [ ] API错误
- [ ] Tool错误
- [ ] MCP错误
- [ ] RAG错误
- [ ] Agent超时
- [ ] Agent死循环

---

## Day 108：Docker

完成：

```text
Frontend
Backend
PostgreSQL
```

容器化。

---

## Day 109：README

README必须包含：

```text
项目介绍
技术栈
系统架构
Agent流程
RAG流程
MCP流程
核心代码
运行方式
项目截图
Demo
```

---

## Day 110：技术总结

整理：

```text
LLM
Tool Calling
RAG
MCP
Agent
LangChain
LangGraph
Multi-Agent
Memory
AI Coding Agent
```

每个主题至少写：

```text
是什么？
为什么需要？
怎么实现？
有什么问题？
怎么优化？
```

---

## Day 111：面试模拟

至少回答：

### LLM

- Token是什么？
- Context Window是什么？
- Streaming怎么实现？
- Temperature是什么？

### RAG

- RAG完整流程是什么？
- Chunk怎么设计？
- TopK是什么？
- Rerank为什么需要？
- RAG为什么会召回错误？

### Agent

- Agent是什么？
- Agent和Workflow有什么区别？
- Tool Calling怎么实现？
- Agent为什么会死循环？
- Memory怎么设计？

### MCP

- MCP解决什么问题？
- MCP Server是什么？
- Tool和Resource有什么区别？

### LangGraph

- State是什么？
- Node是什么？
- Edge是什么？
- Conditional Edge是什么？
- Checkpoint解决什么问题？

### 工程

- Agent如何控制成本？
- Agent如何控制延迟？
- Agent如何保证安全？
- Agent如何防止误修改代码？
- Agent如何做Evaluation？

---

## Day 112：最终验收

必须达到：

### 项目

- [ ] AI Chat
- [ ] 企业知识库
- [ ] MCP Server
- [ ] AI Coding Agent

### 技术

- [ ] LLM
- [ ] Prompt
- [ ] Structured Output
- [ ] Tool Calling
- [ ] RAG
- [ ] Embedding
- [ ] Rerank
- [ ] MCP
- [ ] LangChain
- [ ] LangGraph
- [ ] Agent
- [ ] Multi-Agent
- [ ] Memory

### 工程

- [ ] Node.js
- [ ] PostgreSQL
- [ ] Docker
- [ ] Git
- [ ] ESLint
- [ ] Unit Test
- [ ] Logging
- [ ] Error Handling

---

# 五、最终项目架构

```text
                    Enterprise AI Coding Agent
                              │
                ┌─────────────┼─────────────┐
                ↓             ↓             ↓
               RAG          Tools          MCP
                │             │             │
          项目知识库       文件操作        Code/Git
                │             │             │
                └─────────────┼─────────────┘
                              ↓
                          LangGraph
                              ↓
                         Agent State
                              ↓
                    ┌─────────┼─────────┐
                    ↓         ↓         ↓
                 Analyze    Coding     Review
                    │         │         │
                    └─────────┼─────────┘
                              ↓
                           Testing
                              ↓
                           Auto Fix
                              ↓
                         Final Review
                              ↓
                           Git Commit
```

---

# 六、最终简历项目

## Enterprise AI Coding Agent

### 项目简介

基于 LLM、RAG、MCP、LangGraph 构建企业级 AI Coding Agent，实现从需求分析、代码检索、项目规范理解、代码生成、代码修改到自动 Review、测试和修复的完整 AI 软件开发流程。

### 技术栈

```text
Vue3
TypeScript
Node.js
LangChain
LangGraph
RAG
pgvector
MCP
SSE
Docker
```

### 核心能力

- 基于 LangGraph 实现 Agent 工作流编排
- 基于 RAG 构建项目规范知识库
- 基于 MCP 实现代码搜索、文件读取及Git操作
- 基于 Tool Calling 实现工具调用
- 基于 AI Code Review 自动审查代码
- 集成 ESLint、TypeScript、Unit Test
- 支持 Agent 自动修复代码
- 基于 SSE 实时展示 Agent 执行过程
- 支持 Human-in-the-loop

---

# 七、每周复盘模板

每周日填写：

```markdown
# Week X 复盘

## 本周完成

- [ ]
- [ ]
- [ ]

## 本周Git Commit

- 

## 本周最重要的3个知识点

1.
2.
3.

## 本周遇到的问题

### 问题1

现象：

原因：

解决：

### 问题2

现象：

原因：

解决：

## 本周面试题

### Q1

A：

### Q2

A：

### Q3

A：

## 本周项目进度

完成度：

## 下周目标

1.
2.
3.
```

---

# 八、每天打卡模板

```markdown
# Day XX

日期：

## 今日目标

- [ ]
- [ ]
- [ ]

## 实际完成

- [ ]
- [ ]

## Git Commit

```text

```

## 今日学到的东西

### 1.

### 2.

### 3.

## 今日遇到的问题

### 问题

### 原因

### 解决

## 今日面试题

Q：

A：

## 今日完成度

- [ ] 100%
- [ ] 80%
- [ ] 50%
- [ ] <50%

## 明日目标

1.
2.
3.
```

---

# 九、4个月最终验收标准

如果以下内容全部完成，就可以进入正式求职阶段：

```text
                 4个月成果
                     │
       ┌─────────────┼─────────────┐
       ↓             ↓             ↓
     基础能力       Agent能力      工程能力
       │             │             │
      LLM          RAG           Node
      Prompt       MCP           Docker
      Tool         Agent         PostgreSQL
      SSE          LangGraph     Testing
       │             │             │
       └─────────────┼─────────────┘
                     ↓
             AI Coding Agent
                     ↓
              可运行 + 可演示
                     ↓
              可写进简历
                     ↓
               可用于面试
```

最终目标不是：

> “我学习了4个月AI。”

而是：

> **“我拥有多年真实前端工程经验，并且能够独立完成一个从 LLM、RAG、Tool Calling、MCP、Agent 编排，到前后端、测试和部署的完整 AI 应用。”**

---

# 十、执行优先级

如果某一天时间不足，按照下面优先级执行：

```text
1. 项目编码
2. 核心概念理解
3. 官方文档
4. 面试题
5. 视频/教程
```

不要因为当天只有1小时，就选择：

```text
今天没时间
→ 不学习
```

应该：

```text
今天只有1小时
→ 写1个功能
→ 提交1次Git
→ 结束
```

**连续执行比单日学习时长更重要。**

---

# 十一、四个月后的目标画像

```text
高级前端工程师
        +
TypeScript / Node.js
        +
LLM
        +
RAG
        +
Tool Calling
        +
MCP
        +
LangChain
        +
LangGraph
        +
Agent
        +
AI Coding Agent
```

最终目标岗位：

```text
AI Agent开发工程师
AI应用开发工程师
AI全栈开发工程师
LLM应用开发工程师
AI前端工程师
```

---

# 结语

这份计划的核心不是“把AI所有知识学完”。

而是：

```text
学一个概念
    ↓
写一个Demo
    ↓
加入项目
    ↓
遇到问题
    ↓
解决问题
    ↓
写技术总结
    ↓
形成面试能力
```

4个月之后，真正应该留下的是：

```text
4个完整项目
+
1个核心AI Coding Agent
+
112天Git记录
+
完整技术笔记
+
Agent架构设计能力
+
AI工程化能力
+
一套可以讲清楚的项目经历
```

**从第一天开始写代码，不要等“准备好了”再开始。**
