# @memorai/browser-extension

Chrome extension to import ChatGPT conversation history into [Memorai](https://github.com/Naeemo/memorai) for local search and recall.

## Features

- **One-click import** — Import all ChatGPT history from your browser session
- **Smart deduplication** — Only imports new conversations on subsequent runs
- **Local search** — Semantic search powered by Memorai + Ollama embeddings
- **Dual recall entry** — Quick popup search + full-size search page for deep browsing
- **Export to Markdown** — Export individual conversations or batch export all as `.md` files
- **Privacy-first** — All data stays in your browser (IndexedDB), no external servers

## Quick Start

### Prerequisites

1. **Ollama** installed with `nomic-embed-text` model:
   ```bash
   ollama pull nomic-embed-text
   ollama serve
   ```

2. **Chrome** or **Edge** browser

3. **ChatGPT account** — Logged in at [chatgpt.com](https://chatgpt.com)

### Install

1. Build the extension:
   ```bash
   cd packages/browser-extension
   pnpm install
   pnpm build
   ```

2. Load in Chrome:
   - Open `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the `packages/browser-extension/dist/` folder

3. Click the Memorai icon on ChatGPT page → "Import ChatGPT History"

### Search

- **Popup** — Quick search from extension icon, shows top 3 results
- **Search Page** — Click "Open Search Page" for full-size interface with filters, timeline, and export

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  chatgpt.com    │────▶│  Chrome Extension│────▶│  Memorai        │
│  (DOM + API)    │     │  - Background    │     │  - IndexedDB    │
│                 │     │  - Popup         │     │  - BM25 + Vec   │
│                 │     │  - Search Page   │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                │
                                ▼
                        ┌──────────────────┐
                        │  Ollama (local)    │
                        │  nomic-embed-text  │
                        └──────────────────┘
```

## Data Mapping

| ChatGPT | Memorai |
|---|---|
| `message.id` | `Event.id` (prefixed: `chatgpt-msg:`) |
| `author.role` | `actor` (`user` / `assistant`) |
| `content.parts[0]` | `content.text` |
| `create_time` | `at` (Unix ms) |
| `conversation.title` | `tags` |

## Development

```bash
# Install dependencies
pnpm install

# Dev build (watch)
pnpm dev

# Production build
pnpm build

# Type check
pnpm check

# Lint
pnpm lint
```

## License

MIT © [Naeemo](https://github.com/Naeemo)
