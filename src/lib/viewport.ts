/**
 * How the app root fills the window.
 *
 * `h-dvh` (100dvh), never `h-screen` (100vh). On iPad Safari `100vh` is the
 * largest viewport — the height with the browser toolbar retracted — but the
 * page is shown with the toolbar present, and <html> is `overflow: hidden`,
 * so Safari never retracts it. The bottom of a 100vh root (the composer) sat
 * under the toolbar with no way to scroll it into view. The dynamic viewport
 * unit is the visible height and follows the toolbar. In Electron the two
 * units are equal, so the desktop app is unchanged.
 *
 * The keyboard is a separate problem, handled by `useKeyboardInset`: Safari
 * does not shrink either unit for the software keyboard.
 */
export const APP_ROOT_HEIGHT = 'h-dvh';
