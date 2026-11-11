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

const EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)";
/** px/ms above which a short flick commits without reaching the distance threshold. */
const FLICK = 0.5;

/**
 * Swipe a conversation row: left commits `left`, right commits `right`, by distance or by flick.
 * The row tracks the finger 1:1 over a coloured reveal; a short, slow swipe springs back.
 *
 * Smoothness rules: nothing here causes a React render, state lives in data attributes and inline
 * styles React does not manage (a re-render rewrites `className`), the row is on its own layer
 * from touchstart, and all style writes are coalesced into one per animation frame.
 */
export function attachRowSwipe(list: HTMLElement, onSwipe: (swipe: RowSwipe) => void): () => void {
  let track: Track | null = null, row: HTMLElement | null = null, reveal: HTMLElement | null = null;
  let armed = false, origin = 0, offset = 0, frame = 0, settle: ReturnType<typeof setTimeout> | undefined;
  // The last two samples give the release velocity.
  let lastX = 0, lastAt = 0, velocity = 0;
  const threshold = () => Math.min(120, list.clientWidth * 0.3);
  const clear = (target: HTMLElement | null) => {
    cancelAnimationFrame(frame); frame = 0;
    if (target) {
      for (const name of ["transform", "transition", "opacity", "height", "padding-block", "overflow"]) target.style.removeProperty(name);
      delete target.dataset.swipe;
    }
    reveal?.remove(); reveal = null;
  };
  const paint = () => {
    frame = 0;
    if (row) row.style.transform = `translate3d(${offset}px,0,0)`;
    if (reveal) { reveal.dataset.direction = offset < 0 ? "left" : "right"; reveal.dataset.armed = String(armed); }
  };
  const start = (event: TouchEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>(".mail-row[data-mail-id]") : null;
    if (!target || target.parentElement !== list || target.classList.contains("selected")) { track = null; return; }
    // A new touch ends any release animation still running on another row.
    clearTimeout(settle); clear(row);
    track = begin(event); row = target; armed = false; offset = 0; velocity = 0;
    if (track) { lastX = track.x; lastAt = event.timeStamp; target.dataset.swipe = "ready"; }
  };
  const move = (event: TouchEvent) => {
    if (!track || !row) return;
    if (event.touches.length !== 1) { clear(row); track = null; return; }
    const change = delta(event, track);
    if (!change) return;
    if (!track.locked) {
      const kind = intent(change.dx, change.dy);
      if (kind === "vertical") { delete row.dataset.swipe; track = null; return; }
      if (kind !== "horizontal") return;
      track.locked = true;
      // Start from where the finger is now, so the row does not jump by the lock distance.
      origin = change.dx;
      row.dataset.swipe = "active";
      reveal = document.createElement("div");
      reveal.className = "mail-swipe-reveal"; reveal.setAttribute("aria-hidden", "true");
      reveal.style.top = `${row.offsetTop}px`; reveal.style.height = `${row.offsetHeight}px`;
      list.appendChild(reveal);
    }
    // Claimed: the list must not scroll and the page must not navigate.
    if (event.cancelable) event.preventDefault();
    const x = track.x + change.dx, elapsed = event.timeStamp - lastAt;
    if (elapsed > 0) { velocity = 0.6 * ((x - lastX) / elapsed) + 0.4 * velocity; lastX = x; lastAt = event.timeStamp; }
    offset = change.dx - origin;
    armed = Math.abs(offset) >= threshold();
    frame ||= requestAnimationFrame(paint);
  };
  const end = (event: TouchEvent) => {
    if (!track || !row) return;
    const active = track, target = row;
    track = null;
    if (!active.locked) { delete target.dataset.swipe; return; }
    cancelAnimationFrame(frame); frame = 0;
    // The browser may still synthesize a click for this touch; a swipe never opens the row.
    const swallow = (click: Event) => { click.stopPropagation(); click.preventDefault(); };
    list.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => list.removeEventListener("click", swallow, true), 400);
    // A finger that stopped before lifting is not a flick, whatever its earlier speed.
    const speed = event.timeStamp - lastAt > 80 ? 0 : velocity;
    const flick = Math.abs(speed) >= FLICK && Math.sign(speed) === Math.sign(offset) && Math.abs(offset) > 24;
    const commit = event.type === "touchend" && (armed || flick);
    const direction = offset < 0 ? "left" : "right";
    if (reveal && commit) reveal.dataset.armed = "true";
    const width = list.clientWidth;
    if (commit && direction === "left") {
      // Done removes the row: it leaves at the finger's speed, then the list closes up at once
      // instead of holding an empty slot until the action settles.
      const remaining = width - Math.abs(offset);
      const slide = Math.round(Math.min(220, Math.max(90, remaining / Math.max(Math.abs(speed), 1.2))));
      target.style.transition = `transform ${slide}ms ${EASE}`;
      target.style.transform = "translate3d(-100%,0,0)";
      const height = target.offsetHeight, shade = reveal;
      settle = setTimeout(() => {
        target.style.overflow = "hidden"; target.style.opacity = "0"; target.style.height = `${height}px`;
        if (shade) shade.style.transition = `height 180ms ${EASE}, opacity 180ms linear`;
        void target.offsetHeight;
        target.style.transition = `height 180ms ${EASE}, padding 180ms ${EASE}`;
        target.style.height = "0px"; target.style.paddingBlock = "0px";
        if (shade) { shade.style.height = "0px"; shade.style.opacity = "0"; }
        // Still mounted well after the action should have removed it: refused or failed, so restore it.
        settle = setTimeout(() => { clear(target); if (row === target) row = null; }, 1500);
      }, slide);
    } else {
      const back = Math.round(Math.min(240, Math.max(140, Math.abs(offset) * 1.2)));
      target.style.transition = `transform ${back}ms ${EASE}`;
      target.style.transform = "translate3d(0,0,0)";
      settle = setTimeout(() => { clear(target); if (row === target) row = null; }, back + 20);
    }
    if (commit) onSwipe({ id: target.dataset.mailId!, index: Number(target.getAttribute("aria-rowindex")) - 1, direction });
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
