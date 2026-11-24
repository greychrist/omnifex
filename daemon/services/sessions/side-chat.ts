// The CLI is stateless about side questions, so the thread lives here and each ask resends the last 20 exchanges as `history`.
// A generation counter keeps a reply that lands after close() out of the new thread.

import { EMPTY_SIDE_CHAT, type SideChat, type SideChatExchange } from '../../../src/lib/sideChat';
import type { SendToRenderer } from './types';

export const SIDE_CHAT_HISTORY_LIMIT = 20;

export interface SideChatAsk {
  exchange: SideChatExchange;
  generation: number;
  history: { question: string; response: string }[];
}

export interface SideChatStore {
  ask(question: string): SideChatAsk;
  settle(id: string, generation: number, response: string | null): boolean;
  fail(id: string, generation: number, message: string): boolean;
  close(): void;
  snapshot(): SideChat;
}

export function createSideChatStore(now: () => Date = () => new Date()): SideChatStore {
  let exchanges: SideChatExchange[] = [];
  let generation = 0;
  let seq = 0;

  function pendingExchange(id: string, gen: number): SideChatExchange | null {
    if (gen !== generation) return null;
    const ex = exchanges.find((e) => e.id === id);
    return ex?.status === 'pending' ? ex : null;
  }

  return {
    ask(question) {
      const q = question.trim();
      if (!q) throw new Error('Question is blank');
      if (exchanges.some((e) => e.status === 'pending')) throw new Error('A side question is already pending');
      const history = exchanges
        .filter((e) => e.status === 'answered')
        .slice(-SIDE_CHAT_HISTORY_LIMIT)
        .map((e) => ({ question: e.question, response: e.answer ?? '' }));
      const exchange: SideChatExchange = {
        id: `sq-${++seq}`,
        question: q,
        askedAt: now().toISOString(),
        status: 'pending',
      };
      exchanges = [...exchanges, exchange];
      return { exchange: { ...exchange }, generation, history };
    },

    settle(id, gen, response) {
      const ex = pendingExchange(id, gen);
      if (!ex) return false;
      if (response === null) ex.status = 'no-answer';
      else Object.assign(ex, { status: 'answered', answer: response });
      ex.answeredAt = now().toISOString();
      return true;
    },

    fail(id, gen, message) {
      const ex = pendingExchange(id, gen);
      if (!ex) return false;
      Object.assign(ex, { status: 'failed', error: message, answeredAt: now().toISOString() });
      return true;
    },

    close() {
      exchanges = [];
      generation++;
    },

    snapshot() {
      return { exchanges: exchanges.map((e) => ({ ...e })) };
    },
  };
}

export function endSideChat(store: SideChatStore, tabId: string, sendToRenderer: SendToRenderer | null): void {
  store.close();
  sendToRenderer?.(`session-side-chat:${tabId}`, EMPTY_SIDE_CHAT);
}
