import { defineConfig } from "vitepress";

// Shared site-wide options. Per-locale UI strings live under `locales`.
export default defineConfig({
  title: "Memorai",
  description: "Runtime-agnostic, multimodal streaming memory for AI agents",
  base: "/memorai/",
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: true,
  head: [
    [
      "link",
      {
        rel: "icon",
        type: "image/svg+xml",
        href: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><circle cx='32' cy='32' r='28' fill='%2342b883'/><text x='50%' y='54%' text-anchor='middle' font-size='32' font-family='monospace' font-weight='700' fill='white'>M</text></svg>",
      },
    ],
  ],
  themeConfig: {
    socialLinks: [{ icon: "github", link: "https://github.com/Naeemo/memorai" }],
    search: { provider: "local" },
    outline: { level: [2, 3] },
  },
  locales: {
    root: {
      label: "English",
      lang: "en-US",
      title: "Memorai",
      description: "Runtime-agnostic, multimodal streaming memory for AI agents",
      themeConfig: {
        nav: [
          { text: "Guide", link: "/guide/introduction", activeMatch: "/guide/" },
          { text: "Concepts", link: "/concepts/overview", activeMatch: "/concepts/" },
          { text: "API", link: "/api/memorai", activeMatch: "/api/" },
          { text: "Runtime", link: "/runtime/compatibility", activeMatch: "/runtime/" },
        ],
        sidebar: {
          "/guide/": [
            {
              text: "Guide",
              items: [
                { text: "Introduction", link: "/guide/introduction" },
                { text: "Getting Started", link: "/guide/getting-started" },
                { text: "Examples", link: "/guide/examples" },
                { text: "Subpath Exports", link: "/guide/subpath-exports" },
                { text: "Benchmarks", link: "/guide/benchmarks" },
              ],
            },
          ],
          "/concepts/": [
            {
              text: "Concepts",
              items: [
                { text: "Overview", link: "/concepts/overview" },
                { text: "Memory Nodes", link: "/concepts/memory-nodes" },
                { text: "Memory Events", link: "/concepts/memory-events" },
                { text: "Hierarchical Evolution", link: "/concepts/evolution" },
                { text: "Retrieval", link: "/concepts/retrieval" },
                { text: "Cross-Agent Memory", link: "/concepts/cross-agent" },
              ],
            },
          ],
          "/api/": [
            {
              text: "API Reference",
              items: [
                { text: "Memorai", link: "/api/memorai" },
                { text: "Storage Adapter", link: "/api/storage" },
                { text: "Event Store", link: "/api/event-store" },
                { text: "Event Identifier", link: "/api/event-identifier" },
                { text: "Evolution Engine", link: "/api/evolution-engine" },
                { text: "Retrieval Engine", link: "/api/retrieval-engine" },
                { text: "Embedding Service", link: "/api/embeddings" },
                { text: "Compression Service", link: "/api/compression" },
              ],
            },
          ],
          "/runtime/": [
            {
              text: "Runtime",
              items: [{ text: "Compatibility & Lifecycle", link: "/runtime/compatibility" }],
            },
          ],
        },
        editLink: {
          pattern: "https://github.com/Naeemo/memorai/edit/main/packages/docs/docs/:path",
          text: "Edit this page on GitHub",
        },
        footer: {
          message: "Released under the MIT License.",
          copyright: "Copyright © Naeemo",
        },
      },
    },
    zh: {
      label: "简体中文",
      lang: "zh-CN",
      title: "Memorai",
      description: "面向 AI 代理的运行时无关、多模态流式记忆库",
      themeConfig: {
        nav: [
          { text: "指南", link: "/zh/guide/introduction", activeMatch: "/zh/guide/" },
          { text: "概念", link: "/zh/concepts/overview", activeMatch: "/zh/concepts/" },
          { text: "API", link: "/zh/api/memorai", activeMatch: "/zh/api/" },
          { text: "运行时", link: "/zh/runtime/compatibility", activeMatch: "/zh/runtime/" },
        ],
        sidebar: {
          "/zh/guide/": [
            {
              text: "指南",
              items: [
                { text: "简介", link: "/zh/guide/introduction" },
                { text: "快速开始", link: "/zh/guide/getting-started" },
                { text: "示例", link: "/zh/guide/examples" },
                { text: "子路径导出", link: "/zh/guide/subpath-exports" },
                { text: "性能评测", link: "/zh/guide/benchmarks" },
              ],
            },
          ],
          "/zh/concepts/": [
            {
              text: "核心概念",
              items: [
                { text: "总览", link: "/zh/concepts/overview" },
                { text: "Memory Nodes", link: "/zh/concepts/memory-nodes" },
                { text: "Memory Events", link: "/zh/concepts/memory-events" },
                { text: "分层演进", link: "/zh/concepts/evolution" },
                { text: "召回", link: "/zh/concepts/retrieval" },
                { text: "跨代理记忆", link: "/zh/concepts/cross-agent" },
              ],
            },
          ],
          "/zh/api/": [
            {
              text: "API 参考",
              items: [
                { text: "Memorai", link: "/zh/api/memorai" },
                { text: "Storage Adapter", link: "/zh/api/storage" },
                { text: "Event Store", link: "/zh/api/event-store" },
                { text: "Event Identifier", link: "/zh/api/event-identifier" },
                { text: "Evolution Engine", link: "/zh/api/evolution-engine" },
                { text: "Retrieval Engine", link: "/zh/api/retrieval-engine" },
                { text: "Embedding Service", link: "/zh/api/embeddings" },
                { text: "Compression Service", link: "/zh/api/compression" },
              ],
            },
          ],
          "/zh/runtime/": [
            {
              text: "运行时",
              items: [{ text: "兼容性与生命周期", link: "/zh/runtime/compatibility" }],
            },
          ],
        },
        editLink: {
          pattern: "https://github.com/Naeemo/memorai/edit/main/packages/docs/docs/:path",
          text: "在 GitHub 上编辑此页",
        },
        footer: {
          message: "基于 MIT License 发布",
          copyright: "Copyright © Naeemo",
        },
        darkModeSwitchLabel: "外观",
        sidebarMenuLabel: "目录",
        returnToTopLabel: "回到顶部",
        outlineTitle: "本页目录",
        docFooter: { prev: "上一页", next: "下一页" },
        lastUpdatedText: "最近更新",
      },
    },
  },
});
