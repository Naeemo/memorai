# Examples

The `packages/memorai/examples/` directory contains runnable programs that exercise different parts of the system. Each one is self-contained — read it top-to-bottom and adapt to your project.

| Example | Runtime | What it shows |
|---|---|---|
| [`browser-assistant.ts`](https://github.com/Naeemo/memorai/blob/main/packages/memorai/examples/browser-assistant.ts) | Browser | Browser AI assistant with page visit / click / input memory |
| [`node-server.ts`](https://github.com/Naeemo/memorai/blob/main/packages/memorai/examples/node-server.ts) | Node.js | HTTP API server backed by SQLite + background evolution |
| [`cross-agent.ts`](https://github.com/Naeemo/memorai/blob/main/packages/memorai/examples/cross-agent.ts) | Any | Two agents (Reasoning + Proactive) sharing the same storage |
| [`openclaw-agent.ts`](https://github.com/Naeemo/memorai/blob/main/packages/memorai/examples/openclaw-agent.ts) | Browser / Node | OpenClaw agent integration with heartbeat hooks |

## Running an example locally

```bash
git clone https://github.com/Naeemo/memorai.git
cd memorai
pnpm install
pnpm --filter memorai build

# Pick an example
node --import tsx packages/memorai/examples/node-server.ts
```

> The exact command will vary by runtime. Browser examples are intended to be bundled into your own app; the Node and OpenClaw examples are runnable as scripts.

## Patterns worth stealing

- **Streaming heartbeat writes.** The `openclaw-agent` example shows how to convert a tick-by-tick agent loop into bounded memory writes without flooding storage.
- **Two agents, one store.** `cross-agent.ts` demonstrates how a Reasoning agent and a Proactive agent can coexist in the same IndexedDB with different read/write policies.
- **Manual `evolve()` calls.** `node-server.ts` shows when to trigger Level-2 evolution explicitly versus relying on the background loop.
