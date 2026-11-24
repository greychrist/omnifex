// A CLI that lost its sign-in never picks up a new one; each tab restarts itself on this event.
const EVENT = 'omnifex:account-signed-in';

export function announceAccountSignedIn(configDir: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: configDir }));
}

export function onAccountSignedIn(listener: (configDir: string) => void): () => void {
  const handler = (e: Event) => { listener((e as CustomEvent<string>).detail); };
  window.addEventListener(EVENT, handler);
  return () => { window.removeEventListener(EVENT, handler); };
}
