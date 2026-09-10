/**
 * The word beside each title-bar button's icon.
 *
 * Hidden below the `lg` viewport (1024px) so a narrow window keeps every
 * button as an icon rather than wrapping or clipping the group. Each button
 * keeps a `title` / `aria-label` so the icon alone still has a name. Shared
 * by CustomTitlebar and the popovers it embeds (Daemon, Sessions) so the
 * breakpoint cannot drift between them.
 */
export const TITLEBAR_LABEL = 'hidden lg:inline';
