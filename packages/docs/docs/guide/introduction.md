# Introduction

**Memorai** is a runtime-agnostic, multimodal streaming memory layer for AI agents. It runs anywhere JavaScript runs — browsers, Node.js, Bun, Deno — and brings the ideas behind [StreamingClaw's StreamingMemory](https://jackyu6.github.io/StreamingClaw-Page/) architecture to the TypeScript ecosystem.

Where traditional agent memory dumps a flat text history into a context window, Memorai treats memory as a **streaming, evolving, multimodal graph**: segments compress into atomic actions, atomic actions aggregate into events, and retrieval is concurrent, temporal, and command-driven.

## Why Memorai?

| Problem | Traditional approach | Memorai |
|---|---|---|
| **Information loss** | Store only text summaries | Multimodal memory nodes — vision, audio, embeddings, text together |
| **Inefficiency** | Dump all memory into context | Hierarchical evolution — compress and structure, retrieve only what's needed |
| **Rigid memory** | Flat, isolated entries | Hierarchical and evolvable — segments → atomic actions → events, with add/update/delete |

## Core Principles

1. **Multimodal-first.** A memory node can hold video frames, audio clips, embedding vectors, structured metadata, and text — all aligned by timestamp.
2. **Hierarchical evolution.** Short-term memories (fine-grained, recent) automatically evolve into long-term memories (abstract, structured) through online induction and merging.
3. **Efficient retrieval.** Command-driven, concurrent, with self-directed temporal traversal (forward, reverse, salience-first).
4. **Runtime-agnostic.** The same code runs in Browser (IndexedDB), Node.js (SQLite), Bun, and Deno. Storage is fully abstracted.
5. **Cross-agent unified.** Standardised storage and retrieval interfaces, with differentiated memory management per agent role.
6. **Streaming-native.** Designed for continuous, real-time input — not batch processing of offline files.

## Features at a glance

- **Multimodal Memory Nodes** — text, images, audio, and video references with embeddings and metadata
- **Hierarchical Memory Evolution (HME)** — raw segments → atomic actions → events, with automatic online merging
- **Pluggable Storage** — IndexedDB (browser), SQLite (server), in-memory (testing), or bring your own
- **Pluggable Embeddings** — OpenAI, Ollama, or any custom embedding service
- **Runtime Agnostic** — the same code runs anywhere JavaScript runs
- **Cross-Agent Memory Profiles** — agents with different read/write policies share unified storage

## Where to go next

- [Getting Started](/guide/getting-started) — install and write your first memory in a few lines.
- [Concepts](/concepts/overview) — how memory nodes, evolution, and retrieval fit together.
- [API Reference](/api/memorai) — the `Memorai` class and its surrounding services.
