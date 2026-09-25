/**
 * The side chat's shape, shared by main (which owns the thread) and the
 * renderer (which mirrors it). A side chat is the CLI's `/btw`: questions
 * answered from the conversation so far, with no tools, never written to the
 * transcript. See docs/superpowers/specs/2026-09-25-side-chat-design.md.
 */

export type SideChatStatus = 'pending' | 'answered' | 'no-answer' | 'failed';

export interface SideChatExchange {
  id: string;
  question: string;
  /** ISO timestamp. */
  askedAt: string;
  status: SideChatStatus;
  answer?: string;
  error?: string;
  /** ISO timestamp. */
  answeredAt?: string;
}

export interface SideChat {
  exchanges: SideChatExchange[];
}

export const EMPTY_SIDE_CHAT: SideChat = { exchanges: [] };

export type SideChatAskResult = { ok: true } | { ok: false; error: string };

const BTW = /^\/btw(?:\s+([\s\S]*))?$/;

/**
 * `/btw <q>` → `q`; a bare `/btw` → `''` (open the panel, ask nothing);
 * anything else → `null`, meaning an ordinary prompt.
 */
export function parseBtw(prompt: string): string | null {
  const m = BTW.exec(prompt.trim());
  return m ? (m[1] ?? '').trim() : null;
}
