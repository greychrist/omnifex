import { describe, it, expect } from 'vitest';
import type { ClaudeStreamMessage } from '@/types/claudeStream';
import { filterDisplayableMessages } from '../messageFilters';

const userImage = (): ClaudeStreamMessage =>
  ({
    type: 'user',
    message: {
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
        },
      ],
    },
  } as unknown as ClaudeStreamMessage);

const userTextAndImage = (): ClaudeStreamMessage =>
  ({
    type: 'user',
    message: {
      content: [
        { type: 'text', text: 'look at this' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
        },
      ],
    },
  } as unknown as ClaudeStreamMessage);

const userText = (text: string): ClaudeStreamMessage =>
  ({ type: 'user', message: { content: [{ type: 'text', text }] } } as unknown as ClaudeStreamMessage);

describe('filterDisplayableMessages', () => {
  it('keeps user messages with text only', () => {
    const out = filterDisplayableMessages([userText('hello')]);
    expect(out).toHaveLength(1);
  });

  it('keeps user messages with text + image', () => {
    const out = filterDisplayableMessages([userTextAndImage()]);
    expect(out).toHaveLength(1);
  });

  it('keeps user messages that contain only an image', () => {
    const out = filterDisplayableMessages([userImage()]);
    expect(out).toHaveLength(1);
  });
});
