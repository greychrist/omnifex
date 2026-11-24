// Sessions module — side chat
//
// The thread behind the CLI's `/btw`, driven here by the `side_question`
// control request. The CLI is stateless about it: each ask forks the current
// context, answers once with every tool denied, writes nothing to the
// transcript, and forgets. So the thread lives here, on the session handle,
// and each ask sends the earlier answered exchanges back as `history` — the
// last 20, as the TUI does.
//
// One question is pending at a time; that keeps the history each ask sends
// unambiguous. `close()` discards the thread and bumps a generation counter,
// so a reply that arrives after a close (or a close-and-ask-again) can never
// land in the new thread.

import { EMPTY_SIDE_CHAT, type SideChat, type SideChatExchange } from '../../../src/lib/sideChat';
import type { SendToRenderer } from './types';

export const SIDE_CHAT_HISTORY_LIMIT = 20;

export interface SideChatAsk {
  exchange: SideChatExchange;
  generation: number;
  history: { question: string; response: string }[];
}

export interface SideChatStore {
  /** Append a pending exchange. Throws on a blank question or one already pending. */
  ask(question: string): SideChatAsk;
  /** A string answers; `null` is the CLI's "no answer". False if the reply is stale. */
  settle(id: string, generation: number, response: string | null): boolean;
  /** False if the failure is stale. */
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

/**
 * End a session's side chat because its engine is going: discard the thread
 * (bumping the generation, so a question still in flight cannot refill it
 * when its rejection lands) and tell clients it is empty. Called on engine
 * exit, on stop(), and when a fresh start replaces a live session.
 */
export function endSideChat(store: SideChatStore, tabId: string, sendToRenderer: SendToRenderer | null): void {
  store.close();
  sendToRenderer?.(`session-side-chat:${tabId}`, EMPTY_SIDE_CHAT);
}
