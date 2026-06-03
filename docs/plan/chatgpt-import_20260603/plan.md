# Implementation Plan: ChatGPT History Importer for Memorai

**Track ID:** chatgpt-import_20260603
**Spec:** [spec.md](./spec.md)
**Created:** 2026-06-03
**Status:** [ ] Not Started

---

## Overview

Build a Chrome extension that imports ChatGPT conversation history into Memorai's IndexedDB storage, with deduplication and natural-language search. The extension uses ChatGPT's frontend API (not the official API) to fetch history, Ollama for local embeddings, and Memorai's Event API for storage.

---

## Phase 1: Extension Skeleton

Set up the Chrome extension project structure and Memorai integration.

### Tasks
- [ ] Task 1.1: Create `packages/chatgpt-importer/` directory with `package.json` (manifest v3, Vite, TypeScript)
- [ ] Task 1.2: Write `manifest.json` with host permissions for `chatgpt.com`, content script, background service worker, and popup
- [ ] Task 1.3: Configure Vite build to output `content.js`, `background.js`, and `popup/` into `dist/` directory
- [ ] Task 1.4: Initialize Memorai in `background.ts` with `IndexedDBAdapter` and `OllamaEmbeddingService` (local `nomic-embed-text`)
- [ ] Task 1.5: Add `chrome-extension://` storage permission and test that IndexedDB opens successfully in extension context

### Verification
- [ ] Extension loads in Chrome Dev mode without errors
- [ ] Background service worker initializes Memorai and IndexedDB
- [ ] Popup opens and shows basic UI

---

## Phase 2: ChatGPT Data Access

Implement ChatGPT frontend API client to fetch conversation history.

### Tasks
- [ ] Task 2.1: Create `src/importer/chatgpt-api.ts` — read `access_token` from page context (via `chrome.scripting.executeScript` or `window.__remixContext`)
- [ ] Task 2.2: Implement `fetchConversations(offset, limit)` — calls `GET /backend-api/conversations`
- [ ] Task 2.3: Implement `fetchConversationDetail(id)` — calls `GET /backend-api/conversation/{id}`
- [ ] Task 2.4: Add error handling for unauthenticated users, token expiry, and rate limiting
- [ ] Task 2.5: Cache conversation list in `chrome.storage.session` to avoid re-fetching during pagination

### Verification
- [ ] Content script can extract token from chatgpt.com page
- [ ] Background worker can fetch full conversation list (test with 50+ conversations)
- [ ] Detail API returns message array with correct fields

---

## Phase 3: Import Pipeline

Build the mapping, deduplication, and batch import logic.

### Tasks
- [ ] Task 3.1: Create `src/importer/mapper.ts` — map ChatGPT message schema to Memorai `Event` with `meta.eventId` prefixed as `chatgpt-msg:{id}`
- [ ] Task 3.2: Create `src/importer/dedup.ts` — query Memorai for existing `eventId` before writing, skip duplicates
- [ ] Task 3.3: Implement `importConversations(conversations)` — iterate list, fetch detail, map, dedup, write via `recordEvent()`
- [ ] Task 3.4: Implement `src/importer/progress.ts` — track total/completed/skipped/failed counts, support cancellation via `AbortController`
- [ ] Task 3.5: Add batching — process 10 messages at a time to avoid blocking the service worker event loop

### Verification
- [ ] Import 10 conversations → all messages stored in IndexedDB
- [ ] Re-import same 10 conversations → all skipped (dedup works)
- [ ] Import can be cancelled mid-flight, partial data preserved
- [ ] Import 100 messages completes in < 3 minutes (embedding included)

---

## Phase 4: UI — Popup (Quick Entry) + Search Page (Deep Recall)

Build popup as quick entry point and independent search page as deep recall interface.

### Popup Tasks
- [ ] Task 4.1: Build popup layout: import button (primary), progress bar, stats cards, quick search input, "Open search page" button, settings link
- [ ] Task 4.2: Wire import button → send message to background → start import → stream progress back to popup
- [ ] Task 4.3: Implement quick search in popup: `memory.recall(query, { topK: 3 })` — show recent 3 matches, click to open search page or ChatGPT
- [ ] Task 4.4: Add "Open search page" button — opens `chrome-extension://{id}/search.html` in new tab
- [ ] Task 4.5: Style popup with Tailwind or plain CSS, keep height < 400px

