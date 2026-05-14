---
layout: home

hero:
  name: Memorai
  text: Streaming memory for AI agents
  tagline: Runtime-agnostic, multimodal memory with hierarchical evolution. Browser • Node.js • Bun • Deno.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/introduction
    - theme: alt
      text: Architecture
      link: /concepts/overview
    - theme: alt
      text: View on GitHub
      link: https://github.com/Naeemo/memorai

features:
  - icon: 🎞️
    title: Multimodal Memory Nodes
    details: Store text, images, audio, and video references together with embeddings and structured metadata — without forced text conversion.
  - icon: 🌱
    title: Hierarchical Memory Evolution
    details: Raw segments are merged into atomic actions and aggregated into events automatically — short-term recall plus long-term abstraction.
  - icon: 🔌
    title: Pluggable Storage
    details: IndexedDB in the browser, SQLite or in-memory on the server, or bring your own adapter. The interface is small and runtime-agnostic.
  - icon: 🧠
    title: Pluggable Embeddings
    details: OpenAI, Ollama, or any custom embedding service — model choice is yours.
  - icon: 🌐
    title: Runtime Agnostic
    details: One package, four runtimes. The core depends only on Web Standard APIs.
  - icon: 🤝
    title: Cross-Agent Profiles
    details: Different agents share unified storage with differentiated read/write policies.
---
