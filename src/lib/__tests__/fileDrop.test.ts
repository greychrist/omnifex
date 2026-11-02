import { describe, it, expect } from 'vitest';
import { appendMention, mentionFor, planDrop } from '../fileDrop';

const f = (name: string, type = '') => ({ name, type });

describe('planDrop', () => {
  it('points at the real file when the app supplied its path', () => {
    const pdf = f('report.pdf', 'application/pdf');
    expect(planDrop([pdf], ['/Users/g/Docs/report.pdf'])).toEqual([
      { kind: 'mention', path: '/Users/g/Docs/report.pdf' },
    ]);
  });

  it('keeps images inline, as a paste would, even with a path', () => {
    const png = f('shot.png', 'image/png');
    expect(planDrop([png], ['/tmp/shot.png'])).toEqual([{ kind: 'image', file: png }]);
  });

  it('mentions a path with no file behind it, such as a dropped folder', () => {
    expect(planDrop([], ['/Users/g/project/src'])).toEqual([
      { kind: 'mention', path: '/Users/g/project/src' },
    ]);
  });

  it('copies a non-image that has no path (browser drag, iPad)', () => {
    const txt = f('notes.txt', 'text/plain');
    expect(planDrop([txt], [])).toEqual([{ kind: 'copy', file: txt }]);
  });

  it('keeps an image inline without a path too', () => {
    const jpg = f('a.jpg', 'image/jpeg');
    expect(planDrop([jpg], [])).toEqual([{ kind: 'image', file: jpg }]);
  });

  it('matches files to paths by name, one each', () => {
    const a = f('same.txt');
    const b = f('same.txt');
    expect(planDrop([a, b], ['/x/same.txt', '/y/same.txt'])).toEqual([
      { kind: 'mention', path: '/x/same.txt' },
      { kind: 'mention', path: '/y/same.txt' },
    ]);
  });

  it('recognises an image by extension when the type is blank', () => {
    const png = f('x.PNG');
    expect(planDrop([png], ['/a/x.PNG'])).toEqual([{ kind: 'image', file: png }]);
  });
});

describe('mentionFor / appendMention', () => {
  it('quotes a path with spaces', () => {
    expect(mentionFor('/a b/c.txt')).toBe('@"/a b/c.txt"');
    expect(mentionFor('/a/c.txt')).toBe('@/a/c.txt');
  });

  it('appends with one separating space and a trailing space', () => {
    expect(appendMention('', '/a')).toBe('@/a ');
    expect(appendMention('look at', '/a')).toBe('look at @/a ');
    expect(appendMention('look at ', '/a')).toBe('look at @/a ');
  });

  it('does not add a mention the prompt already has', () => {
    expect(appendMention('see @/a ', '/a')).toBe('see @/a ');
  });
});
