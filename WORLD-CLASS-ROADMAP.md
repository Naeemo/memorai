# Memorai — World-Class Roadmap

> **Date:** 2026-05-18
> **Baseline:** v0.4.0 (LoCoMo conv-26 36.84% wrap+identifier, LongMemEval oracle 75%)
> **Goal:** Architectural review + prioritized plan to take Memorai from "promising" to *the* canonical agent memory library, designed for today's agents and what's coming next.

---

## Where Memorai stands today

Memorai already has the right *spine* for a world-class agent memory library, and several things that genuinely differentiate it:

- **Three-tier (raw / annotations / indexes) with `reAnnotate()`** is a real moat. No JS-side competitor lets you upgrade extractor or embedding model without losing the timeline. Mem0/Letta destructively summarize at ingest.
- **MemoryEvent layer with explicit `supersedes` + `invalidatedAt`** (0.4.0) moves you toward knowledge-graph systems while keeping Tier 1 intact. The +15pp jump on LoCoMo conv-26 validates the design.
- **Multi-pathway RRF with per-pathway provenance** is rare and useful. Most libs return scored docs with no explanation; Memorai can trace *why* a memory surfaced.
- **Runtime-agnostic by design** is unusual — unlocks browser/embedded scenarios competitors don't reach.

The honest read on benchmarks: 36.84% on LoCoMo conv-26 is real progress from 21.71%, but published mem0-class numbers on full LoCoMo sit in the 60s. **Closing that gap, and going beyond it for the next wave of agents, is the actual "world-class" agenda.**

---

## Tier 1 — Foundations you can't be "world-class" without

### 1. Vector index abstraction (ANN)

`semanticPathway` in `retrieval.ts:189` does `storage.listAll()` + linear cosine. `InMemoryEventStore.queryEventsByEmbedding` is the same. At 10K nodes per user the system feels slow; at 100K it's broken.

**Plan:**
- New `VectorIndex` interface alongside `StorageAdapter`: `addVector(id, vec, filter?)`, `queryVector(vec, topK, filter?)`, `delete(id)`, `rebuild()`.
- Ship `HnswVectorIndex` (`hnswlib-wasm` or `hnswlib-node`) + a `BruteForceVectorIndex` fallback that wraps current logic.
- Adapters optionally expose `getVectorIndex(): VectorIndex | null` — present → retrieval uses it, absent → fall back.

**Outcome:** scales to 10M+ memories honestly. 2-week project, mostly mechanical.

### 2. First-class temporal grounding

8.1% on temporal LoCoMo is the published weak spot. The `temporal` strategy only applies recency decay.

**Plan:**
- A **time-expression resolver** at query time: "last Tuesday", "in March", "before the migration" → `timeRange`. Heuristic parser + optional LLM fallback.
- **Temporal anchors as first-class metadata** on every event/MemoryEvent: `{ absolute?: number, relativeTo?: { eventId, deltaMs } }`. Enables "what did Alice say *before* the migration started" as a precise query.
- A `temporal-anchor` pathway in retrieval that scores anchor proximity, not just recency.

### 3. Knowledge graph layer over triples

`LLMExtractor` already produces `KnowledgeTriple`. They sit on `annotations.triples` but there's no graph storage, no traversal, no path query. Most visible structural gap vs. Zep/Graphiti.

**Plan:**
- `EntityGraph` interface: `upsertNode`, `upsertEdge(s, p, o, sourceEventId, validAt?, invalidatedAt?)`, `queryPaths(from, to, maxDepth)`, `queryNeighbors(entity, predicate?)`.
- In-memory default + SQLite adapter mirroring `events/store.ts`.
- Graph traversal becomes another **retrieval pathway** fused via RRF.
- Triples participate in event identification: `supersedes` keyed on `(subject, predicate)` gives precise belief-revision grounded in existing 0.4.0 work.

### 4. User profile / materialized "what I know about you" view

Mem0's selling point is `Alice prefers tea over coffee` surfaced *directly*. MemoryEvent layer can hold this as `kind: state`, but it isn't queryable as a profile — every recall goes through full retrieval + LLM rerank.

**Plan:**
- A derived profile store: for each `(userId, primaryParticipant)`, materialize the currently-valid `state` events plus their topics. Queryable as `getUserFacts(userId, topic?)`.
- Maintained on `state` event insert/supersede (most plumbing exists).
- `recall()` surfaces it automatically as a preamble when the question is identity-shaped.

### 5. Working memory / scratchpad layer

Memorai only has LTM. Real agents need a fast structured workspace that doesn't get HME-merged or LLM-extracted — current task, current beliefs, pending steps, intermediate tool outputs.

**Plan:**
- `Memorai.workingMemory()` returning a typed scratchpad: `set/get/append/clear` with optional TTL.
- Stored under `level: "working"`, excluded from HME and default recall unless `includeWorking: true`.
- Aged working entries become reflection candidates ("promote to a real memory?").

---

## Tier 2 — Differentiators for the next generation of agents

### 6. Procedural memory (tool calls / code / plans)

Today's agents are tool-using. There is no `EventContent.kind: "tool_call"`, no "I tried this and it failed" memory. Without this, agents repeat tool failures.