### Search Page Tasks
- [ ] Task 4.6: Build `search.html` layout: full-width search bar, filter sidebar, result list, conversation detail panel
- [ ] Task 4.7: Implement semantic search: `memory.recall(query, { topK: 20 })` with keyword fallback
- [ ] Task 4.8: Build result list: timestamp, conversation title, message snippet, relevance score, click to expand detail
- [ ] Task 4.9: Build conversation detail panel: full message flow (user/assistant), preserve Markdown, "Open in ChatGPT" link
- [ ] Task 4.10: Add filters: time range, actor (user/assistant), tags, conversation title search
- [ ] Task 4.11: Add timeline view: group by date, browse like ChatGPT history list
- [ ] Task 4.12: Add "Export as Markdown" button on each conversation — download `.md` file

### Verification
- [ ] Popup: Click import → progress updates in real-time
- [ ] Popup: Type "正则" → shows 3 quick matches, click opens search page
- [ ] Search page: Full search returns 20 results, supports filters
- [ ] Search page: Click result → expands conversation detail with Markdown preserved
- [ ] Search page: Click "Export as Markdown" → downloads correct `.md` file
- [ ] Search page: Click "Open in ChatGPT" → opens correct conversation in new tab
- [ ] Stats show correct numbers after import

---

## Phase 5: Settings, Export & Polish

Add configuration, export features, and edge case handling.

### Tasks
- [ ] Task 5.1: Add settings page (or popup section): Ollama URL input, model selector, "Clear all data" button, export path
- [ ] Task 5.2: Detect Ollama availability on startup — ping `http://localhost:11434/api/tags`, show warning if unreachable
- [ ] Task 5.3: Handle long messages (> 8000 chars) — truncate before embedding, log warning
- [ ] Task 5.4: Handle messages with code blocks — preserve Markdown formatting in `content.text`
- [ ] Task 5.5: Add keyboard shortcut (`Ctrl+Shift+M`) to open popup
- [ ] Task 5.6: Add right-click context menu on `chatgpt.com` — "Import this conversation to Memorai"
- [ ] Task 5.7: Implement "Export all conversations as Markdown" — batch export to `.md` files with frontmatter (title, date, URL)
- [ ] Task 5.8: Add background import badge — show progress on extension icon when popup is closed

### Verification
- [ ] Change Ollama URL in settings → search uses new endpoint
- [ ] Clear data → IndexedDB wiped, stats reset to 0
- [ ] Long message truncated but still searchable
- [ ] Code block formatting preserved in search results
- [ ] Export all → downloads ZIP with all conversations as `.md` files
- [ ] Background import shows progress badge on extension icon

---

## Phase 6: Docs & Cleanup

### Tasks
- [ ] Task 6.1: Write `packages/chatgpt-importer/README.md` — installation, usage, Ollama setup, search page usage, export feature
- [ ] Task 6.2: Add screenshot/GIF of import + search + export flow to README
- [ ] Task 6.3: Update root `README.md` with "ChatGPT Importer" section linking to sub-package
- [ ] Task 6.4: Document the recall architecture: popup (quick entry) vs search page (deep recall) vs export (external access)
- [ ] Task 6.5: Run linter, fix any warnings, ensure build passes
- [ ] Task 6.6: Verify no `console.log` left in production code (use `console.debug` or remove)

### Verification
- [ ] README has clear setup steps for non-technical users
- [ ] README explains where to find imported data (popup + search page + export)
- [ ] `pnpm build` produces clean `dist/` with all extension files (popup + search page)
- [ ] No lint errors, no TypeScript errors

## Final Verification
- [ ] All acceptance criteria from spec met (popup search + search page + export)
- [ ] Extension installs from `.zip` in Chrome and Edge
- [ ] Import → Search → Export → Open flow works end-to-end
- [ ] Documentation up to date (recall architecture explained)
- [ ] No lint errors, tests pass (if any), build succeeds

---

_Generated by /plan. Tasks marked [~] in progress and [x] complete by /build._
