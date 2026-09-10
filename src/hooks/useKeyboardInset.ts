/**
 * Keep the composer above the software keyboard.
 *
 * Mounted once, at the app root. Writes `--omnifex-keyboard-inset` on <html>
 * from the visual viewport; the composer pads its bottom by that variable.
 * Nothing to do where there is no visual viewport API (Electron) — the
 * variable stays unset and the `var(…, 0px)` fallback applies.
 */
import { useEffect } from 'react';

import { keyboardInset, KEYBOARD_INSET_VAR } from '@/lib/keyboardInset';

export function useKeyboardInset(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      const inset = keyboardInset(window.innerHeight, vv.height, vv.offsetTop);
      root.style.setProperty(KEYBOARD_INSET_VAR, `${inset}px`);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      root.style.removeProperty(KEYBOARD_INSET_VAR);
    };
  }, []);
}
