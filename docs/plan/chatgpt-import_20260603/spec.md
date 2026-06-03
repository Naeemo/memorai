# Specification: ChatGPT History Importer for Memorai

**Track ID:** chatgpt-import_20260603  
**Type:** Feature  
**Created:** 2026-06-03  
**Status:** Draft  
**Version:** v1.0

---

## 1. 背景

Memorai 是 AI Agent 的记忆层，支持文本/多模态记忆、分层演化、向量检索。当前示例已覆盖浏览器助手（page visit / click 记录）和 OpenClaw 集成，但缺少对**外部对话平台历史**的导入能力。

ChatGPT 是用户高频使用的 AI 对话工具，积累了大量有价值的对话历史。将这些历史导入 Memorai，可以让用户：
- **本地检索** — 用自然语言搜索曾经的对话内容（不受 ChatGPT 搜索框限制）
- **跨平台关联** — 将 ChatGPT 对话与其他 Memorai 记忆（网页浏览、笔记、代码）关联
- **长期沉淀** — ChatGPT 的 conversation history 有保留期限，本地存储是备份

---

## 2. 目标

**v1.0（浏览器扩展）**：提供一个 Chrome 扩展，让用户一键将 ChatGPT 历史对话批量导入到 Memorai 的 IndexedDB 存储中，支持去重和后续检索。

**v1.5（脱离浏览器）**：将导入功能扩展到桌面环境（Node.js / Tauri），支持 SQLite 持久化，让用户在无浏览器时也能访问已导入的历史。

---

## 3. 用户故事

| 角色 | 场景 | 需求 |
|------|------|------|
| 重度 ChatGPT 用户 | 我记得 3 个月前让 ChatGPT 写过某个正则表达式，但 ChatGPT 的搜索框找不到 | 用自然语言搜索"正则表达式匹配邮箱"，定位到具体对话 |
| 多设备用户 | 在公司电脑上和 ChatGPT 讨论过架构设计，回家想继续 | 导入历史后在任何装了扩展的浏览器都能检索 |
| 数据备份意识者 | 担心 ChatGPT 历史被删除或账号被封 | 将历史导出到本地 IndexedDB，可离线检索 |
| 知识工作者 | 想用 ChatGPT 对话作为写作素材 | 在 Memorai 中搜索相关对话，作为 Writer 模块的引用源 |

---

## 4. 功能设计

### 4.1 核心流程

```
用户打开 chatgpt.com → 登录 → 点击扩展图标 → 触发导入
    ↓
扩展自动加载并遍历历史对话列表
    ↓
对每个对话：获取详情 → 提取消息 → 判断去重 → 写入 Memorai
    ↓
导入完成 → 展示统计（导入/跳过/失败）
    ↓
用户可在扩展 popup 中搜索历史对话
```

### 4.2 导入策略

**批量导入（非实时）**
- 触发方式：用户点击扩展图标 / 右键菜单 / 快捷键
- 遍历范围：从当前页面开始，自动加载更多历史（模拟滚动或调用 API）
- 增量导入：第二次导入时只处理新增的对话
- 中断恢复：支持中断后从上次位置继续

**去重机制**
- 关键字段：`conversation.id`（ChatGPT 分配的对话 ID）+ `message.id`（消息 ID）
- 策略：写入前检查 Memorai 中是否已存在相同 `sourceId`（存入 `meta.eventId`）
- 如果对话已存在但内容有更新（如用户继续对话后再次导入），**v1 视为重复跳过**，v1.5 可支持增量更新

**数据映射**

| ChatGPT 字段 | Memorai Event 字段 | 说明 |
|-------------|-------------------|------|
| `conversation.id` | `meta.eventId`（前缀 `chatgpt-conv:`） | 对话级标识，用于去重 |
| `message.id` | `meta.eventId`（前缀 `chatgpt-msg:`） | 消息级标识，用于去重 |
| `message.author.role` | `actor` | `user` → `"user"`, `assistant` → `"assistant"` |
| `message.content.parts[0]` | `content.text` | 文本内容 |
| `message.create_time` | `at` | Unix 时间戳（ms） |
| `conversation.title` | `tags` | 添加 `chatgpt` + `conversation.title`（如果可获取） |
| `conversation.update_time` | — | 存入 `meta` 作为参考 |

### 4.3 存储策略（v1）

```typescript
const memory = new Memorai({
  storage: new IndexedDBAdapter({ 
    dbName: "memorai-chatgpt",
    namespace: "chatgpt-importer" 
  }),
  embedding: new OllamaEmbeddingService({
    baseUrl: "http://localhost:11434",
    model: "nomic-embed-text",
  }),
  agentProfile: {
    agentId: "chatgpt-importer",
    role: "reasoning",
    writePolicy: {
      levels: ["segment"], // 消息级，不聚合为事件
      modalities: ["text"],
      salienceBoost: 1,
    },
    readPolicy: {
      defaultLevel: "segment",
      defaultTraversal: "reverse",
      timeHorizonMs: 30 * 24 * 60 * 60 * 1000, // 30 天
    },
  },
});
```

