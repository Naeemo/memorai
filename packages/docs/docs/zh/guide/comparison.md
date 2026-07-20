# Memorai 与同类方案对比

Memorai 与其他 AI Agent 记忆库的逐项对比。

## 架构

| 维度 | Memorai | Mem0 | Zep | Letta |
|---|---|---|---|---|
| 语言 / 运行时 | TypeScript — Browser、Node、Bun、Deno | Python / JS SDK | TypeScript / Node | Python |
| 存储哲学 | **三层存储**（原始层 / 注解层 / 索引层） | 摄入时破坏性摘要 | 时序知识图谱 | Agent 状态块 |
| 重注解 | ✅ 可升级 extractor 不丢数据 | ❌ 旧记忆冻结 | ❌ | ❌ |
| 多模态 | 引用 + 向量 + 文本 | 仅文本 | 文本 + 元数据 | 文本 |
| 分层演化 | Segment → Atomic Action → Event | 扁平 | 扁平 | 扁平 |
| 工作记忆 | ✅ 内置 scratchpad | ❌ | ❌ | ✅ |
| 过程记忆 | ✅ `tool_call` / `plan_step` / skills | ❌ | ❌ | 部分 |
| 信念修正 | ✅ `supersedes` + `invalidatedAt` | ❌ | 部分 | ❌ |
| 双时序查询 | ✅ `validAt` | ❌ | 部分 | ❌ |

## Benchmark

| Benchmark | Memorai | Zep | Mem0 | Letta |
|---|---|---|---|---|
| LongMemEval | **92%** | 64–71% | 49% | — |
| LoCoMo conv-26 | 33.55%（调优中） | 75–85% | ~60s | — |
| 运行时支持 | **Browser + Node + Bun + Deno** | Node | Node | Server |

## 功能矩阵

| 功能 | Memorai | Mem0 | Zep | Letta |
|---|---|---|---|---|
| 向量索引（ANN） | ✅ HNSW / USearch / WASM | ✅ | ✅ | ✅ |
| BM25 稀疏检索 | ✅ | ✅ | ✅ | ✅ |
| 知识图谱 | ✅（三元组 + 路径融合） | 可选 | ✅（必需） | ❌ |
| 时间锚点 | ✅ | ❌ | ✅ | ❌ |
| 查询扩展 / HyDE / 问题分解 | ✅ | 部分 | 部分 | ❌ |
| Cross-encoder reranker | ✅ 本地、无 API 调用 | ❌ | ❌ | ❌ |
| 可观测性（`explain()` + spans） | ✅ | 部分 | 部分 | 部分 |
| ESM + CJS 双构建 | ✅ | ❌ | ✅ | ❌ |
| 零外部服务依赖 | ✅ | ❌（需向量数据库） | ❌（需图数据库） | ❌ |
| 自托管 | ✅ | ✅ | ✅ | ✅ |

## 什么时候选 Memorai

- 需要 **浏览器本地** 或 **边缘运行时** 记忆
- 想 **保留原始事件**，未来可升级提取质量
- Agent 是 **工具调用型**，需要过程记忆
- 需要 **双时序**“某个时间点哪些事实成立”查询
- 想要一个 **TypeScript 原生**、无外部图数据库依赖的库

## 什么时候选其他方案

- **Zep**：追求当前最高的 LoCoMo 分数，且愿意运维图数据库
- **Mem0**：想要成熟 SaaS/API，不需要浏览器支持或重注解
- **Letta**：想要带状态管理的完整 Agent 框架，而非独立记忆库
