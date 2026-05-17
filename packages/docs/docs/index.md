---
layout: home

hero:
  name: Memorai
  text: Streaming memory for AI agents
  tagline: Three-tier storage. Multi-pathway recall. Semantic events that supersede each other. Runtime-agnostic — Browser, Node.js, Bun, Deno.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Why Memorai
      link: /guide/introduction
    - theme: alt
      text: GitHub
      link: https://github.com/Naeemo/memorai

features:
  - icon: 🗂️
    title: Three-tier storage
    details: Tier 1 raw events (immutable timeline). Tier 2 derived annotations (regenerable via reAnnotate). Tier 3 indexes. Upgrade the model — keep the past.
  - icon: 🧩
    title: Semantic event layer
    details: An LLM identifier turns raw turns into state / transition / happening events with supersede lifecycle. Recall returns what the agent currently believes, not every raw utterance.
  - icon: 🔀
    title: Multi-pathway recall
    details: Semantic + BM25 + tag + temporal + identity routes fan out in parallel and fuse via Reciprocal Rank Fusion. Every result carries pathway-level provenance.
  - icon: 🔌
    title: Pluggable everything
    details: Storage adapters (Memory / SQLite / IndexedDB / your own). Embedders (Ollama / OpenAI / custom). LLMs, extractors, identifiers, rerankers — every layer is swappable.
  - icon: 🌐
    title: Runtime agnostic
    details: One TypeScript package, four runtimes. Core depends only on Web Standard APIs.
  - icon: 🤝
    title: Cross-agent profiles
    details: Multiple agents share one store with per-agent read/write policies. Reasoning agents see episodes; proactive agents see segments.
---

<div style="max-width: 960px; margin: 4rem auto 0; padding: 0 1.5rem;">

## In thirty seconds

```typescript
import { Memorai, MemoryAdapter, OllamaEmbeddingService } from 'memorai';

const memory = new Memorai({
  storage: new MemoryAdapter(),
  embedding: new OllamaEmbeddingService({ model: 'nomic-embed-text' }),
  llm: yourLLMService,  // auto-wires LLMExtractor + LLMEventIdentifier
});

// Record events from a conversation
memory.recordEvent({
  at: Date.now(),
  actor: 'user',
  content: { kind: 'message', text: 'I just started eating fish again' },
});

await memory.evolve();  // identifies the state transition

// Recall semantic events, not raw turns
const result = await memory.recall('what does the user eat?');
console.log(result.memories[0].summary);
// → "User started eating fish again"
```

[Continue to Getting Started →](/guide/getting-started)

</div>
