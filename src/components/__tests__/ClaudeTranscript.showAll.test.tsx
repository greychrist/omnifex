// @vitest-environment jsdom
//
// The "All" chat format: Verbose, plus every kind set to "Never" in
// Appearance settings — for the transcript filter AND for the rows, which
// read the config from context to drop never-shown blocks.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { JsonlNode } from '@/types/jsonl';
import { createDefaultConfig, resolveKind } from '@/lib/messageRenderingConfig';
import {
  MessageRenderingPreviewProvider,
  useMessageRenderingConfig,
} from '@/contexts/MessageRenderingContext';

vi.mock('@/contexts/AutoScrollContext', () => ({
  useAutoScroll: () => ({ followPx: 200 }),
}));
vi.mock('@/contexts/SessionGaugesContext', () => ({
  useSessionGauges: () => ({
    contextTimelineEnabled: false,
    setContextTimelineEnabled: () => {},
    contextJump: { thresholdTokens: 50_000 },
    contextPressure: { enabled: true, mode: 'tokens', value: 250_000 },
  }),
}));
// Each row reports the visibility it would resolve for the never-shown kind.
vi.mock('@/components/StreamMessage', () => ({
  StreamMessage: () => {
    const { config } = useMessageRenderingConfig();
    return <div data-row data-visibility={resolveKind(config, 'system.local_command').visibility} />;
  },
}));
vi.mock('@/components/InflightAssistantBubble', () => ({
  InflightAssistantBubble: () => null,
}));

import { ClaudeTranscript } from '@/components/claude/ClaudeTranscript';
import { SessionViewToggle, type ViewMode } from '@/components/SessionViewToggle';
import { TooltipProvider } from '@/components/ui/tooltip-modern';

afterEach(() => { cleanup(); });

const prompt = {
  kind: 'user', userKind: 'prompt', sessionId: 's', receivedAt: '',
  raw: { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
} as unknown as JsonlNode;
const localCommand = {
  kind: 'system', subtype: 'local_command', sessionId: 's', receivedAt: '',
  raw: { type: 'system', subtype: 'local_command', content: '<local-command-stdout>hi</local-command-stdout>' },
} as unknown as JsonlNode;

function renderTranscript(viewMode: ViewMode) {
  const config = createDefaultConfig();
  config.kinds['system.local_command'] = { visibility: 'never' };
  return render(
    <MessageRenderingPreviewProvider config={config}>
      <TooltipProvider>
        <ClaudeTranscript
          messages={[prompt, localCommand]}
          viewMode={viewMode}
          accountType={undefined}
          onResend={() => {}}
          waitingForPermission={false}
          outstandingWork={false}
          hasInflightAssistant={false}
          currentActivity="Thinking"
          totalTokens={0}
          contextLimit={200_000}
          error={null}
          tabId="tab-1"
          messagesEndRef={React.createRef<HTMLDivElement>()}
          isNearBottomRef={{ current: true }}
        />
      </TooltipProvider>
    </MessageRenderingPreviewProvider>,
  );
}

describe('ClaudeTranscript — "All" chat format', () => {
  it('drops a never-shown message in Verbose', () => {
    const { container } = renderTranscript('verbose');
    const rows = container.querySelectorAll('[data-row]');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute('data-visibility', 'never');
  });

  it('keeps it in All, and the rows resolve it as shown', () => {
    const { container } = renderTranscript('all');
    const rows = container.querySelectorAll('[data-row]');
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toHaveAttribute('data-visibility', 'verbose');
  });
});

describe('SessionViewToggle', () => {
  it('offers All alongside Compact and Verbose', () => {
    const onChange = vi.fn();
    render(<SessionViewToggle mode="compact" onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Compact' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verbose' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(onChange).toHaveBeenCalledWith('all');
  });
});

describe('SessionViewToggle — Modern', () => {
  it('offers Modern as a fourth format', () => {
    const onChange = vi.fn();
    render(<SessionViewToggle mode="compact" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Modern' }));
    expect(onChange).toHaveBeenCalledWith('modern');
  });
});