**Plan:**
- Add `EventContent` kinds: `tool_call` (`{ tool, args, result, success, durationMs, errorClass? }`) and `plan_step`.
- A `procedural` retrieval strategy that surfaces "the last N times I tried tool X with similar args."
- Built-in `proceduralExtractor` that pulls tool-success signals automatically.

**Outcome:** the difference between "memory" and "agent skills" — and the JS ecosystem has nobody filling this role.

### 7. Belief revision + self-reflection hooks

`MemoryEvent.supersedes` is a perfect substrate for belief revision, but only `LLMEventIdentifier` triggers it. Agents should be able to *explicitly* say "I learned my prior belief about X was wrong, here's the new one."

**Plan:**
- `Memorai.reviseBelief({ supersedes, newDescription, occurredAt, reason })` — creates a new state event invalidating the old, with `reason` attached as provenance.
- Passive contradiction detector during `evolve()`: cluster state events by `(participants, topic)`, flag conflicts via callback for the agent to reconcile.
- Track a `revisionChain` per event so callers can show "third update on Alice's preferences."

### 8. Forgetting + consolidation policy

STM-full triggers exist but there's no actual forgetting model. True lifelong memory needs decay.

**Plan:**
- `RetentionPolicy` interface: `score(node, now): number`, `shouldEvict(node, ctx): boolean`.
- Default: `retention = 0.5*salience + 0.3*recency_decay + 0.2*log(1+accessCount)`. Below threshold + age > N → evict Tier 2/3, keep Tier 1 (immutable promise stays).
- Consolidation in `evolve()`: high-retention nodes get re-extracted into stronger episodes; low-retention groups merge into a single "background context" node.

### 9. Multi-agent / shared memory primitives

Today `agentProfile` + `userId` are filters, not partitions; no subscriptions or federation.

**Plan:**
- `namespace` becomes a partition key — adapters get a `namespace?` param on every method and can physically partition.
- `Memorai.subscribe(filter, callback)` — proactive agents register interest, notified post-write.
- `MemoryFederation` primitive — instances share a tag set with peers, peer pulls via a serialized read API. Seed for multi-device / multi-agent memory.

### 10. Streaming ingest with backpressure

`recordEvent` is fine for chat but observation-heavy agents write 50–500 events/sec.

**Plan:**
- `recordStream(asyncIter)` that buffers, dedupes (hash, `(participant, topic, time-bucket)`), batches embeddings.
- Explicit backpressure: STM at 80% → slow producers; at 100% → drop or downgrade extractor.
- Low-level Tier-1-only `appendRaw(content)` path that skips Tier 2/3, queued for batch extraction later.

---

## Tier 3 — Quality, ops, and DX

### 11. Cross-encoder reranker (not LLM)

`LLMReranker` is expensive and slow. A loadable cross-encoder (`BAAI/bge-reranker-base` via `@xenova/transformers`) reranks 30 docs in ~50ms vs. seconds + dollars. Ship `TransformersReranker`.

### 12. Persistent EventStore implementations

Only `InMemoryEventStore` ships. Multi-tenant deployments need a persistent option. Add `SQLiteEventStore` and `IndexedDBEventStore` — the patterns from `storage/` translate directly.

### 13. Observability + eval framework

- OTel-style spans for every recall phase (semantic, BM25, expand, HyDE, rerank).
- Bake the benchmark harness into the published package as `memorai/eval`.
- `Memorai.explain(question, opts)` returns the candidate set + per-pathway scores + filter decisions without LLM rerank — for debugging.

### 14. Resolve LLM-extractor + identifier noise

`packages/benchmarks/results/published/README.md` notes `llm-extract + identifier-llm` is **-3.9pp** vs. identifier alone. In `composeIndexableText`, `annotations.summary` competes with the event-level canonical description.

**Two paths:**
- Cheap: when a `MemoryEvent` covers a node, suppress `summary` from `composeIndexableText` for that node.
- Right: store summary and event-description in separate indexed text fields and let pathways query them independently.

### 15. DX cleanup

- `examples/node-server.ts` uses `@internal` `write`/`retrieve`. Rewrite to public Event API or relax `@internal` markers.
- Plan a 1.0 cleanup of `MemoryPayload` / `MemoryPayloadInput` back-compat aliases.
- Make `extensions` typed: `Memorai<Ext extends Record<string, unknown>>` generic.

---

## Highest-leverage first 4 (work plan)

In order:

1. **Vector index abstraction (Tier 1 #1)** — unlocks scale, foundational, mostly mechanical work.
2. **Knowledge graph layer (Tier 1 #3)** — closes the most visible gap with Zep/Graphiti, triples already exist.
3. **Procedural memory + tool-call kind (Tier 2 #6)** — where the next generation of agents lives, JS ecosystem is empty here.
4. **Temporal grounding (Tier 1 #2)** + **user-profile view (Tier 1 #4)** — together these close the published-benchmark gap with mem0.

After those, Memorai can publish a head-to-head with mem0 + Letta on full LoCoMo, and the architecture would be visibly more general than either.

---

## Benchmark hygiene

The 100% scores on the synthetic suite in `README.md` aren't useful signal to outside readers — public datasets are. The published LoCoMo + LongMemEval numbers in `packages/benchmarks/results/published/` are the credible story; feature *those* in the README, not custom synthetics. A side-by-side vs. mem0 + Letta on full LoCoMo would dramatically strengthen the pitch even at current accuracy.
