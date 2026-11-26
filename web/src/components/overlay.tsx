import { useEffect } from 'react';

/**
 * The same breakpoint the stylesheet uses (`chat.css`) and the store reads at boot.
 * On a phone the sidebar and details are overlays covering the chat, so both need a
 * keyboard way out; on a desktop they are inline columns and Escape must do nothing
 * to them (a panel that vanishes when you press Escape in a text field would be worse
 * than the bug this fixes).
 */
const NARROW = '(max-width: 767px)';

export const isNarrow = () => {
  try {
    return typeof window !== 'undefined' && window.matchMedia(NARROW).matches;
  } catch {
    return false;
  }
};

/**
 * A dialog, popover or full-screen layer already on screen owns Escape; the overlay
 * beneath it must not act. `.menu` covers the conversation list too (it is
 * `menu menu--list`), and `.viewer` / `.app-settings` are the full-screen layers.
 */
const OWNED_BY_LOWER = '.modal-root, .menu, .viewer, .app-settings';

/**
 * Escape closes a phone overlay and puts focus back where the person came from.
 *
 * Two pieces, because both are needed for this to be usable without a mouse:
 *  - the key handler: close on Escape, but only when this overlay is the one on top
 *    (`isTopmost`), so with both panels open you get one close per press, and it is
 *    the sidebar (z-index 30) rather than the details sheet (20) underneath it;
 *  - the focus return: the panel's own close button unmounts with the panel, which
 *    drops focus onto `<body>` and leaves a keyboard user at the top of the document.
 *    Focus goes to the control that reopens the panel instead.
 *
 * `ponytail:` one handler per overlay rather than a shared stack. Two overlays is the
 * whole set; a stack would be infrastructure for a third one that does not exist.
 */
export function useOverlayDismiss(
  active: boolean,
  onClose: () => void,
  focusSelector: string,
  /** False when a higher overlay is also open, so this one stays put. */
  isTopmost: () => boolean = () => true,
) {
  useEffect(() => {
    // Checked per keypress, not captured at mount: the panel can be opened on a
    // desktop window that was then narrowed, and the reverse.
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (!isNarrow()) return;
      if (document.querySelector(OWNED_BY_LOWER)) return;
      if (!isTopmost()) return;
      e.preventDefault();
      onClose();
      // The reopen control is rendered by the parent on the next frame.
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(focusSelector);
        if (el && el.offsetParent !== null) el.focus();
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onClose, focusSelector, isTopmost]);
}

/**
 * Return focus to a control that only exists while `open` is false, after the panel
 * closes and its own close button unmounts. Narrow screens only, for the same reason
 * as above: on a desktop the button the person pressed is not going anywhere.
 */
export function useReturnFocusOnUnmount(open: boolean, focusSelector: string) {
  useEffect(() => {
    if (!open || !isNarrow()) return;
    return () => {
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(focusSelector);
        // Not `document.activeElement === body` — the browser may not have moved focus
        // yet. Only take focus if it would otherwise be lost.
        if (el && el.offsetParent !== null && (!document.activeElement || document.activeElement === document.body)) el.focus();
      });
    };
  }, [open, focusSelector]);
}
