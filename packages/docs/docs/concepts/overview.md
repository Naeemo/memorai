# Overview

Memorai is built on three observations about how agents accumulate memory in the real world:

1. Memory is not just text — agents see, hear, and act, and forcing every modality through a text bottleneck loses information.
2. Memory is hierarchical — recent moments are fine-grained, older ones are abstract. The system should let memory _evolve_ instead of dumping everything at one level of detail.
3. Memory must be retrievable on demand — not pre-loaded into a context window, but pulled in concurrently when an agent asks for it.

This page sketches the system end-to-end. The pages that follow go deep on each piece.

## What we learn from StreamingClaw

| Problem | Traditional approach | StreamingMemory approach |
|---|---|---|
| **Information loss** | Store only text summaries | Multimodal memory nodes — preserve vision, audio, embedding, text together |
| **Inefficiency** | Dump all memory into context | Hierarchical evolution — compress and structure, retrieve only what's needed |
| **Rigid memory** | Flat, isolated entries | Hierarchical and evolvable — segments → atomic actions → events, with add/update/delete |

Memorai applies these ideas in a runtime-agnostic, TypeScript-native package.

## System architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Agent (User Code)                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │  Reasoning  │  │  Planning   │  │  Proactive  │  │       Tools         │ │
│  │   Agent     │  │   Agent     │  │   Agent     │  │  (Video Cut, etc.)  │ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘ │
│         └────────────────┴────────────────┴────────────────────┘            │
│                                       │                                     │
│                              ┌────────▼────────┐                            │
│                              │  Memorai Core   │                            │
│                              │ (Memory Engine) │                            │
│                              └────────┬────────┘                            │
│                                       │                                     │
│         ┌─────────────────────────────┼─────────────────────────────┐       │
│         │                             │                             │       │
│  ┌──────▼──────┐         ┌────────────▼────────────┐    ┌───────────▼───┐   │
│  │  Storage    │         │  Evolution Engine        │    │  Retrieval    │   │
│  │  Adapter    │         │  (HME)                   │    │  Engine       │   │
│  │ (Pluggable) │         │                          │    │ (Concurrent)  │   │
│  └─────────────┘         └──────────────────────────┘    └───────────────┘   │
│                                                                             │
│  ┌──────────────┐        ┌──────────────────┐           ┌──────────────────┐│
│  │  Embedding   │        │  Compression     │           │  Temporal Index  ││
│  │  Service     │        │  (Multimodal)    │           │ (Salience, etc.) ││
│  │ (Pluggable)  │        │                  │           │                  ││
│  └──────────────┘        └──────────────────┘           └──────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                         ┌──────────▼──────────┐
                         │  Storage Backends   │
                         │  ┌───────────────┐  │
                         │  │  IndexedDB    │  │  ← Browser
                         │  │  LevelDB      │  │  ← Node.js / Bun
                         │  │  SQLite       │  │  ← Node.js / Bun / Deno
                         │  │  In-Memory    │  │  ← Testing / Edge
                         │  │  (Custom...)  │  │  ← User-defined
                         │  └───────────────┘  │
                         └─────────────────────┘
```

## The pieces

- **[Memory Nodes](/concepts/memory-nodes)** — the multimodal unit of memory, and the two layers (STM / LTM) it can live in.
- **[Hierarchical Evolution](/concepts/evolution)** — how raw segments turn into atomic actions and events.
- **[Retrieval](/concepts/retrieval)** — the command-driven, concurrent pipeline that answers agent queries.
- **[Cross-Agent Memory](/concepts/cross-agent)** — how multiple agents share one store with different policies.

## Lifecycle at a glance

```
┌──────────┐     ┌───────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Input   │────►│  Raw Segment  │────►│  STM: Segments   │────►│   HME:      │
│  Stream  │     │  (temporal)   │     │  (fine-grained)  │     │  Segment →  │
└──────────┘     └───────────────┘     └──────────────────┘     │  Atomic     │
                                                                │  Action     │
                                                                └──────┬──────┘
                                                                       │
                                                                       ▼
┌──────────┐     ┌──────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Agent   │◄────│  Retrieval   │◄────│  LTM: Events     │◄────│   HME:      │
│  Query   │     │  (efficient) │     │  (abstract)      │     │  Atomic →   │
└──────────┘     └──────────────┘     └──────────────────┘     │  Event      │
                                                                └─────────────┘
```
