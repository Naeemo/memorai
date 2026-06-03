// Content script: reads ChatGPT page token for background script

// This script is injected into chatgpt.com pages
// It doesn't do anything directly — the background script calls
// chrome.scripting.executeScript to read from page context

console.debug("[Memorai Importer] Content script loaded");
