/** Shared types for the ChatGPT import pipeline. */

export interface ChatGPTMessage {
  id: string;
  author: { role: "user" | "assistant" | "system" };
  content: { content_type: "text"; parts: string[] };
  create_time: number;
}

export interface ChatGPTConversationMeta {
  id: string;
  title: string;
  create_time?: number;
  update_time?: number;
}

export interface ChatGPTConversation extends ChatGPTConversationMeta {
  mapping: Record<
    string,
    { message?: ChatGPTMessage; parent?: string; children: string[] }
  >;
}

export interface ImportProgress {
  total: number;
  completed: number;
  skipped: number;
  failed: number;
  isRunning: boolean;
  error?: string;
}

export interface ImportOptions {
  /** Max conversations to import (useful for testing). */
  maxConversations?: number;
  /** Skip messages older than this timestamp (Unix ms). */
  since?: number;
  /** AbortSignal to cancel an in-flight import. */
  signal?: AbortSignal;
}
