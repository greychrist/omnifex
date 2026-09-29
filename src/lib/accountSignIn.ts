/**
 * "This account was just signed in" — announced by the account popover's
 * sign-in flow, heard by every open session tab.
 *
 * A CLI process that lost its sign-in never picks up a new one, so each tab
 * whose process gave up restarts itself when its account is signed in again.
 * Every tab is mounted in the one renderer, so a window event reaches them
 * all; sign-in is desktop-only, so there is no second renderer to miss.
 */
const EVENT = 'omnifex:account-signed-in';

export function announceAccountSignedIn(configDir: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: configDir }));
}

export function onAccountSignedIn(listener: (configDir: string) => void): () => void {
  const handler = (e: Event) => { listener((e as CustomEvent<string>).detail); };
  window.addEventListener(EVENT, handler);
  return () => { window.removeEventListener(EVENT, handler); };
}