**为什么用 `segment` 级别？**
- ChatGPT 消息是原子单元，不需要在 Memorai 内部做 HME 聚合
- 每条消息独立存储，检索时粒度更细

**为什么用 Ollama 本地嵌入？**
- 批量导入几百条消息，OpenAI API 有成本和延迟问题
- Ollama `nomic-embed-text` 免费本地跑，与 Memorai 基准测试一致

### 4.4 召回/查询入口设计

**双入口架构：快速入口 + 深度召回**

| 入口 | 定位 | 功能 | 尺寸 |
|------|------|------|------|
| **Popup** | 快速操作 | 导入触发、最近3条快速搜索、统计概览 | 悬浮，~400px 宽 |
| **独立搜索页面** | 深度召回 | 全文检索、时间线浏览、筛选、对话详情阅读 | 浏览器标签页，全尺寸 |

**为什么需要两个入口？**
- Popup 是临时浮层，关闭即消失，不适合深度浏览
- 搜索是高频操作，需要一个常驻的、全尺寸的界面
- 用户关闭 popup 后，仍可通过独立页面随时访问已导入的历史

---

**Popup 界面（点击图标）**
- **导入按钮**："导入 ChatGPT 历史"（主操作）
- **进度展示**：当前导入的对话数 / 总对话数，进度条
- **统计卡片**：已导入对话数 / 消息数 / 上次导入时间
- **快速搜索**：最近3条匹配结果，点击跳转 ChatGPT 或打开独立搜索页面
- **"打开搜索页面"按钮**：点击进入全尺寸独立搜索页面
- **设置入口**：Ollama 地址、模型选择、清除数据、导出数据

**导入中状态**
- 进度条：按对话数计算（非消息数，因为每对话需要一次 API 调用）
- 状态文本："正在加载对话列表..." → "正在导入第 3/50 个对话..." → "完成！导入 47 个对话，跳过 3 个（已存在）"
- 取消按钮：可随时中断，已导入的部分保留
- 后台导入：关闭 popup 后，service worker 继续导入，进度通过 badge 通知

---

**独立搜索页面（`chrome-extension://{id}/search.html`）**

- **搜索框**：自然语言输入，支持语义搜索（Memorai `recall`）+ 关键词过滤
- **结果列表**：时间倒序，每条显示：时间、对话标题、匹配消息摘要、相关度分数
- **对话详情**：点击展开完整对话（user/assistant 消息流），保留 Markdown 格式
- **筛选器**：按时间范围、actor（user/assistant）、标签（chatgpt/具体对话标题）
- **时间线视图**：按日期分组，像 ChatGPT 的历史列表一样浏览
- **操作**：
  - 点击"在 ChatGPT 中打开" → 跳转 `https://chatgpt.com/c/{id}`
  - 点击"导出为 Markdown" → 下载 `.md` 文件
  - 点击"复制" → 复制消息内容到剪贴板
- **独立页面打开方式**：从 popup 点击、或从浏览器书签/新标签页直接访问

### 4.5 技术架构

```
chrome-extension/
├── manifest.json          # v3, host permission: chatgpt.com
├── src/
│   ├── background.ts      # Service Worker: Memorai 实例、导入协调、搜索服务
│   ├── content.ts         # Content Script: 读取 ChatGPT DOM / API
│   ├── popup/
│   │   ├── index.html
│   │   ├── index.ts       # Popup UI 逻辑（快速入口）
│   │   └── style.css
│   ├── search/            # 独立搜索页面（深度召回）
│   │   ├── index.html
│   │   ├── index.ts       # 搜索页面逻辑
│   │   ├── components/    # 结果列表、对话详情、筛选器、时间线
│   │   └── style.css
│   ├── importer/
│   │   ├── chatgpt-api.ts    # 封装 ChatGPT 前端 API 调用
│   │   ├── dedup.ts          # 去重逻辑（基于 eventId）
│   │   ├── mapper.ts         # ChatGPT → Memorai Event 映射
│   │   └── progress.ts       # 进度追踪
│   └── utils.ts
├── package.json
└── vite.config.ts
```

**ChatGPT 数据获取方式**

ChatGPT 没有公开 API 获取历史列表，但前端会调用内部 API：

```
GET https://chatgpt.com/backend-api/conversations?offset=0&limit=28&order=updated
```

Headers 包含 `Authorization: Bearer {access_token}`，这是浏览器中已有的 token。

