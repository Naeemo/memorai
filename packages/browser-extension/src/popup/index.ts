// Popup UI logic

document.addEventListener("DOMContentLoaded", () => {
  const importBtn = document.getElementById("import-btn") as HTMLButtonElement;
  const progressEl = document.getElementById("import-progress")!;
  const progressFill = document.getElementById("progress-fill")!;
  const progressText = document.getElementById("progress-text")!;
  const statusEl = document.getElementById("import-status")!;
  const statsSection = document.getElementById("stats-section")!;
  const statConversations = document.getElementById("stat-conversations")!;
  const statMessages = document.getElementById("stat-messages")!;
  const searchInput = document.getElementById("quick-search") as HTMLInputElement;
  const quickResults = document.getElementById("quick-results")!;
  const settingsBtn = document.getElementById("settings-btn")!;

  let importInterval: number | null = null;

  // ─── Load stats on open ───
  loadStats();
  checkOllama();

  // ─── Import ───
  importBtn.addEventListener("click", async () => {
    if (importBtn.disabled) return;

    importBtn.disabled = true;
    progressEl.classList.remove("hidden");
    statusEl.textContent = "Starting import...";

    try {
      const token = await getChatGPTToken();
      if (!token) {
        statusEl.textContent = "Please log in to ChatGPT first";
        importBtn.disabled = false;
        return;
      }

      const response = await chrome.runtime.sendMessage({ type: "IMPORT_START", token });
      if (response.error) throw new Error(response.error);

      statusEl.textContent = "Importing...";
      startProgressPolling();
    } catch (err) {
      statusEl.textContent = `Error: ${(err as Error).message}`;
      importBtn.disabled = false;
    }
  });

  // ─── Quick Search ───
  let searchTimeout: number | null = null;
  searchInput.addEventListener("input", () => {
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = window.setTimeout(() => doQuickSearch(searchInput.value), 300);
  });

  // ─── Settings ───
  settingsBtn.addEventListener("click", () => {
    alert("Settings: Configure Ollama URL and model\n\nDefault: http://localhost:11434\nModel: nomic-embed-text");
  });

  // ─── Helpers ───

  async function getChatGPTToken(): Promise<string | null> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.includes("chatgpt.com")) return null;

    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          // Try multiple sources for the token
          const ctx = (window as any).__remixContext?.state?.loaderData?.["routes/_layout"];
          if (ctx?.user?.accessToken) return ctx.user.accessToken;

          // Fallback: try localStorage
          const token = localStorage.getItem("accessToken");
          if (token) return token;

          return null;
        },
      });
      return result[0]?.result ?? null;
    } catch {
      return null;
    }
  }

  function startProgressPolling() {
    importInterval = window.setInterval(async () => {
      const status = await chrome.runtime.sendMessage({ type: "IMPORT_STATUS" });
      if (status.error) {
        statusEl.textContent = `Error: ${status.error}`;
        stopPolling();
        importBtn.disabled = false;
        return;
      }

      const pct = status.total > 0 ? (status.completed / status.total) * 100 : 0;
      progressFill.style.width = `${pct}%`;
      progressText.textContent = `${status.completed} / ${status.total} conversations (skipped: ${status.skipped})`;

      if (!status.isRunning) {
        stopPolling();
        importBtn.disabled = false;
        statusEl.textContent = `Done! Imported ${status.completed}, skipped ${status.skipped}, failed ${status.failed}`;
        loadStats();
      }
    }, 500);
  }

  function stopPolling() {
    if (importInterval) {
      clearInterval(importInterval);
      importInterval = null;
    }
  }

  async function loadStats() {
    const stats = await chrome.runtime.sendMessage({ type: "GET_STATS" });
    if (stats.error) return;

    statConversations.textContent = String(stats.conversations);
    statMessages.textContent = String(stats.messages);
    statsSection.classList.remove("hidden");
  }

  async function checkOllama() {
    const result = await chrome.runtime.sendMessage({ type: "OLLAMA_CHECK" });
    if (!result.ok) {
      statusEl.textContent = `⚠️ ${result.message}`;
    }
  }

  async function doQuickSearch(query: string) {
    if (!query.trim()) {
      quickResults.innerHTML = "";
      return;
    }

    try {
      const result = await chrome.runtime.sendMessage({ type: "SEARCH", query, topK: 3 });
      if (result.error) throw new Error(result.error);

      quickResults.innerHTML = result.memories
        .map(
          (m: any) => `
        <div class="quick-result" data-conv="${m.conversationId}">
          <div class="title">${escapeHtml(m.summary || "ChatGPT Message")}</div>
          <div class="snippet">${escapeHtml(m.text?.slice(0, 80) || "")}...</div>
          <div class="time">${new Date(m.at).toLocaleDateString()}</div>
        </div>
      `
        )
        .join("");

      quickResults.querySelectorAll(".quick-result").forEach((el) => {
        el.addEventListener("click", () => {
          const convId = (el as HTMLElement).dataset.conv;
          if (convId) {
            chrome.tabs.create({ url: `https://chatgpt.com/c/${convId}` });
          }
        });
      });
    } catch (err) {
      quickResults.innerHTML = `<div class="quick-result"><div class="snippet">Error: ${(err as Error).message}</div></div>`;
    }
  }

  function escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
});
