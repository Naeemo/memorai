# Memorai 任务清单（按优先级）

> 刷新日期：2026-07-18
> 当前版本：v0.5.0
> 分支：`main`

---

## ✅ 已完成（本轮）

- [x] `resolveTime` 默认开启（`MemoraiConfig.defaultResolveTime`）
- [x] `AutoVectorIndex` — 自动选择 HNSW / USearch / WASM / brute-force
- [x] `AutoReranker` — 自动选择 TransformersReranker / 无操作
- [x] 浏览器默认 `IndexedDBEventStore` 持久化
- [x] ESM/CJS dual build（`dist/` + `dist-cjs/`）
- [x] Streaming Ingest 背压验证 + `close()` flush 修复
- [x] 示例全部改用 public Event API
- [x] `memorai/eval` 子路径发布
- [x] ROADMAP / OPTIMIZATION-PLAN / ARCHITECTURE / README 文档同步
- [x] CI workflow（test/build + 手动 benchmark smoke）
- [x] "Memorai vs Alternatives" 对比页（EN + ZH）

---

## 🔴 高价值收尾

| # | 任务 | 说明 | 状态 |
|---|---|---|---|
| 1 | 运行 LoCoMo conv-26 / 完整 LoCoMo benchmark | 验证 `resolveTime` + `AutoVectorIndex` + `AutoReranker` 新 baseline | 🔴 |
| 2 | HNSW 真实安装验证 | `hnswlib-node` 需 `node-gyp rebuild`，当前回落 brute-force；验证编译通过后自动选到 HNSW 并写安装指引 | 🔴 |

---

## 🟡 功能深化

| # | 任务 | 说明 | 状态 |
|---|---|---|---|
| 1 | MultimodalExtractor 落地 | image/audio/video 事件真正接入 vision model / Whisper，不再只是 WrapExtractor 透传 | 🔜 |
| 2 | CLIP 跨模态检索集成 | `CLIPEmbedder` 已实现，需接入 `RetrievalEngine` 跨模态 pathway | 🔜 |
| 3 | Graph 持久化默认启用 | Node 默认 `SQLiteEntityGraph`，Browser 默认 `IndexedDBEntityGraph` | 🔜 |
| 4 | Sleep consolidation 验证 | 真实场景压测 `sleep()`：合并相似节点、遗忘、技能提取是否按预期 | 🔜 |
| 5 | `Memorai<Ext>` 泛型传播 | `extensions` 字段类型化，泛型从 `MemoryAnnotations` 传到 `Memorai` 类 | 🔜 |

---

## 🟢 工程化 / 发布准备

| # | 任务 | 说明 | 状态 |
|---|---|---|---|
| 1 | Bundle 压到 50KB 以下 | 当前 56KB gzip，可再 tree-shake LLM/multimodal 相关代码 | 🔜 |
| 2 | 1.0 版本准备 | 版本号 bump、CHANGELOG、迁移指南、破坏性变更清单 | 🔜 |
| 3 | API 文档补全 | `docs/api/` 下 `RetrievalEngine`、`EventIdentifier` 等页面偏简 | 🔜 |

---

## 建议执行顺序

```
Day 1: HNSW 真实安装验证 + LoCoMo benchmark
Day 2: Graph 持久化默认启用 + Sleep consolidation 验证
Day 3: 1.0 版本准备 + Bundle 优化
```
