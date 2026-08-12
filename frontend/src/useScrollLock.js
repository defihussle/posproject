import { useEffect } from "react";

/**
 * Freezes the page behind an open modal.
 *
 * Two things make this more than a one-line `overflow: hidden`:
 *
 * 1. iOS Safari scrolls the page anyway when only `overflow: hidden` is set
 *    on body — the reliable fix is taking body out of flow with
 *    `position: fixed` and offsetting it by the current scroll position, then
 *    restoring that position on unlock. Owners run this on iPhones, so the
 *    cheaper version isn't enough.
 *
 * 2. Modals stack (an item modal opens a ConfirmDialog on top). A naive
 *    lock/unlock pair would unlock the page the moment the INNER dialog
 *    closed, while the outer modal is still open. The module-level counter
 *    below means only the last modal to close actually restores scrolling.
 *
 * The counter also survives React StrictMode's double-invoked effects in
 * development: mount → lock(1) → cleanup → unlock(0) → lock(1) nets out to a
 * single lock rather than leaving the page stuck.
 *
 * Pass `active` for a modal that's conditionally rendered by a parent that
 * stays mounted; omit it in a component that only exists while open.
 */

let lockCount = 0;
let saved = null;

function lock() {
  // Something above us already locked — just take a reference on it.
  if (lockCount++ > 0) return;

  const body = document.body;
  const scrollY = window.scrollY;

  saved = {
    scrollY,
    position: body.style.position,
    top: body.style.top,
    left: body.style.left,
    right: body.style.right,
    width: body.style.width,
    overflow: body.style.overflow,
    paddingRight: body.style.paddingRight,
  };

  // Replacing the scrollbar's width with padding stops the page shifting
  // sideways as it disappears (desktop only — overlay scrollbars report 0).
  const scrollbar = window.innerWidth - document.documentElement.clientWidth;
  if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;

  body.style.position = "fixed";
  body.style.top = `-${scrollY}px`;
  body.style.left = "0";
  body.style.right = "0";
  body.style.width = "100%";
  body.style.overflow = "hidden";
}

function unlock() {
  // A modal underneath this one is still open — stay locked.
  if (--lockCount > 0) return;
  lockCount = 0;
  if (!saved) return;

  const body = document.body;
  body.style.position = saved.position;
  body.style.top = saved.top;
  body.style.left = saved.left;
  body.style.right = saved.right;
  body.style.width = saved.width;
  body.style.overflow = saved.overflow;
  body.style.paddingRight = saved.paddingRight;

  // Taking body out of `position: fixed` drops the page back to scroll 0,
  // so the reader has to be put back where they were.
  window.scrollTo(0, saved.scrollY);
  saved = null;
}

export default function useScrollLock(active = true) {
  useEffect(() => {
    if (!active) return undefined;
    lock();
    return unlock;
  }, [active]);
}
