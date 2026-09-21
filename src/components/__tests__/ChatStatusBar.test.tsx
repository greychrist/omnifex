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
describe('ChatStatusBar — session controls', () => {
  it('seats the controls with the readouts, hairline between, and none when there are no readouts', () => {
    const { unmount } = render(
      <ChatStatusBar
        {...base}
        controls={<span data-testid="controls">model Opus</span>}
        activitySignal={signal({ status: 'idle', lastTurnMs: 3_000 })}
      />,
    );
    expect(screen.getByTestId('controls')).toBeTruthy();
    // link glyph + turn readout + controls → controls | link | turn = 2 dividers
    expect(screen.getAllByTestId('status-divider')).toHaveLength(2);
    // Controls come first: what you can change, then what is happening.
    // Each readout is wrapped with the divider that introduces it, so the
    // first child is that pair rather than the controls node itself.
    const group = screen.getByTestId('chat-status-items');
    expect(group.firstElementChild?.contains(screen.getByTestId('controls'))).toBe(true);
    unmount();

    render(<ChatStatusBar {...base} link={{ connection: null, delivering: false }} controls={<span data-testid="controls" />} />);
    expect(screen.queryAllByTestId('status-divider')).toHaveLength(0);
  });
});

describe('ChatStatusBar — session name', () => {
  const named = { ...base, title: 'Rate-limit spike', canRename: true, onRename: async () => true };

  it('shows the session name, labelled', () => {
    render(<ChatStatusBar {...named} />);
    expect(screen.getByTestId('session-title').textContent).toBe('nameRate-limit spike');
  });

  // The name reads as one more readout on this bar, not as a heading over it:
  // same `label value` shape as `turn 12s` and `cache 3m left`, same icon
  // size, and the row's own 10px mono rather than a size of its own. It used
  // to be `text-sm font-sans` on the theory that a name is prose — which made
  // it the only thing on the bar with its own typeface AND its own size.
  it('inherits the row type rather than setting its own', () => {
    render(<ChatStatusBar {...named} />);
    const el = screen.getByTestId('session-title');
    expect(el.className).not.toContain('text-sm');
    expect(el.className).not.toContain('font-sans');
  });

  // Deliberately no glyph, unlike every other readout on this row. A letter
  // icon was tried here and rejected: the others' glyphs stand in for a
  // quantity you scan for, while the name is already the longest text on the
  // bar and a mark in front of it only crowded the left edge.
  it('carries no icon of its own', () => {
    const { container } = render(<ChatStatusBar {...named} />);
    expect(container.querySelector('[data-testid="session-title"] svg')).toBeNull();
  });

  // Untitled is the common case, not an edge one: the CLI only titles a FRESH
  // conversation, so every resumed session and every pre-2.1.268 transcript
  // arrives here with no name at all. Naming one is the whole point of the
  // pencil, so the affordance cannot be hidden behind having a name already.
  it('says a session is untitled rather than showing nothing', () => {
    render(<ChatStatusBar {...named} title={null} />);
    expect(screen.getByTestId('session-title').textContent).toBe('nameUntitled');
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

  // Naming is on demand: Suggest asks the CLI for a name and puts it in the
  // field. Nothing is written until Save — the same rename path as typing.
  it('offers Suggest, which fills the field with the CLI\'s proposal and writes nothing', async () => {
    const renames: string[] = [];
    let asked = 0;
    render(
      <ChatStatusBar
        {...named}
        title={null}
        onRename={async (t: string) => { renames.push(t); return true; }}
        onSuggest={async () => { asked += 1; return 'Cache TTL work'; }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /rename session/i }));
    fireEvent.click(screen.getByRole('button', { name: /suggest/i }));
    await waitFor(() => expect((screen.getByLabelText(/session name/i) as HTMLInputElement).value).toBe('Cache TTL work'));
    expect(asked).toBe(1);
    expect(renames).toEqual([]);
    fireEvent.submit(screen.getByTestId('rename-form'));
    await waitFor(() => expect(renames).toEqual(['Cache TTL work']));
  });

  it('says so when the CLI had no suggestion, and leaves the field alone', async () => {
    render(<ChatStatusBar {...named} onSuggest={async () => null} />);
    fireEvent.click(screen.getByRole('button', { name: /rename session/i }));
    fireEvent.click(screen.getByRole('button', { name: /suggest/i }));
    await waitFor(() => expect(screen.getByText(/no suggestion/i)).toBeTruthy());
    expect((screen.getByLabelText(/session name/i) as HTMLInputElement).value).toBe('Rate-limit spike');
  });

  it('has no Suggest button when there is nothing to suggest from', () => {
    render(<ChatStatusBar {...named} />);
    fireEvent.click(screen.getByRole('button', { name: /rename session/i }));
    expect(screen.queryByRole('button', { name: /suggest/i })).toBeNull();
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

  // The bar is a field set into the session header, the way a chat composer
  // sits in its own bar: the frame carries the header's material and the bar
  // floats inside it on its own surface, inset evenly on all four sides.
  //
  // The `border-b` assertion is the load-bearing one: styles.css declares an
  // unlayered `* { border-color: var(--color-border) }` that outranks every
  // Tailwind border-color utility, so any border here returns at FULL strength
  // instead of the widget ring. That is why the outline is a `shadow` ring and
  // why `border-0` sits beside it — the same shape the account, branch and
  // session widgets use. jsdom cannot see any of it, so only the decisions are
  // pinned, not the tuning.
  it('floats on its own surface inside a header-coloured frame', () => {
    render(<ChatStatusBar {...named} activitySignal={signal({ status: 'idle' })} />);
    const bar = screen.getByTestId('chat-status-bar');
    expect(bar.className).toContain('bg-background/60');
    expect(bar.className).toMatch(/\brounded-md\b/);
    expect(bar.className).not.toContain('border-b');

    const frame = screen.getByTestId('chat-status-frame');
    expect(frame.className).toContain('bg-muted');
    expect(frame.contains(bar)).toBe(true);
  });

  // Deliberately uneven: the side margins are the only ones that read as
  // margins, since the bar spans the header's full width.
  it('insets twice as far horizontally as vertically', () => {
    render(<ChatStatusBar {...named} activitySignal={signal({ status: 'idle' })} />);
    const frame = screen.getByTestId('chat-status-frame');
    expect(frame.className).toMatch(/\bpx-\[8px\]/);
    expect(frame.className).toMatch(/\bpy-\[4px\]/);
    // No uniform `p-` shorthand left to override the pair.
    expect(frame.className).not.toMatch(/\bp-\[/);
  });

  // Same ring as the account / branch / session widgets it now sits under, so
  // the header reads as one family of controls rather than a bar plus a strip.
  it('wears the widget ring, not a border', () => {
    render(<ChatStatusBar {...named} activitySignal={signal({ status: 'idle' })} />);
    const bar = screen.getByTestId('chat-status-bar');
    expect(bar.className).toContain('border-0');
    expect(bar.className).toContain(
      'shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_30%,transparent)]',
    );
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

// The bar has outgrown one line: three pickers, the daemon glyph, the turn
// clock, the thinking burst and the cache countdown do not fit beside a name
// in a narrow window. It wraps rather than squeezing, and the name is the one
// thing that never gives up room — it is the only readout that cannot be
// reconstructed from a glyph and a number.
//
// jsdom has no layout, so these pin the flex decisions that produce the
// behaviour. The visual check belongs in a packaged build.
describe('ChatStatusBar — wrapping', () => {
  const named = { ...base, title: 'Rate-limit spike', canRename: true, onRename: async () => true };

  it('wraps onto another line instead of overflowing one', () => {
    render(<ChatStatusBar {...named} activitySignal={signal({ status: 'idle', lastTurnMs: 3_000 })} />);
    const bar = screen.getByTestId('chat-status-bar');
    expect(bar.className).toContain('flex-wrap');
    // A row gap, or wrapped lines sit flush against each other.
    expect(bar.className).toMatch(/\bgap-y-/);
  });

  it('keeps the readouts wrapping among themselves, not just as one block', () => {
    render(<ChatStatusBar {...named} activitySignal={signal({ status: 'idle', lastTurnMs: 3_000 })} />);
    const items = screen.getByTestId('chat-status-items');
    expect(items.className).toContain('flex-wrap');
    expect(items.className).toMatch(/\bgap-y-/);
    // Still right-grouped: wrapping changed where they sit, not which edge.
    expect(items.className).toContain('ml-auto');
  });

  // The name is never the thing that gives: no `truncate` anywhere under it,
  // and no `min-w-0` letting the flex line shrink it below its content.
  it('never truncates the session name to make room', () => {
    render(
      <ChatStatusBar
        {...named}
        title="A very long session name that would have been clipped at the old width"
        activitySignal={signal({ status: 'idle', lastTurnMs: 3_000 })}
      />,
    );
    const title = screen.getByTestId('session-title');
    const marked = [title, ...Array.from(title.querySelectorAll('*'))] as HTMLElement[];
    for (const el of marked) {
      expect(el.className).not.toContain('truncate');
      expect(el.className).not.toMatch(/\bmin-w-0\b/);
    }
    // And the whole name is in the DOM, not an ellipsis of it.
    expect(title.textContent).toContain('clipped at the old width');
  });
});
