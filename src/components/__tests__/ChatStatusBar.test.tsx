// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChatStatusBar, LinkGlyph } from '@/components/ChatStatusBar';
import type { SessionSignal } from '@/lib/signals/types';

const signal = (meta: Record<string, unknown>): SessionSignal =>
  ({ meta } as unknown as SessionSignal);

const base = {
  link: { connection: 'connected' as const, delivering: true },
  cacheAnchorMs: null,
  cacheTtlMs: null,
  cacheBusy: false,
};

afterEach(() => { cleanup(); });

describe('LinkGlyph', () => {
  // A coloured wifi icon on its own says "something about the network"; which
  // something is the whole point.
  it('says in words which state it is in', () => {
    const cases = [
      [{ connection: 'connected' as const, delivering: true }, 'live'],
      [{ connection: 'connected' as const, delivering: false }, 'no events'],
      [{ connection: 'reconnecting' as const, delivering: false }, 'reconnecting'],
      [{ connection: 'disconnected' as const, delivering: false }, 'offline'],
    ] as const;
    for (const [state, word] of cases) {
      const { unmount } = render(<LinkGlyph {...state} />);
      // Named subject, then state — otherwise "live" alone is live *what*.
      expect(screen.getByText('daemon')).toBeTruthy();
      expect(screen.getByText(word)).toBeTruthy();
      unmount();
    }
  });

  // The distinction the outage turned on: the socket was up the whole time.
  it('separates "connected" from "connected but this session is not receiving"', () => {
    const { unmount } = render(<LinkGlyph connection="connected" delivering />);
    expect(screen.getByLabelText('connected')).toBeTruthy();
    unmount();

    render(<LinkGlyph connection="connected" delivering={false} />);
    expect(screen.queryByLabelText('connected')).toBeNull();
    expect(screen.getByLabelText('connected, session not receiving')).toBeTruthy();
  });

  it('reports a dropped socket, and a reconnecting one differently', () => {
    const { unmount } = render(<LinkGlyph connection="disconnected" delivering={false} />);
    expect(screen.getByLabelText('disconnected from daemon')).toBeTruthy();
    unmount();

    render(<LinkGlyph connection="reconnecting" delivering={false} />);
    expect(screen.getByLabelText('reconnecting to daemon')).toBeTruthy();
  });

  // Legacy IPC has no daemon; a permanent red "disconnected" would be a lie.
  it('renders nothing when there is no daemon on this page', () => {
    const { container } = render(<LinkGlyph connection={null} delivering={false} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('ChatStatusBar', () => {
  it('shows the turn clock and the thinking burst', () => {
    render(
      <ChatStatusBar
        {...base}
        activitySignal={signal({ status: 'thinking', turnStartedAt: null, lastTurnMs: 12_000, thinkingTokens: 12_400 })}
      />,
    );
    expect(screen.getByLabelText('working — last round').textContent).toContain('12');
    expect(screen.getByLabelText('thinking').textContent).toContain('12.4k');
    expect(screen.getByLabelText('thinking').textContent).toContain('tokens');
  });

  // Both readouts hold the previous round's value, so an idle session still
  // answers "how long did that take, and how much did it think?"
  it('keeps the previous round on screen once the turn ends', () => {
    render(
      <ChatStatusBar
        {...base}
        activitySignal={signal({ status: 'idle', turnStartedAt: null, lastTurnMs: 3_000, lastThinkingTokens: 800 })}
      />,
    );
    expect(screen.getByLabelText('working — last round')).toBeTruthy();
    // Past tense once the burst is over: the number is what it DID think,
    // not what it is thinking.
    const burst = screen.getByLabelText('thought — last burst');
    expect(burst.textContent).toContain('thought');
    expect(burst.textContent).toContain('800 tokens');
  });

  it('omits each readout until it has a number, but still renders the bar', () => {
    render(<ChatStatusBar {...base} />);
    expect(screen.getByTestId('chat-status-bar')).toBeTruthy();
    expect(screen.queryByLabelText(/working/)).toBeNull();
    expect(screen.queryByLabelText(/thinking/)).toBeNull();
  });

  // Pulse marks "this is happening right now" — the frozen previous-round
  // readouts must not claim it.
  it('pulses each glyph only while its own thing is live', () => {
    const { unmount } = render(
      <ChatStatusBar {...base} activitySignal={signal({ status: 'idle', lastTurnMs: 1000 })} />,
    );
    expect(screen.getByLabelText(/^working/i).className).not.toContain('animate-pulse');
    unmount();

    render(
      <ChatStatusBar
        {...base}
        activitySignal={signal({ status: 'thinking', turnStartedAt: Date.now(), thinkingTokens: 900 })}
      />,
    );
    expect(screen.getByLabelText(/^working/i).className).toContain('animate-pulse');
    expect(screen.getByLabelText(/^thinking/i).className).toContain('animate-pulse');
  });

  // Mid-burst the frozen value is the PREVIOUS burst, so showing it would be
  // stale by a whole round.
  it('shows the live thinking total in preference to the frozen one', () => {
    render(
      <ChatStatusBar
        {...base}
        activitySignal={signal({
          status: 'thinking', thinkingTokens: 900, lastThinkingTokens: 12_400, turnStartedAt: Date.now(),
        })}
      />,
    );
    expect(screen.getByText('900 tokens')).toBeTruthy();
    expect(screen.queryByText('12.4k tokens')).toBeNull();
  });

  it('omits the thinking glyph for a turn that never thought', () => {
    render(
      <ChatStatusBar {...base} activitySignal={signal({ status: 'active', turnStartedAt: Date.now() })} />,
    );
    expect(screen.getByLabelText(/^working/i)).toBeTruthy();
    expect(screen.queryByLabelText(/^thinking/i)).toBeNull();
  });

  it('labels each readout, not just its icon', () => {
    render(
      <ChatStatusBar
        {...base}
        activitySignal={signal({ status: 'idle', turnStartedAt: null, lastTurnMs: 3_000, lastThinkingTokens: 800 })}
      />,
    );
    expect(screen.getByText('daemon')).toBeTruthy();
    expect(screen.getByText('live')).toBeTruthy();
    expect(screen.getByText('turn')).toBeTruthy();
    expect(screen.getByText('thought')).toBeTruthy();
  });

  it('marks the turn readout with a clock, not a server glyph', () => {
    // A 14px ServerCog is a smear at this size; the readout is a duration, so
    // the glyph should read as one.
    render(
      <ChatStatusBar
        {...base}
        activitySignal={signal({ status: 'idle', turnStartedAt: null, lastTurnMs: 3_000 })}
      />,
    );
    const turn = screen.getByLabelText(/^working/i);
    expect(turn.querySelector('.lucide-clock')).toBeTruthy();
  });

  it('colours the turn readout apart from the daemon glyph', () => {
    // Both sat on emerald-400, so the bar read as one green run of text.
    render(
      <ChatStatusBar
        {...base}
        activitySignal={signal({ status: 'idle', turnStartedAt: null, lastTurnMs: 3_000 })}
      />,
    );
    const turn = screen.getByLabelText(/^working/i);
    expect(turn.className).toContain('text-sky-400');
    expect(turn.className).not.toContain('emerald');
  });

  it('puts a separator strictly between readouts, never at either end', () => {
    // Four readouts → three dividers.
    const { unmount } = render(
      <ChatStatusBar
        {...base}
        activitySignal={signal({ status: 'idle', lastTurnMs: 3_000, lastThinkingTokens: 800 })}
        cacheAnchorMs={Date.now() - 60_000}
        cacheTtlMs={5 * 60_000}
      />,
    );
    expect(screen.getAllByTestId('status-divider')).toHaveLength(3);
    unmount();

    // One readout → no divider. Hard-coded separators would leave a stray
    // hairline hanging off a half-empty bar.
    render(<ChatStatusBar {...base} />);
    expect(screen.queryAllByTestId('status-divider')).toHaveLength(0);
  });

  // The bar drops the link glyph entirely on a page with no daemon, so the
  // divider count has to follow what actually rendered.
  it('counts no divider for a readout that is not there', () => {
    render(
      <ChatStatusBar
        {...base}
        link={{ connection: null, delivering: false }}
        activitySignal={signal({ status: 'idle', lastTurnMs: 3_000 })}
      />,
    );
    expect(screen.queryByText('live')).toBeNull();
    expect(screen.queryAllByTestId('status-divider')).toHaveLength(0);
  });

  it('carries the cache countdown', () => {
    render(
      <ChatStatusBar
        {...base}
        cacheAnchorMs={Date.now() - 60_000}
        cacheTtlMs={5 * 60_000}
        cacheBusy={false}
      />,
    );
    expect(screen.getByText(/cache .* left \(5m\)/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The session's name, and renaming it
// ---------------------------------------------------------------------------

// The CLI names every session itself and a rename overrides that name; both
// live in the transcript, and this bar is where the name is visible while you
// read. The pencil sends the CLI's own `rename_session` control request, so
// what the bar shows and what the CLI thinks the session is called are the
// same fact.
describe('ChatStatusBar — session name', () => {
  const named = { ...base, title: 'Rate-limit spike', canRename: true, onRename: async () => true };

  it('shows the session name, labelled', () => {
    render(<ChatStatusBar {...named} />);
    expect(screen.getByTestId('session-title').textContent).toBe('Name: Rate-limit spike');
  });

  // The name is the one thing on this bar you read rather than glance at, so
  // it sits a step above the 10px the readouts share. jsdom cannot measure
  // type, so this pins the classes that set it.
  it('sets the name a size larger than the readouts', () => {
    render(<ChatStatusBar {...named} />);
    expect(screen.getByTestId('session-title').className).toContain('text-sm');
  });

  // The bar is mono because its readouts are numbers that must not jitter as
  // they count. A name is prose — it belongs in the app's own typeface, and
  // has to say so explicitly to escape the mono the bar sets on the row.
  it('sets the name in the app font, not the readouts’ mono', () => {
    render(<ChatStatusBar {...named} />);
    expect(screen.getByTestId('session-title').className).toContain('font-sans');
  });

  // Untitled is the common case, not an edge one: the CLI only titles a FRESH
  // conversation, so every resumed session and every pre-2.1.268 transcript
  // arrives here with no name at all. Naming one is the whole point of the
  // pencil, so the affordance cannot be hidden behind having a name already.
  it('says a session is untitled rather than showing nothing', () => {
    render(<ChatStatusBar {...named} title={null} />);
    expect(screen.getByTestId('session-title').textContent).toBe('Name: Untitled');
    expect(screen.getByRole('button', { name: /rename session/i })).toBeTruthy();
  });

  it('opens the rename field seeded with the current name', () => {
    render(<ChatStatusBar {...named} />);
    fireEvent.click(screen.getByRole('button', { name: /rename session/i }));
    expect((screen.getByLabelText(/session name/i) as HTMLInputElement).value).toBe('Rate-limit spike');
  });

  it('sends the new name on submit', async () => {
    const renames: string[] = [];
    render(<ChatStatusBar {...named} onRename={async (t: string) => { renames.push(t); return true; }} />);
    fireEvent.click(screen.getByRole('button', { name: /rename session/i }));
    fireEvent.change(screen.getByLabelText(/session name/i), { target: { value: 'Cache TTL work' } });
    fireEvent.submit(screen.getByTestId('rename-form'));
    await waitFor(() => expect(renames).toEqual(['Cache TTL work']));
  });

  // The CLI reads an empty custom title as "clear the rename". Nothing about
  // pressing Save on an empty field means that.
  it('refuses to submit a blank name', () => {
    const renames: string[] = [];
    render(<ChatStatusBar {...named} onRename={async (t: string) => { renames.push(t); return true; }} />);
    fireEvent.click(screen.getByRole('button', { name: /rename session/i }));
    fireEvent.change(screen.getByLabelText(/session name/i), { target: { value: '   ' } });
    fireEvent.submit(screen.getByTestId('rename-form'));
    expect(renames).toEqual([]);
  });

  // A rename goes out as a control request, which needs a live engine. With
  // no session running there is nothing to send it to — better to say so on
  // the button than to accept the rename and drop it.
  it('disables the pencil when the session cannot take a rename', () => {
    render(<ChatStatusBar {...named} canRename={false} />);
    const pencil = screen.getByRole('button', { name: /rename session/i }) as HTMLButtonElement;
    expect(pencil.disabled).toBe(true);
    fireEvent.click(pencil);
    expect(screen.queryByLabelText(/session name/i)).toBeNull();
  });

  // Layout: the name anchors the left edge, the readouts group at the right.
  // jsdom cannot see alignment, so this asserts the two things it CAN see —
  // document order, and that the readouts carry the margin that pushes them
  // over. A visual check belongs in a packaged build.
  it('puts the name first and groups the readouts to the right of it', () => {
    render(<ChatStatusBar {...named} activitySignal={signal({ status: 'idle', lastTurnMs: 3_000 })} />);
    const title = screen.getByTestId('session-title');
    const items = screen.getByTestId('chat-status-items');
    expect(title.compareDocumentPosition(items) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(items.className).toContain('ml-auto');
  });

  // The pencil is disabled without a live session, so this is the narrow
  // window where one dies between opening the field and pressing Save. The
  // rename is gone either way; saying so beats closing as if it worked.
  it('keeps the field open and says so when the rename does not land', async () => {
    render(<ChatStatusBar {...named} onRename={async () => false} />);
    fireEvent.click(screen.getByRole('button', { name: /rename session/i }));
    fireEvent.change(screen.getByLabelText(/session name/i), { target: { value: 'Cache TTL work' } });
    fireEvent.submit(screen.getByTestId('rename-form'));
    expect(await screen.findByText(/didn’t reach the session/i)).toBeTruthy();
    expect(screen.getByLabelText(/session name/i)).toBeTruthy();
  });
});
