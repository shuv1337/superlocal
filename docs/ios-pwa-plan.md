# iOS PWA and rate-limit plan

Status: draft for review, 2026-11-10 (PST). Nothing here is implemented yet.

Assumption: "the iOS app" means Superhuman Mail for iPhone, which Superlocal's desktop
behaviour already follows. Say so if you meant a different app.

## 1. What is wrong today

Measured on the running build (`ba0bf20`) at an iPhone-sized viewport, plus your screenshot.

| Problem | Evidence |
| --- | --- |
| Rows overlap | The "To:" line (`.row-recipients`) sits at y 31–47 inside a 44px row whose subject occupies y 21–38. The 700px rules predate the recipient line. |
| Desktop rail stays on screen | `.app-rail` keeps 40px of a ~400px screen for five icons. |
| Hover actions stick after a tap | The tapped row keeps its highlight and its Done / lightning buttons, covering the time. |
| No touch gestures at all | No swipe, pull or edge-back handling exists anywhere in `apps/web/src`. The only touch code ignores touch pointer moves. |
| Small targets | 111 of 112 visible controls are under 44×44px. Split tabs are 23px tall. |
| No safe-area handling | No `viewport-fit=cover`, no `env(safe-area-inset-*)`. The header and bottom controls ignore the notch and home indicator. |
| No overscroll control | The list rubber-bands the whole page; nothing claims the pull gesture. |
| Cold start every time | No service worker and no cached inbox. iOS evicts the PWA often, so each return is a full network bootstrap. |
| Text is small | 13px rows and 12px recipients; inputs under 16px make iOS zoom on focus in places. |

## 2. How Superhuman's iPhone app works

From Superhuman's help centre and its gesture redesign post.

- **Row swipes in the inbox:** swipe left marks Done, swipe right opens Remind Me. Both are
  configurable. Undo appears as a tappable toast.
- **Pull down in the inbox:** straight down opens search; down then right ("L") opens the
  command palette; down then left refreshes.
- **Open conversation:** swipe right anywhere on screen (not only from the edge) returns
  to the inbox. A triage bar at the bottom holds Done, Remind and more, scrolling sideways.
  Swiping a single message left offers Reply / Reply All / Forward. Pulling down opens the
  command palette. Long-press selects text.
- **Navigation lives at the bottom:** splits are a bottom strip you tap or scroll; search
  is a bottom icon. Folders are behind the top-left menu.

## 3. Proposed iOS work

Desktop appearance stays unchanged: everything is scoped to `max-width: 700px` plus
coarse-pointer checks. Each phase is its own change with before/after captures on
fictional mail.

### Phase A: make it usable (layout only, no gestures)

1. Two- or three-line rows sized for touch (about 64px, 72px with a recipient line), 15–16px
   sender and subject, time top-right, no overlap.
2. Remove the rail on phones. Its destinations (mail, calendar, AI triage, settings) move
   into the existing folder panel behind the menu button.
3. Bottom bar: split tabs (scrollable), search and compose, padded for the home indicator.
4. `viewport-fit=cover` and safe-area padding on header, bottom bar, composer and toasts.
5. No sticky hover: on coarse pointers a tap opens the conversation and row buttons are
   hidden (swipes replace them in Phase B).
6. 44px minimum targets; 16px inputs so iOS never zooms; `overscroll-behavior` on the list.
7. Full-screen conversation and composer on phones, with a bottom triage bar
   (Done, Remind Me, Star, More).

### Phase B: gestures

1. Row swipe: left = Done, right = Remind Me, using the existing Done/Undo receipts and
   Remind Me menu. Direction lock so vertical scrolling is never hijacked; a threshold
   with a colour and icon reveal; release past it commits, short of it springs back.
2. Swipe right anywhere in an open conversation to go back (the email iframe needs a
   transparent edge strip or pointer forwarding, since it swallows touches).
3. Pull down in the inbox: straight = search, down-right = command palette,
   down-left = refresh.
4. Later, if wanted: per-message swipe for Reply / Forward, configurable swipe actions.

The one real constraint: iOS Safari owns the left-edge back swipe in a browser tab, but
not in an installed PWA, so gesture work is tested in the installed app.

### Phase C: instant start

1. Service worker that caches the app shell (HTML, JS, CSS, fonts) so launch never waits
   on the network.
2. Persist the last inbox window (rows only, no bodies) in IndexedDB under the existing
   application scope and paint it immediately, then reconcile through the normal delta
   path. This puts mail metadata at rest on the phone; say if you would rather not.

## 4. Rate limits

### What is happening

- Only the **Outlook** mailbox is affected. It has failed 27 times in a row since
  12:31 PM today and logged 90 `RATE_LIMITED` events in 24 hours. Gmail is healthy.
- The retry loop cannot make progress. One 429 anywhere in a sync page throws away the
  whole page, the checkpoint does not advance, and the next attempt (5 minutes later)
  replays the identical requests.
- Likely trigger, not yet proven: Outlook allows 4 concurrent requests per app per
  mailbox. Our sync fetches message details 5 at a time (`hydrateMessages`), and other
  reads can run alongside. A delta page with 5 or more items needing a detail fetch
  would hit the limit every single time. The log records only the code `RATE_LIMITED`,
  so the first step is to confirm this.
- Separate, smaller limits that a phone makes worse: 4 live-update streams per owner
  (desktop tabs plus the phone can exceed it), and the image proxy's queue
  (29 `MEDIA_TIMEOUT` in 24 hours).

### Proposed fixes, in order

1. **Diagnose (content-free):** log the provider, request kind (delta / message /
   attachments), HTTP status, Graph error code and Retry-After for sync failures.
2. **Per-mailbox request limiter for Outlook:** at most 3 in flight, shared by sync and
   interactive reads, honouring Retry-After across all of them.
3. **Keep partial progress:** retry an individual 429 in place after its Retry-After
   (bounded), and stop discarding already-fetched items when one fetch fails.
4. **Fetch less:** reuse stored data when a delta change only flips read/flag state
   instead of refetching the whole message; use Graph `$batch` for the rest.
5. **Poll less when idle:** every 15s per account today. Back off when no client is
   connected, and sync immediately when one connects or acts.
6. **Client side:** show one calm per-mailbox status with the retry time instead of a
   toast; keep reading cached mail; raise the stream cap or share one stream per device.

Items 2–4 change sync behaviour, so they get tests in the existing SDK test files and a
before/after request count on the fictional mock.

## 5. Suggested order

1. Rate limits 1–3 (your Outlook mailbox is stuck right now).
2. iOS Phase A.
3. iOS Phase B.
4. iOS Phase C and rate limits 4–6.

## 6. Decisions needed

1. Is Superhuman for iPhone the right reference?
2. Swipe defaults: left = Done, right = Remind Me?
3. Bottom bar on phones (splits, search, compose), with the rail removed?
4. Is caching inbox rows on the phone acceptable (Phase C.2)?
5. Start with the Outlook rate-limit fix, or with iOS layout?
