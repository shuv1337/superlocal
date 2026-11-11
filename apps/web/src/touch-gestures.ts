/**
 * Touch gestures for the phone layout. Plain DOM listeners: the mail list is virtualized and
 * the email body lives in an iframe document, so neither can use React's synthetic touch events
 * (which are also passive and cannot claim a horizontal drag).
 */
const LOCK_PX = 10;
const phone = () => matchMedia("(max-width: 700px)").matches;

type Track = { x: number; y: number; id: number; locked: boolean };

/** Starts tracking one finger; a second finger (pinch) cancels the gesture. */
const begin = (event: TouchEvent): Track | null => {
  const touch = event.touches[0];
  return event.touches.length === 1 && touch && phone() ? { x: touch.screenX, y: touch.screenY, id: touch.identifier, locked: false } : null;
};
const delta = (event: TouchEvent, track: Track) => {
  const touch = Array.from(event.changedTouches).find(item => item.identifier === track.id) ?? Array.from(event.touches).find(item => item.identifier === track.id);
  return touch ? { dx: touch.screenX - track.x, dy: touch.screenY - track.y } : null;
};
/** Horizontal intent wins only when it clearly dominates, so vertical scrolling is never hijacked. */
const intent = (dx: number, dy: number) => Math.abs(dy) > LOCK_PX && Math.abs(dy) >= Math.abs(dx) ? "vertical"
  : Math.abs(dx) > LOCK_PX && Math.abs(dx) > Math.abs(dy) * 1.5 ? "horizontal" : null;

export type RowSwipe = { id: string; index: number; direction: "left" | "right" };

/**
 * Swipe a conversation row: left past the threshold commits `left`, right commits `right`.
 * The row follows the finger over a coloured reveal; short of the threshold it springs back.
 */
export function attachRowSwipe(list: HTMLElement, onSwipe: (swipe: RowSwipe) => void): () => void {
  let track: Track | null = null, row: HTMLElement | null = null, reveal: HTMLElement | null = null, armed = false, settle: ReturnType<typeof setTimeout> | undefined;
  const threshold = () => Math.min(120, list.clientWidth * 0.3);
  const clear = (target: HTMLElement | null) => {
    if (target) { target.style.transform = ""; target.style.transition = ""; target.style.opacity = ""; target.classList.remove("swiping"); }
    reveal?.remove(); reveal = null;
  };
  const start = (event: TouchEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>(".mail-row[data-mail-id]") : null;
    if (!target || target.parentElement !== list || target.classList.contains("selected")) { track = null; return; }
    // A new touch ends any release animation still running on another row.
    clearTimeout(settle); clear(row);
    track = begin(event); row = target; armed = false;
  };
  const move = (event: TouchEvent) => {
    if (!track || !row) return;
    if (event.touches.length !== 1) { clear(row); track = null; return; }
    const change = delta(event, track);
    if (!change) return;
    if (!track.locked) {
      const kind = intent(change.dx, change.dy);
      if (kind === "vertical") { track = null; return; }
      if (kind !== "horizontal") return;
      track.locked = true;
      row.classList.add("swiping");
      reveal = document.createElement("div");
      reveal.className = "mail-swipe-reveal"; reveal.setAttribute("aria-hidden", "true");
      reveal.style.top = `${row.offsetTop}px`; reveal.style.height = `${row.offsetHeight}px`;
      list.appendChild(reveal);
    }
    // Claimed: the list must not scroll and the page must not navigate.
    if (event.cancelable) event.preventDefault();
    const limit = threshold();
    // Past the threshold the row follows at a third of the finger's speed, as a "that is enough" cue.
    const offset = Math.sign(change.dx) * (Math.abs(change.dx) <= limit ? Math.abs(change.dx) : limit + (Math.abs(change.dx) - limit) / 3);
    row.style.transform = `translate3d(${offset}px,0,0)`;
    const next = Math.abs(change.dx) >= limit;
    if (reveal) {
      reveal.dataset.direction = change.dx < 0 ? "left" : "right";
      reveal.dataset.armed = String(next);
    }
    if (next !== armed) { armed = next; if (next) navigator.vibrate?.(8); }
  };
  const end = (event: TouchEvent) => {
    if (!track || !row) return;
    const active = track, target = row, change = delta(event, active);
    track = null;
    if (!active.locked) return;
    // The browser may still synthesize a click for this touch; a swipe never opens the row.
    const swallow = (click: Event) => { click.stopPropagation(); click.preventDefault(); };
    list.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => list.removeEventListener("click", swallow, true), 400);
    const commit = event.type === "touchend" && armed && change;
    target.style.transition = "transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 180ms linear";
    if (commit && change.dx < 0) {
      // Done removes the row: let it leave in the swipe direction instead of snapping back first.
      target.style.transform = "translate3d(-100%,0,0)"; target.style.opacity = "0";
    } else target.style.transform = "";
    if (commit) onSwipe({ id: target.dataset.mailId!, index: Number(target.getAttribute("aria-rowindex")) - 1, direction: change.dx < 0 ? "left" : "right" });
    // If the row is still mounted afterwards (action refused, or a recycled virtual row), restore it.
    settle = setTimeout(() => { clear(target); if (row === target) row = null; }, commit && change.dx < 0 ? 600 : 200);
  };
  list.addEventListener("touchstart", start, { passive: true });
  list.addEventListener("touchmove", move, { passive: false });
  list.addEventListener("touchend", end);
  list.addEventListener("touchcancel", end);
  return () => {
    clearTimeout(settle); clear(row);
    list.removeEventListener("touchstart", start); list.removeEventListener("touchmove", move);
    list.removeEventListener("touchend", end); list.removeEventListener("touchcancel", end);
  };
}

