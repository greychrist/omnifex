/** The CLI's `/btw`: answered from the conversation, no tools, never written to the transcript. */

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

/** `/btw <q>` → `q`; bare `/btw` → `''`; anything else → `null`. */
export function parseBtw(prompt: string): string | null {
  const m = BTW.exec(prompt.trim());
  return m ? (m[1] ?? '').trim() : null;
}