Content Script 可以：
1. 读取页面的 `window.__remixContext`（Next.js 注入的初始数据）获取 access_token
2. 或者从 `localStorage` / `sessionStorage` 中读取 token
3. 或者拦截前端的 fetch 请求（更复杂，不推荐）

**安全注意**：token 只在内存中使用，不存储到扩展 storage，不发送到任何外部服务器。

### 4.6 错误处理

| 场景 | 处理 |
|------|------|
| 用户未登录 ChatGPT | 提示"请先登录 ChatGPT" |
| 无法获取 token | 提示"无法访问 ChatGPT，请刷新页面后重试" |
| 导入过程中网络中断 | 记录已导入进度，提示"网络中断，已导入 X 个对话，可继续导入" |
| Ollama 未运行 | 提示"请先启动 Ollama 并加载 nomic-embed-text 模型" |
| 某条消息过长 | 截断到 8000 字符（Memorai 嵌入限制），记录警告 |
| 导入速度过慢 | 显示预估时间，提供"后台导入"选项（关闭 popup 继续） |

---

## 5. 边界与后续规划

### v1.0 不做
- 实时同步（边聊边导）
- 跨设备同步（IndexedDB 是本地存储）
- 图片/文件附件导入（只导文本）
- 对话内容的增量更新（已导入的对话再次导入时跳过）
- 与 Mango Write 直接集成（需要 v1.5 的 SQLite 版本才能跨应用访问）
- 导出为其他格式（PDF、Markdown 导出已做，但不做 PDF）

### v1.5 规划
- **桌面版本**：用 Tauri 或 Electron 包装，脱离浏览器运行
- **SQLite 持久化**：替代 IndexedDB，支持更大容量和 SQL 查询
- **增量更新**：检测已导入对话是否有新消息，只追加新消息
- **多平台支持**：扩展为 Claude、Perplexity 等平台的导入器

### Phase 2
- 导入后的对话在 Memorai 的 Reader 模块中阅读
- 对导入的对话做 AI 问答（"我在 ChatGPT 里问过什么关于正则的问题？"）
- 与 Mango Write 的 Writer 模块集成：将 ChatGPT 对话作为引用源插入文章

---

## 6. 验收标准

- [ ] 安装扩展后，在 ChatGPT 登录状态下点击导入按钮，能成功导入所有历史对话
- [ ] 第二次导入同一账号，已导入的对话被跳过，只导入新增对话
- [ ] **Popup 快速搜索**：在 popup 搜索框输入关键词，能在 500ms 内返回最近3条匹配结果
- [ ] **独立搜索页面**：从 popup 点击"打开搜索页面"，能在全尺寸页面中搜索、浏览、筛选历史对话
- [ ] **对话详情**：在搜索页面点击结果，能展开完整对话（user/assistant 消息流），保留 Markdown 格式
- [ ] **导出功能**：在搜索页面点击"导出为 Markdown"，能下载正确的 `.md` 文件（含 frontmatter）
- [ ] **批量导出**：在设置中点击"导出全部"，能下载 ZIP 包含所有对话的 `.md` 文件
- [ ] 搜索结果点击"在 ChatGPT 中打开"，能正确跳转到对应的 ChatGPT 对话页面
- [ ] 导入 500 条消息的总耗时 < 5 分钟（含嵌入计算）
- [ ] 扩展在 Chrome / Edge 上均可安装和运行
- [ ] 清除扩展数据后重新导入，结果与首次导入一致
- [ ] 关闭 popup 后，后台导入继续运行，扩展图标显示进度 badge

---

## 7. 依赖

- **Memorai** (`^0.5.0`)：核心记忆库
- **Ollama**（本地运行）：`nomic-embed-text` 模型用于嵌入
- **ChatGPT 前端 API**：内部 API，可能随 ChatGPT 更新而变化，需监控兼容性

---

## 8. 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| ChatGPT 更改内部 API 或认证方式 | 高 | 监控 API 变化，提供 fallback（如从 DOM 读取） |
| ChatGPT 消息量极大（>10,000 条） | 中 | 分批导入，提供后台导入选项，限制单次导入数量 |
| Ollama 嵌入模型未安装 | 中 | 扩展启动时检测，提供一键安装指引 |
| IndexedDB 容量限制（~50MB） | 低 | v1 不处理，v1.5 迁移到 SQLite |
| **数据孤岛：IndexedDB 只在扩展内可访问** | **中** | **v1 通过导出 Markdown 作为临时出口；v1.5 用 SQLite 实现跨应用访问** |
| **用户不知道导入后在哪里用** | **中** | **明确的召回入口设计：popup 快速入口 + 独立搜索页面 + 导出功能** |

---

*Generated by /plan. Research findings: Memorai has full browser support (IndexedDBAdapter + browser-assistant example), Event API with `eventId` for dedup, and Ollama embedding integration. No existing ChatGPT import functionality found in codebase.*
