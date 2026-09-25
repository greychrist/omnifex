// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

// AgentSession re-renders on every stream event, and every open tab stays
// mounted. An open side chat must not re-parse its answers each time.
const markdownRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => {
    markdownRenders.count++;
    return <span>{children}</span>;
  },
}));

import { SideChatPanel } from '../SideChatPanel';
import type { SideChat } from '@/lib/sideChat';

afterEach(cleanup);

describe('SideChatPanel render cost', () => {
  it('does not re-render its answers when the parent re-renders with the same props', () => {
    const sideChat: SideChat = { exchanges: [{ id: 'sq-1', question: 'Q?', askedAt: 't', status: 'answered', answer: 'A.' }] };
    const props = { sideChat, askError: null, onAsk: vi.fn(), onClose: vi.fn(), focusRequest: 0 };
    const { rerender } = render(<SideChatPanel {...props} />);
    const afterMount = markdownRenders.count;
    rerender(<SideChatPanel {...props} />);
    rerender(<SideChatPanel {...props} />);
    expect(markdownRenders.count).toBe(afterMount);
  });
});
