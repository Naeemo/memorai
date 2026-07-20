# Memorai 任务清单（按优先级）

> 刷新日期：2026-07-16
> 当前版本：v0.5.0
> 分支：`main`

---

## 🔴 重大发现（2026-07-16）

**Memorai 的 P0-P2 功能实际上几乎全部已经实现了！**

| 功能 | 状态 | 位置 |
|------|------|------|
| **P0.1 Temporal anchors** | ✅ | `types.ts`, `extraction/light.ts`, `extraction/llm.ts`, `retrieval.ts` |
| **P0.2 Weighted graph paths** | ✅ | `graph/in-memory.ts:queryPathsWeighted`, `graph/sqlite.ts`, `graph/indexeddb.ts` |
| **P0.3 Event cross-linking** | ✅ | `types.ts:MemoryEvent.relatedEventIds`, `events/identifier.ts` |
| **P0.4 LLM temporal resolution** | ✅ | `index.ts:applyTemporalResolution` Tier 2/3 |
| **P1.1 HNSW vector search** | ✅ | `vector/hnsw.ts`(Node), `vector/hnsw-wasm.ts`(Browser), `vector/usearch.ts` |
| **P1.2 Persistent graph** | ✅ | `graph/sqlite.ts`, `graph/indexeddb.ts` |
| **P1.4 Cross-encoder reranker** | ✅ | `tests/reranker-transformers.test.ts` |
| **P2.1 Procedural memory** | ✅ | `types.ts:EventContent kind:"tool_call"` |
| **P2.2 Working memory** | ✅ | `working/types.ts`, `tests/working.test.ts` |
| **P2.3 User profile** | ✅ | `tests/profile.test.ts` |
| **P2.4 Belief revision** | ✅ | `index.ts:reviseBelief()`, `tests/belief-revision.test.ts` |
| **P2.5 Observability** | ✅ | `index.ts:explain()`, span tracking |

**已修复**：`LightExtractor.extractTemporalAnchors` 未填充 `start`/`end` → 已修复为从 `event.at` 填充。

**这意味着当前真正的问题是：**
1. **默认配置不启用这些功能**（如 `resolveTime` 默认 false，不用 HNSW）
2. **文档严重不同步**（plan.md / ROADMAP / OPTIMIZATION-PLAN 标记大量功能为 "not started"）
3. **需要 benchmark 验证**最佳配置组合

---

## 🔴 P0 — 验证与调优（本周）

### P0.1 运行 Benchmark 验证当前状态

> 目标：确定 A1-A4 实现后，LoCoMo conv-26 的新 baseline 是多少

| # | 任务 | 状态 | 估计 |
|---|---|---|---|
| 1 | 运行 LoCoMo conv-26 benchmark（当前 main 分支 + 修复后的 light extractor） | 🔴 | 2-4h |
| 2 | 运行对比：启用 `resolveTime` + `decompose` + `identifier` 的组合 | 🔴 | 2-4h |
| 3 | 分析失败案例：temporal / multi-hop / contradiction 分布 | 🔴 | 2h |
| 4 | 检查默认配置：为何 HNSW 不默认启用、pathway 权重是否合理 | 🔴 | 1h |

### P0.2 如果验证后仍有差距，针对性修复

| # | 任务 | 状态 | 估计 |
|---|---|---|---|
| 1 | 调优 `graphPathway` 权重和参数 | 🔜 | 1d |
| 2 | 调优 `temporalAnchorPathway` 与 `timePathway` 的融合 | 🔜 | 1d |
| 3 | 检查 `LLMEventIdentifier` 的 `relatedEventIds` 填充质量 | 🔜 | 1d |
| 4 | 调优 RRF 融合权重 | 🔜 | 1d |

---

## 🟠 P1 — 文档同步（高优先级，与验证并行）

| # | 任务 | 状态 | 估计 |
|---|---|---|---|
| 1 | 更新 `docs/design/ROADMAP.md` — 标记已实现功能 | 🔴 | 1d |
| 2 | 更新 `docs/design/OPTIMIZATION-PLAN.md` — 修正 Phase A 状态 | ✅ | 已部分完成 |
| 3 | 更新 `docs/plan/chatgpt-import_20260603/plan.md` — 标记实际进度 | 🔴 | 0.5d |
| 4 | 更新根目录 README.md — 功能矩阵同步 | 🔴 | 1d |
| 5 | 更新 `packages/memorai/README.md` — 子包说明 | 🔴 | 0.5d |

---

## 🟡 P2 — 生产就绪（P0 验证后决定）

| # | 任务 | 说明 | 状态 |
|---|---|---|---|
| 1 | HNSW 默认启用 | 当前默认不用 HNSW（需要显式传入 `vectorIndex`） | 🔜 |
| 2 | Streaming Ingest 完整实现 | `recordStream` API 存在但需验证完整性 | 🔜 |
| 3 | SQLite/IndexedDB EventStore | `events/sqlite.ts` / `events/indexeddb.ts` 存在 | 🔜 |

---

## 🟢 P3 — DX / 打磨

| # | 任务 | 说明 | 状态 |
|---|---|---|---|
| 1 | 自动 benchmark 回归检测 CI | 每次 commit 跑 LoCoMo 子集 | 🔜 |
| 2 | Head-to-Head Comparison Page | VitePress "Memorai vs Alternatives" | 🔜 |
| 3 | `examples/` 全部改用 public Event API | 移除 `@internal` 标记 | 🔜 |
| 4 | ESM/CJS dual build | 最大化兼容性 | 🔜 |

---

## 📦 并行轨道：Browser Extension

> 轨道：`docs/plan/chatgpt-import_20260603/plan.md`
> 当前：目录结构存在，importer/ 为空，plan.md 标记 "Not Started"，但 git log 显示已提交

| Phase | 任务 | 状态 | 估计 |
|---|---|---|---|
| 1 | Extension Skeleton | ✅ | 已完成 |
| 2 | ChatGPT API 客户端 | 🔴 | 需确认实际完成度 |
| 3 | Import Pipeline | 🔴 | 需确认实际完成度 |
| 4 | Popup UI | 🟡 | 部分 |
| 5 | Search Page | 🟡 | 部分 |
| 6 | 端到端测试 | 🔴 | 2d |

**注意**：git history 与文件系统不一致，建议先 `git show` 确认 chatgpt-importer commit 的内容。

---

## 本周建议执行顺序

```
Day 1: P0.1 #1    → 运行 LoCoMo conv-26 baseline benchmark
Day 1: P0.1 #2    → 运行对比配置（resolveTime + decompose + identifier）
Day 2: P0.1 #3~4  → 分析结果、检查默认配置
Day 3-4: P0.2     → 根据分析结果针对性调优
Day 5: P1         → 文档同步（ROADMAP.md, README.md 等）
```

**如果 LoCoMo 分数达到 45-55%**：P0 基本完成，转向 P1 文档同步 + HNSW 默认启用
**如果 LoCoMo 分数仍然 <40%**：深入分析集成 gaps（可能 pathways 未正确启用或权重未调优）