/**
 * Swipe right anywhere on an open conversation to go back. `source` is the pane itself or an
 * email iframe's document; `pane` is what visibly follows the finger.
 */
export function attachSwipeBack(source: HTMLElement | Document, pane: () => HTMLElement | null, onBack: () => void): () => void {
  let track: Track | null = null;
  const reset = (animate: boolean) => {
    const element = pane();
    if (!element) return;
    element.style.transition = animate ? "transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)" : "";
    element.style.transform = "";
    if (animate) setTimeout(() => { element.style.transition = ""; }, 200);
  };
  const start = (event: TouchEvent) => {
    track = null;
    // An email body's nodes belong to the iframe's realm, so `instanceof Element` is false for them.
    const target = event.target && typeof (event.target as Element).closest === "function" ? event.target as Element : null;
    // Text fields, sliders and anything that scrolls sideways keep their own horizontal drags.
    if (!target || target.closest("input, textarea, select, [contenteditable], .thread-header-actions")) return;
    for (let node: Element | null = target; node; node = node.parentElement) {
      if (node.scrollWidth > node.clientWidth + 1 && node.scrollLeft > 0) return;
    }
    const view = "defaultView" in source ? source.defaultView : null;
    if (view && view.scrollX > 0) return;
    track = begin(event);
  };
  const move = (event: TouchEvent) => {
    if (!track) return;
    if (event.touches.length !== 1) { if (track.locked) reset(true); track = null; return; }
    const change = delta(event, track);
    if (!change) return;
    if (!track.locked) {
      const kind = intent(change.dx, change.dy);
      if (kind === "vertical" || kind === "horizontal" && change.dx < 0) { track = null; return; }
      if (kind !== "horizontal") return;
      track.locked = true;
    }
    if (event.cancelable) event.preventDefault();
    const element = pane();
    if (element) { element.style.transition = ""; element.style.transform = `translate3d(${Math.max(0, change.dx)}px,0,0)`; }
  };
  const end = (event: TouchEvent) => {
    if (!track) return;
    const active = track, change = delta(event, active);
    track = null;
    if (!active.locked) return;
    const element = pane();
    if (event.type === "touchend" && change && element && change.dx >= Math.min(120, element.clientWidth * 0.3)) {
      // The conversation unmounts on navigation, so there is nothing to restore.
      onBack();
    } else reset(true);
  };
  const options = { passive: false } as const;
  source.addEventListener("touchstart", start as EventListener, { passive: true });
  source.addEventListener("touchmove", move as EventListener, options);
  source.addEventListener("touchend", end as EventListener);
  source.addEventListener("touchcancel", end as EventListener);
  return () => {
    reset(false);
    source.removeEventListener("touchstart", start as EventListener); source.removeEventListener("touchmove", move as EventListener);
    source.removeEventListener("touchend", end as EventListener); source.removeEventListener("touchcancel", end as EventListener);
  };
}
