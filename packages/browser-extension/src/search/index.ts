// Search page logic

interface SearchResult {
  id: string;
  at: number;
  actor: string;
  summary: string;
  text: string;
  conversationId: string;
  score: number;
  tags: string[];
}

let currentResults: SearchResult[] = [];

async function init() {
  await loadStats();
  setupSearch();
  setupFilters();
  document.getElementById("export-all-btn")!.addEventListener("click", exportAllMarkdown);
}

async function loadStats() {
  const stats = await chrome.runtime.sendMessage({ type: "GET_STATS" });
  if (stats.error) return;

  document.getElementById("total-conversations")!.textContent = `${stats.conversations} conversations`;
  document.getElementById("total-messages")!.textContent = `${stats.messages} messages`;
}

async function exportAllMarkdown() {
  const btn = document.getElementById("export-all-btn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Exporting...";

  try {
    const result = await chrome.runtime.sendMessage({ type: "SEARCH", query: "", topK: 10000 });
    if (result.error) throw new Error(result.error);

    const byConv = new Map<string, typeof result.memories>();
    for (const m of result.memories) {
      const convId = m.conversationId || "unknown";
      if (!byConv.has(convId)) byConv.set(convId, []);
      byConv.get(convId)!.push(m);
    }

    const sections: string[] = [];
    for (const [convId, messages] of byConv) {
      const sorted = [...messages].sort((a, b) => a.at - b.at);
      const title = sorted[0]?.summary || "ChatGPT Conversation";
      const date = new Date(sorted[0]?.at ?? Date.now()).toISOString();
      const body = sorted
        .map((m) => `**${m.actor}** · ${new Date(m.at).toLocaleString()}\n\n${m.text || m.summary || ""}`)
        .join("\n\n---\n\n");

      sections.push(`---
title: "${title.replace(/"/g, '\\"')}"
date: ${date}
url: https://chatgpt.com/c/${convId}
---

# ${title}

${body}
`);
    }

    const markdown = sections.join("\n\n");
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chatgpt-export-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(`Export failed: ${(err as Error).message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Export All";
  }
}

function setupSearch() {
  const input = document.getElementById("search-input") as HTMLInputElement;
  const btn = document.getElementById("search-btn")!;

  const doSearch = async () => {
    const query = input.value.trim();
    if (!query) return;

    showLoading();
    try {
      const result = await chrome.runtime.sendMessage({ type: "SEARCH", query, topK: 20 });
      if (result.error) throw new Error(result.error);

      currentResults = result.memories;
      renderResults(currentResults);
    } catch (err) {
      showError((err as Error).message);
    }
  };

  btn.addEventListener("click", doSearch);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });
}

function setupFilters() {
  const timeFilter = document.getElementById("filter-time") as HTMLSelectElement;
  const actorFilter = document.getElementById("filter-actor") as HTMLSelectElement;
  const tagsFilter = document.getElementById("filter-tags") as HTMLInputElement;

  const applyFilters = () => {
    let filtered = [...currentResults];

    // Time filter
    const timeValue = timeFilter.value;
    if (timeValue !== "all") {
      const now = Date.now();
      const days = parseInt(timeValue);
      const cutoff = now - days * 24 * 60 * 60 * 1000;
      filtered = filtered.filter((r) => r.at >= cutoff);
    }

    // Actor filter
    const actorValue = actorFilter.value;
    if (actorValue !== "all") {
      filtered = filtered.filter((r) => r.actor === actorValue);
    }

    // Tags filter
    const tagsValue = tagsFilter.value.trim().toLowerCase();
    if (tagsValue) {
      const tags = tagsValue.split(",").map((t) => t.trim());
      filtered = filtered.filter((r) => tags.some((t) => r.tags?.some((rt) => rt.toLowerCase().includes(t))));
    }

    renderResults(filtered);
  };

  timeFilter.addEventListener("change", applyFilters);
  actorFilter.addEventListener("change", applyFilters);
  tagsFilter.addEventListener("input", () => {
    window.clearTimeout((tagsFilter as any)._timeout);
    (tagsFilter as any)._timeout = window.setTimeout(applyFilters, 300);
  });
}

function renderResults(results: SearchResult[]) {
  const container = document.getElementById("search-results")!;

  if (results.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>No results found. Try a different query or import more conversations.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = results
    .map(
      (r) => `
    <div class="result-item" data-id="${r.id}" data-conv="${r.conversationId}"
      onclick="selectResult('${r.id}')"
      onkeydown="if(event.key==='Enter')selectResult('${r.id}')"
      tabindex="0"
      role="button"
      aria-label="Search result: ${escapeHtml(r.summary || "ChatGPT Message")}"
    >
      <div class="result-header">
        <span class="result-title">${escapeHtml(r.summary || "ChatGPT Message")}</span>
        <span class="result-score">${(r.score * 100).toFixed(1)}%</span>
      </div>
      <div class="result-meta">${r.actor} · ${new Date(r.at).toLocaleDateString()} · ${r.tags?.join(", ") || ""}</div>
      <div class="result-snippet">${escapeHtml(r.text?.slice(0, 120) || "")}...</div>
    </div>
  `
    )
    .join("");
}

(window as any).selectResult = function (id: string) {
  document.querySelectorAll(".result-item").forEach((el) => el.classList.remove("active"));
  document.querySelector(`[data-id="${id}"]`)?.classList.add("active");

  const result = currentResults.find((r) => r.id === id);
  if (result) {
    renderDetail(result);
  }
};

function renderDetail(result: SearchResult) {
  const panel = document.getElementById("detail-panel")!;

  panel.innerHTML = `
    <div class="detail-header">
      <h2>${escapeHtml(result.summary || "ChatGPT Message")}</h2>
      <div class="detail-meta">${result.actor} · ${new Date(result.at).toLocaleString()} · Score: ${(result.score * 100).toFixed(1)}%</div>
    </div>
    <div class="detail-actions">
      <a href="https://chatgpt.com/c/${result.conversationId}" target="_blank" class="btn-secondary">Open in ChatGPT</a>
      <button class="btn-ghost" onclick="exportMarkdown('${result.id}')">Export Markdown</button>
      <button class="btn-ghost" onclick="copyText('${result.id}')">Copy</button>
    </div>
    <div class="message-flow">
      <div class="message ${result.actor}">
        <div class="message-header">${result.actor}</div>
        <div class="message-content">${renderMarkdown(result.text || "")}</div>
      </div>
    </div>
  `;
}

(window as any).exportMarkdown = async function (id: string) {
  const result = currentResults.find((r) => r.id === id);
  if (!result) return;

  const markdown = `---
title: "${result.summary || "ChatGPT Message"}"
date: ${new Date(result.at).toISOString()}
url: https://chatgpt.com/c/${result.conversationId}
actor: ${result.actor}
score: ${result.score}
---

# ${result.summary || "ChatGPT Message"}

**${result.actor}** · ${new Date(result.at).toLocaleString()}

${result.text || ""}
`;

  const blob = new Blob([markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `chatgpt-${result.conversationId}.md`;
  a.click();
  URL.revokeObjectURL(url);
};

(window as any).copyText = async function (id: string) {
  const result = currentResults.find((r) => r.id === id);
  if (!result || !result.text) return;

  await navigator.clipboard.writeText(result.text);
};

function renderMarkdown(text: string): string {
  // Basic Markdown rendering for display (not full parser)
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\n/g, "<br>");
}

function showLoading() {
  document.getElementById("search-results")!.innerHTML = `
    <div class="loading">Searching...</div>
  `;
}

function showError(msg: string) {
  document.getElementById("search-results")!.innerHTML = `
    <div class="empty-state">
      <p>Error: ${escapeHtml(msg)}</p>
    </div>
  `;
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

init().catch(console.error);
