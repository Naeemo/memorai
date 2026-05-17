import { defineConfig } from "vitepress";

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
    socialLinks: [{ icon: "github", link: "https://github.com/Naeemo/memorai" }],
    editLink: {
      pattern: "https://github.com/Naeemo/memorai/edit/main/packages/docs/docs/:path",
      text: "Edit this page on GitHub",
    },
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © Naeemo",
    },
    search: { provider: "local" },
    outline: { level: [2, 3] },
  },
});
