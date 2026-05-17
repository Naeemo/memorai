# Overview

Memorai's architecture is shaped by one principle: **the raw timeline is the truth; everything above it is an interpretation that can be replaced.** Each layer has a different lifecycle, and the layers communicate through clean interfaces so each can evolve independently.

## The four layers

```
┌──────────────────────────────────────────────────────────────────┐
│  Tier 3 — Indexes  (computed, disposable)                        │
│                                                                  │
│  BM25 · Vector · Tag · Time · Participant · Topic                │
│  Rebuilt from Tiers 1 + 2 automatically.                         │
└──────────────────────────────────────────────────────────────────┘
                              ▲
┌──────────────────────────────────────────────────────────────────┐
│  Tier 2.5 — MemoryEvents  (lifecycle-managed)                    │
│                                                                  │
│  state / transition / happening events identified by an          │
│  EventIdentifier. State events can be superseded.                │
└──────────────────────────────────────────────────────────────────┘
                              ▲
┌──────────────────────────────────────────────────────────────────┐
│  Tier 2 — Annotations  (regenerable)                             │
│                                                                  │
│  summary · facts · tags · embedding · knowledge triples          │
│  Replaced by reAnnotate() when a better extractor ships.         │
└──────────────────────────────────────────────────────────────────┘
                              ▲
┌──────────────────────────────────────────────────────────────────┐
│  Tier 1 — Raw timeline  (immutable, append-only)                 │
│                                                                  │
│  The exact event content as it happened. Never rewritten.        │
└──────────────────────────────────────────────────────────────────┘
```

## The pieces

| Concept | Lives in | Description |
|---|---|---|
| [`Event`](/api/memorai#recordevent) | input | The shape you pass to `recordEvent()`. Text / image / audio / video / file / observation / custom. |
| [`MemoryNode`](/concepts/memory-nodes) | Tier 1 + 2 | A persisted memory. Carries both `raw` (Tier 1) and `annotations` (Tier 2). Has a `level`: `segment` / `atomic_action` / `episode`. |
| [`MemoryEvent`](/concepts/memory-events) | Tier 2.5 | A semantic event identified from raw nodes. Three kinds: `state`, `transition`, `happening`. Carries its own embedding and supersede chain. |
| [Hierarchical Memory Evolution](/concepts/evolution) | Tier 1 | Background process that clusters raw segments into atomic actions and episodes for locality-aware retrieval. |
| [Event Identification](/concepts/memory-events) | Tier 2.5 | Per-`evolve()` step that turns raw nodes into MemoryEvents. Runs an LLM by default, but the interface accepts any custom identifier. |
| [Multi-pathway Recall](/concepts/retrieval) | reads | Semantic + BM25 + tag + temporal + identity (+ event-level routes) fanned out and fused via RRF. |
| [Cross-Agent Profiles](/concepts/cross-agent) | reads + writes | Per-agent `writePolicy` / `readPolicy` so multiple agents can share one store and see it at different granularities. |

## End-to-end flow

```
┌───────────┐  recordEvent      ┌───────────┐  Tier 1 raw  ┌──────────┐
│  Agent    │ ────────────────► │ Extractor │ ───────────► │  Tier 1  │
└───────────┘                   └───────────┘              │   raw    │
                                      │                    │ (append) │
                                      │ Tier 2 derived     └──────────┘
                                      ▼                          ▲
                                ┌───────────┐                    │
                                │  Tier 2   │                    │
                                │ annotations │                  │ Tier 1
                                └───────────┘                    │
                                      │                          │
            evolve() ┌─────────────────┴─────────────┐           │
                     ▼                                ▼           │
            ┌─────────────────┐                ┌────────────┐    │
            │  HME clustering │                │  Event     │    │
            │ atomic / episode│                │ Identifier │────┘
            └─────────────────┘                └────────────┘
                                                       │
                                                       ▼
                                                 ┌────────────┐
                                                 │ Tier 2.5   │
                                                 │ Memory     │
                                                 │ Events     │
                                                 └────────────┘

                          recall(question)
                          ─────────────────►
                          fan out → RRF → ranked candidates
                          (optional rerank)
                          ─────────────────► result
```

## Three invariants

1. **Tier 1 is append-only.** Once written, raw events are immutable. No extractor, no evolution step, no upgrade ever rewrites them. This is the *永不忘记* promise — even when everything above changes, what was actually observed stays intact.

2. **Tier 2 + Tier 2.5 are regenerable.** Annotations and MemoryEvents are *interpretations* of the raw record. When a better LLM, a smarter prompt, or a domain-specific identifier arrives, you can re-run them across the full history:
   - [`reAnnotate()`](/api/memorai#reannotate) — refresh Tier 2 from Tier 1
   - [`identifyRecent()`](/api/memorai#identifyrecent) — refresh / extend Tier 2.5 from Tier 1
   The raw store is the durable substrate; everything above can be rebuilt.

3. **Tier 3 is disposable.** Indexes are computed artifacts. They can be dropped and rebuilt at any time. The storage adapter maintains them automatically.

## The unique capability

Top-tier memory libraries like mem0 and Zep collapse memory into a single derived layer at ingest time. When their extraction quality improves, old memories don't benefit. When a state assertion becomes outdated, both old and new are in storage and the agent has to figure out which is current.

Memorai's three-tier model lets you:

- **Upgrade the model, re-index everything for free.** A new LLM ships → call `reAnnotate({ extractor: newLLM })` → the entire history is re-summarized without losing the source.
- **Hold multiple interpretations simultaneously.** Run two identifiers (a general one and a domain-specific one) over the same Tier 1 and recall from either.
- **Trace provenance to the source.** Every MemoryEvent points back to the raw nodes it was identified from. Every recalled memory carries the pathways that surfaced it.
- **Replay history.** Filter recall by `validAt` to see what the agent believed at a specific point in time.

## Where to go next

- [Memory Nodes](/concepts/memory-nodes) — the unit of Tier 1 + Tier 2
- [Memory Events](/concepts/memory-events) — the unit of Tier 2.5, including the supersede lifecycle
- [Hierarchical Evolution](/concepts/evolution) — how raw segments cluster into atomic actions and episodes
- [Retrieval](/concepts/retrieval) — how the multi-pathway recall works
- [Cross-Agent Memory](/concepts/cross-agent) — per-agent policies on shared storage
