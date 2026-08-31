// The Mosaic view: an optional Media-tab layout that shows every photo
// at its own aspect ratio instead of X's square crop.
//
// An opaque overlay draws the tiles over X's own media view, fed two
// ways. The MAIN-world interceptor hands over every photos-timeline
// response the page fetches anyway (no requests of ours; each media
// entity carries original_info.width/height, which the layout reads).
// The harvest reads whatever cells X has mounted as a fallback. Deep
// loading asks X for the next page by cursor, behind the rate floor. A
// tile opens through X's own viewer (see openTile and pushPhotoRoute)
// and closing the viewer lands back in the grid.
//
// The grid rides ONE timeline: photos. X partitions media server-side,
// so a mixed photo+video grid has no single source. Videos keep X's view.
//
// X's media dropdown gets a third option: Videos / Photos / Mosaic (the
// item is a clone of one of X's own, so it wears X's own menu styling).
// A pick persists: the dropdown item and the popup's "Media tab opens"
// select write the same `mediaview` choice, so whatever was picked last
// is what the Media tab opens next time. Escape is the one per-visit
// override, and it writes nothing.
import { pollFor } from "../core/poll";
import { readMediaView, settingsReady, watchChoice } from "../core/settings";
import { subscribeToMutations } from "./observer";

const OVERLAY_ID = "xtag-grid";
const GRID_ITEM_ATTR = "data-xtag-grid-item";
// A profile's media-tab path.
const MEDIA_PATH_RE = /^\/[A-Za-z0-9_]{1,15}\/media\/?$/;
// The photo viewer's route: while the grid is active this KEEPS the grid
// alive (hidden under the viewer) instead of tearing it down, so closing
// the viewer lands back in the grid exactly as it was.
const PHOTO_ROUTE_RE = /^\/[A-Za-z0-9_]{1,15}\/status\/\d+\/photo\/\d+/i;
// The render gate below protects against outrunning X's renderer; these
// fixed delays only cap top speed on steps that actually yielded tiles.
const DRIVE_STEP_MS = 180;
const IDLE_MS = 250;
const POLL_MS = 100;
// How long one scroll position gets to render before the driver moves on
// anyway. X mounts cell shells first and fills the media in later, so a
// driver that steps on a fixed clock outruns the renderer and walks to the
// end of the virtualizer's spacer with an empty grid (measured on a fresh
// page load).
const STEP_PATIENCE_MS = 1500;
// At the bottom of the document the patience shrinks: the 1500ms window
// is sized for mid-feed rendering, and four of them after the last real
// tile is ~6s of skeleton shimmer. A premature end is soft: any later
// tile clears `exhausted` and the tail returns.
const BOTTOM_PATIENCE_MS = 700;
const STALLS_FOR_END = 4;
// Look-ahead: ~1.5 viewports. This also bounds the eager thumbnail
// fetches, and it is the knob that decides how much of the rate-limit
// bucket a casual profile visit spends.
function bufferPx(): number {
  return Math.max(Math.round(window.innerHeight * 1.5), 900);
}
// There is no scroll-driven prefill, and none may be added: a
// window-scroll prefill and the no-shift rule are mutually exclusive by
// construction. The prefill is passive: the MAIN-world interceptor hands
// over every photos-timeline response the page fetches anyway (zero
// extra requests; active replays spend the user's own rate-limit bucket,
// and a few gridded profiles' worth of them 429'd the whole site). At
// most ONE active replay page remains, only when the passive path came
// up short, gated behind a cooldown after any 429.
const PREFILL_MIN_TILES = 15;
const API_COOLDOWN_MS = 10 * 60_000;
// One page size, settled by measurement on /NASA: count=100 and
// count=200 returned receipts identical in every field, so X clamps the
// ask, and both big runs ended 100 photos early on a 3x cursor echo
// while count=20 sailed past. Do not rebuild a page-size ladder.
const PAGE_COUNT = 20;
// A SHORT PAGE IS NOT THE END; do not add a minimum-page-size rule. X
// applies the photo filter server-side: `count: 20` buys 20 items of the
// underlying media timeline and returns only the photos among them, so
// consecutive pages can carry 7, 12, 15, 10, 2, 13 tweets mid-feed
// (measured live on /NASA). A page is small because the account posted
// videos there, not because the timeline ran out.
//
// What the end actually looks like (measured live): X sends no
// TimelineTerminateTimeline at all. The end is the page AFTER the last
// one: a few hundred bytes of cursor-only entries whose Bottom cursor
// equals the cursor that asked for it. That is the signal every path
// keys off (applyPayload's non-advancing-cursor check, and
// fetchMediaPage's for our own replays). It costs one page fetch at the
// true end, which X's own feed makes anyway on an undocked profile.
// --- the rate-limit floor --------------------------------------------------
// Even fully passive, the driver makes X fetch pages at machine speed, and
// the per-user bucket is SHARED with X's real feeds; draining it disables
// the whole site. Every photos-timeline response carries
// x-rate-limit-remaining/reset (the interceptor forwards them, and our
// own replays read them directly); when remaining hits the floor the
// driver stops asking for more and says when loading resumes, so the
// reader's own timelines keep the rest of the budget. The floor is 12,
// not a token: X's native photos view draws on this same bucket, so
// what the floor reserves is exactly how much plain photo-grid
// browsing survives a long mosaic session.
const RATE_FLOOR = 12;
let rateRemaining: number | null = null;
let rateResetAt = 0; // epoch ms
// --- the spend meter (nothing persisted) -----------------------------------
// remaining/reset pace the driver; the counters say what a gridded
// profile actually costs. X sends x-rate-limit-limit on every
// photos-timeline response (the denominator); the counters split the
// spend into the part that is ours (apiPrefill's replay, driveLoop's
// cursor extensions) and the part X's own page fetched anyway (passive,
// free). logSpend prints the receipt on every deactivate. FOUND vs
// ADDED is the diagnosis: found counts every media item our pages
// carried, added what became a tile, and a wide gap means we paid for
// photos already on screen.
let rateLimit: number | null = null;
let rateLow: number | null = null;
let ownPages = 0;
let ownPhotos = 0;
let ownAdded = 0;
let passivePages = 0;
let spendStartedAt = 0;
// --- the per-handle grid cache ---------------------------------------------
// Back-and-forth browsing must not re-buy the same pages. Deactivation
// stashes the tiles + the deepest Bottom cursor; a revisit paints
// instantly from the stash and only spends past the cached frontier
// (see the cursor-extension step in driveLoop).
interface CachedGrid {
  entries: { href: string; src: string; video: boolean; ratio?: number }[];
  cursor: string | null;
  template: string | null;
  ended: boolean;
  at: number;
}
const gridCache = new Map<string, CachedGrid>();
const GRID_CACHE_TTL_MS = 15 * 60_000;
const GRID_CACHE_MAX = 8;
// X's public web-app bearer token; the constant baked into x.com's own
// bundle for every logged-in web session (stable for years, not a
// secret). The replay sends exactly what the page itself sends.
const PREFILL_BEARER = "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRC"
  + "OuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

// The Media-tab default, shared with the popup's select: "photos" (X's
// native grid), "mosaic", or "videos". Dropdown picks persist into the
// same key, so the dropdown IS the control.
const mediaView = watchChoice("mediaview", readMediaView);

// The per-visit override. "feed" means "X's own view for now, whatever
// the default" (Escape writes it, and it alone persists nothing);
// "mosaic" bridges the beat between a dropdown pick and the storage
// cache echoing it back. evaluate() clears it when the reader leaves the
// media surface, so every fresh visit starts from the stored default.
let override: "mosaic" | "feed" | null = null;
// Whether the grid overlay is up RIGHT NOW. Any logic keyed on "the
// reader scrolled down" must ask, because the driver walks the WINDOW
// scroll behind the overlay. OUTSIDE this extension the contract is the
// xtag-gridmode class on <html>, which activate/deactivate hold in exact
// step with `active`; keep it that way, other extensions branch on it.
let active = false;
let exhausted = false;
let stalls = 0;
let activatedAt = 0;
let gridHandle = "";
// A tile click may be riding the feed's real photo anchor (scroll + click):
// the driver must not fight over the window scroll meanwhile.
let navigating = false;
// True while OUR OWN code is clicking a real menu item (the grid handler
// rides X's Photos item to reach the photos view). Without it that
// synthetic click re-enters onMenuClick and reads as the user explicitly
// choosing X's own view, which clears the pick and the grid never
// comes up.
let selfClicking = false;

// The map is keyed by LOWERCASED href; the API's expanded_url and the
// feed's own anchors can disagree on the handle's casing, and a case
// difference must never mint the same photo twice.
//
// A tile carries no ordering number (see mergeRun). Numbering tiles from
// two sources (a payload counter vs a feed cell's translateY) made the
// sort meaningless and scrambled the grid. The order lives in exactly
// one place: the grid's DOM.
interface Tile {
  href: string;
  src: string;
  video: boolean;
  // height/width of the ORIGINAL image, from the payload's original_info.
  // The layout reads this before any thumbnail loads, which is what
  // keeps the no-shift rule. Undefined means the tile came from the
  // harvest with no payload seen yet; the thumb's own load event teaches
  // the ratio then (name=small preserves aspect), one relayout per lesson.
  ratio?: number;
  // The tile's feed cell translateY, once a mounted cell has been seen for
  // it. Undefined means the tile came from a payload or the cache and no
  // cell has ever mounted for it; X's own feed has never been near this
  // photo, so a click deep-links instead of riding (see openTile).
  cellY?: number;
  el?: HTMLAnchorElement;
}
const tiles = new Map<string, Tile>();

function onPhotosFeed(): boolean {
  return MEDIA_PATH_RE.test(location.pathname)
    && new URLSearchParams(location.search).get("filter") === "photo";
}

function onPhotoRoute(): boolean {
  return PHOTO_ROUTE_RE.test(location.pathname);
}

function shouldGrid(): boolean {
  // Leaving the media surface must deactivate the overlay, not just hide
  // it: a driver behind a hidden overlay reads clientHeight 0 as "need
  // more" forever.
  if (!onPhotosFeed()) return false;
  if (override === "feed") return false;
  return override !== null || mediaView() === "mosaic";
}

function selectedMediaTab(): HTMLAnchorElement | null {
  const tabs = document.querySelectorAll<HTMLAnchorElement>(
    '[role="tablist"] a[role="tab"][aria-selected="true"]');
  for (const tab of Array.from(tabs)) {
    const path = (tab.getAttribute("href") ?? "").split("?")[0].replace(/\/$/, "");
    if (MEDIA_PATH_RE.test(path)) return tab;
  }
  return null;
}

// --- the tab wears the grid's name -----------------------------------------
// While the grid is active X's Media tab would say "Photos": the
// underlying view's name, not the one on screen. The tab's first text
// node is renamed to "Mosaic" and re-asserted every mutation batch
// (React re-renders restore X's label), with the ORIGINAL label kept:
// the menu logic below identifies the current-feed item by comparing
// item text against the tab's label, and that comparison must keep
// using X's own locale word, never our rename.
const GRID_TAB_LABEL = "Mosaic";

let tabLabelWas: string | null = null;

function tabTextOf(tab: HTMLElement): string {
  return (tab.textContent ?? "").trim();
}

// The tab's label as X wrote it (locale word), whether or not we renamed it.
function tabOriginalLabel(tab: HTMLElement): string {
  const text = tabTextOf(tab);
  return text === GRID_TAB_LABEL && tabLabelWas ? tabLabelWas : text;
}

// Every media-path tab in the tablist, selected or not: the RESTORE half
// must reach an unselected Media tab; a tab-switch away from the gridded
// view deselects it before deactivate runs, and the selected-only lookup
// left "Mosaic" written on it until React happened to re-render the strip.
function allMediaTabs(): HTMLAnchorElement[] {
  const tabs = document.querySelectorAll<HTMLAnchorElement>(
    '[role="tablist"] a[role="tab"]');
  return Array.from(tabs).filter((tab) => {
    const path = (tab.getAttribute("href") ?? "").split("?")[0].replace(/\/$/, "");
    return MEDIA_PATH_RE.test(path);
  });
}

function setFirstTextNode(root: HTMLElement,
                          want: (text: string) => string | null): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node.textContent ?? "").trim();
    if (!text) continue;
    const next = want(text);
    if (next !== null) node.textContent = next;
    return;
  }
}

function assertTabLabel(): void {
  // Nothing renamed yet and nothing to rename: skip the tablist walk; this
  // runs on every mutation batch across all of x.com.
  if (!active && tabLabelWas === null) return;
  if (active && onPhotosFeed()) {
    // Not before the takeover: pre-claim the page is X's, mid-transition,
    // and a text write into the strip React is rendering invalidates its
    // work for a label the reader cannot see the grid behind yet.
    if (!claimed) return;
    const tab = selectedMediaTab();
    if (!tab) return;
    setFirstTextNode(tab, (text) => {
      if (text === GRID_TAB_LABEL) return null;
      // Anything else is X's own locale word; keep it for the restore.
      tabLabelWas = text;
      return GRID_TAB_LABEL;
    });
    return;
  }
  for (const tab of allMediaTabs()) {
    setFirstTextNode(tab, (text) =>
      text === GRID_TAB_LABEL && tabLabelWas ? tabLabelWas : null);
  }
}

// --- overlay ---------------------------------------------------------------

let overlay: HTMLElement | null = null;
let gridEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
// The skeleton tiles live INSIDE the tile grid, always at its tail; so
// they continue the last partial row instead of starting a detached
// block below a gap. Real tiles insert BEFORE this marker.
let firstSkel: HTMLElement | null = null;
// Whether the grid has taken the page over yet: the xtag-gridmode class
// (which clips X's feed) and the scroll reset wait for the FIRST
// successful placement instead of firing at activation. At activation X
// is often still mid-transition, with the tab strip unmounted; clipping
// the feed then, with the overlay itself still hidden as unplaced,
// leaves the column showing neither X's view nor ours for that beat.
// Until the claim, the page stays X's own and the transition looks
// exactly like a native tab switch; the clip, the scroll reset and the
// spacer sizing all start together once there is something to cover.
let claimed = false;
// Whether the grid has "docked": the profile header has scrolled away and
// the grid is now the scrolling surface. Before that the grid is anchored
// IN the page: banner, bio, buttons and tabs stay visible, the page
// scrolls naturally, and the grid rides along under the tab bar.
let docked = false;

function primaryColumn(): HTMLElement | null {
  const el = document.querySelector('[data-testid="primaryColumn"]');
  return el instanceof HTMLElement ? el : null;
}

// The overlay tracks X's layout in the same frame. At entry X can still
// be rendering its header; when the tab strip then moves down, an
// overlay placed on the driver's slow beat covers the strip for a
// visible moment. So a ResizeObserver on the column re-places the
// overlay the moment the column's size changes; it fires after layout
// and before paint, so a corrected position is what actually reaches
// the screen. (placeOverlay writes only the overlay, on body, and the
// spacer, whose sizeSpacer is interval-gated; the observer cannot feed
// itself.)
let colResize: ResizeObserver | null = null;
let observedCol: HTMLElement | null = null;

function watchColumn(col: HTMLElement): void {
  if (col === observedCol) return;
  colResize ??= new ResizeObserver(() => {
    if (active) placeOverlay();
  });
  colResize.disconnect();
  colResize.observe(col);
  observedCol = col;
}

function unwatchColumn(): void {
  colResize?.disconnect();
  observedCol = null;
}

// The profile's STICKY top bar (back arrow · name): the ancestor of
// app-bar-back that computes sticky; bottom 53 measured at deep scroll.
function stickyBarBottom(col: HTMLElement | null): number {
  let top = 53;
  const back = col?.querySelector<HTMLElement>('[data-testid="app-bar-back"]');
  for (let node = back; node && node !== col; node = node.parentElement) {
    const pos = getComputedStyle(node).position;
    if (pos === "sticky" || pos === "fixed") {
      top = node.getBoundingClientRect().bottom;
      break;
    }
  }
  return Math.max(top, 0);
}

// Two positioning modes, flipped at the exact scroll where they coincide,
// so the switch is seamless:
//
// UNDOCKED (header on screen): position ABSOLUTE at the feed's own document
// position; the browser moves the grid perfectly in sync with the page, so
// it reads as page content, and the window scroll belongs to the USER (the
// driver is gated off; the user's own scrolling is what loads). The overlay
// doesn't scroll internally here (overflow hidden), so the wheel falls
// through to the page.
//
// DOCKED (tab bar has reached the sticky bar): position FIXED under the
// bar, internal scrolling on; and the driver may now walk the window
// behind it, because everything that moves is covered or off-screen. The
// profile TAB BAR is NOT sticky on X (measured), which is why the grid
// carries its own Videos/Photos/Grid strip for switching once docked.
function placeOverlay(): void {
  if (!overlay) return;
  const col = primaryColumn();
  const tablist = col?.querySelector<HTMLElement>('[role="tablist"]');
  // A fresh load has neither the column nor the tab bar yet, and the
  // fallback numbers (bar 53, tabBottom = bar) read as "docked, full
  // viewport width": a viewport-filling skeleton grid until X's first
  // real render. Nothing measured, nothing shown; the driver re-measures
  // every beat and reveals when X does. Unplaced gates only the FIRST
  // placement (pre-claim). After the takeover, X can remount the tab
  // strip mid-transition (measured: a remove + re-add on every tab
  // switch), and hiding the grid for that gap reads as flicker; with
  // nodes missing mid-session the overlay keeps its last geometry
  // instead, and the next beat re-measures.
  overlay.classList.toggle("xtag-grid-unplaced", (!col || !tablist) && !claimed);
  if (!col || !tablist) return;
  // The deferred takeover (see `claimed`): X's column and tab bar are
  // both here, so this is the first beat the overlay can actually
  // paint. Clip BEFORE measuring; it changes the layout being read.
  // The window is NOT scrolled: X restores its own per-tab scroll
  // position during the transition, and a reset of ours here fought it
  // (the reader watched the nav bar leave and come back). Wherever X
  // lands the reader is where the grid comes up; syncScroll maps any
  // window position onto the grid.
  if (active && !claimed) {
    claimed = true;
    document.documentElement.classList.add("xtag-gridmode");
    assertSpacer();
  }
  if (active) watchColumn(col);
  const rect = col.getBoundingClientRect();
  const bar = stickyBarBottom(col);
  const tabBottom = tablist.getBoundingClientRect().bottom;
  // The scrollY term guards the dock against a half-mounted tab strip:
  // while X remounts the strip mid-transition its rect can measure near
  // the viewport top for a frame, which reads as "docked" at scroll 0
  // and pins the opaque overlay over the nav bar's real place. A true
  // dock only exists past the header, so a window that has not even
  // scrolled the sticky bar's height cannot be docked.
  docked = tabBottom <= bar && window.scrollY > bar;
  // WHOLE pixels, not the fractional measurements: a huge composited
  // layer at a fractional offset is the classic source of sporadic
  // 1px rasterization seams, and the menu-seam hunt (2026-08-28)
  // measured the overlay at 601.672px while a hairline came and went
  // at the strip boundary under the open dropdown. Rounding moves the
  // overlay at most half a pixel against X's own lines.
  if (docked) {
    overlay.style.position = "fixed";
    overlay.style.top = `${Math.round(bar)}px`;
    overlay.style.bottom = "0";
    overlay.style.height = "";
  } else {
    overlay.style.position = "absolute";
    overlay.style.top = `${Math.round(window.scrollY + tabBottom)}px`;
    overlay.style.bottom = "";
    overlay.style.height = `${Math.round(Math.max(window.innerHeight - bar, 200))}px`;
  }
  // Inside the column's own border lines: primaryColumn paints 1px side
  // borders (measured live) that run the full scroll length, and a
  // full-width overlay covers them. Inset by the real border widths and
  // X's own lines stay visible beside the grid, in whatever color the
  // theme gives them.
  const colStyle = getComputedStyle(col);
  const borderL = parseFloat(colStyle.borderLeftWidth) || 0;
  const borderR = parseFloat(colStyle.borderRightWidth) || 0;
  overlay.style.left = `${Math.round(rect.left + borderL)}px`;
  overlay.style.width = `${Math.round(rect.width - borderL - borderR)}px`;
  // The column's width is the layout's one input besides the ratios;
  // re-lay-out when it actually changed (resize, sidebar flex).
  if (gridEl && Math.abs(gridEl.clientWidth - lastLayoutWidth) > 1) scheduleLayout();
  assertSpacer();
  sizeSpacer(false);
  syncScroll();
}

// The window scroll at which the tab bar docks; where the two modes meet.
function dockScrollY(): number {
  const col = primaryColumn();
  const bar = stickyBarBottom(col);
  const tablist = col?.querySelector<HTMLElement>('[role="tablist"]');
  if (!tablist) return 0;
  return Math.max(window.scrollY + tablist.getBoundingClientRect().bottom - bar, 0);
}

// --- the page is the scrollbar ---------------------------------------------
// One global page scroll moves the grid; the grid has no inner scroll of
// its own. The overlay stays one viewport tall, so nothing about its own
// layout changes; what changes is who drives it. A spacer in the column
// gives the WINDOW the full height of the grid, the feed underneath is
// clipped so the spacer is the only thing holding that height, and the
// window's scroll is copied in; so the reader scrolls the page, the
// profile header scrolls away, and the tiles follow.
const SPACER_ID = "xtag-grid-spacer";
const SIZE_INTERVAL_MS = 250;
let spacer: HTMLDivElement | null = null;
let spacerHeight = 0;
let lastMaxInner = -1;
let lastSizedAt = 0;
let sizeTimer = 0;

// A narrower place than it looks: X's sticky name bar stays pinned only
// while its CONTAINING BLOCK is on screen, and that block is not the
// primary column (measured on this same column and bar). The bar's own
// parent is the node whose height is the bar's range, so the height
// goes there.
function spacerHome(): HTMLElement | null {
  const col = primaryColumn();
  if (!col) return null;
  const back = col.querySelector<HTMLElement>('[data-testid="app-bar-back"]');
  for (let node = back; node && node !== col; node = node.parentElement) {
    if (getComputedStyle(node).position !== "sticky") continue;
    return node.parentElement ?? col;
  }
  return col.querySelector('section[role="region"]')?.parentElement ?? col;
}

// Re-asserted per batch: these nodes are React's, and a re-render drops what
// it does not own. NOT BEFORE THE CLAIM: appending a foreign node into
// the header React is actively re-rendering is mid-transition
// interference for a spacer that is 0px tall and unmeasurable anyway
// (sizeSpacer is claim-gated too).
function assertSpacer(): void {
  if (!spacer || !claimed) return;
  const home = spacerHome();
  if (home && spacer.parentElement !== home) home.appendChild(spacer);
}

// Measured and corrected, never modelled: X's layout owns everything above the
// grid, and a self-correcting delta cannot drift out of step with it the way
// arithmetic would. Cheap on the batches that change nothing; the height
// guard returns before it reads the document at all.
function sizeSpacer(force: boolean): void {
  if (!spacer || !overlay || !active || borrowed) return;
  // Before the takeover the document is X's own at its natural height;
  // there is nothing of ours to size against (see `claimed`).
  if (!claimed) return;
  // Three guards, each returning BEFORE anything is recorded, so the
  // next honest measurement is not a delta from a lie.
  //
  // 1. Not while the spacer is out of the document. Its home is React's,
  //    and a re-render drops it; the photo viewer's route can take the
  //    whole column with it. A measurement taken then reads a document
  //    height that does NOT include the spacer, so the delta comes out
  //    as the spacer's own height and gets added a second time, every
  //    round trip. assertSpacer puts it back on the next beat; there is
  //    nothing worth measuring until it has.
  if (!spacer.isConnected) return;
  // 2. Not while the photo viewer is up, or a tile click is mid-flight
  //    (the click is the earliest the route change can be known; waiting
  //    for evaluate()'s mutation batch leaves a gap the ticker can land
  //    in). Tiles keep arriving under the viewer (the interceptor mints
  //    X's own pages whatever route we are on), so maxInner changes and
  //    the guard below lets the measurement through, against a document
  //    that belongs to the VIEWER, not to the grid; the reader would
  //    come back far from where they left.
  if (navigating || onPhotoRoute()) return;
  // 3. Not while nothing is measured. With the column or the tab bar
  //    unmounted, dockScrollY() answers 0, and a delta computed from that
  //    cuts the spacer against a document that is mid-rebuild.
  if (overlay.classList.contains("xtag-grid-unplaced")) return;
  const now = Date.now();
  if (!force && now - lastSizedAt < SIZE_INTERVAL_MS) return;
  lastSizedAt = now;
  const maxInner = Math.max(overlay.scrollHeight - overlay.clientHeight, 0);
  if (!force && maxInner === lastMaxInner) return;
  lastMaxInner = maxInner;
  const wanted = dockScrollY() + maxInner + window.innerHeight;
  const delta = wanted - document.documentElement.scrollHeight;
  if (Math.abs(delta) <= 2) return;
  spacerHeight = Math.max(spacerHeight + delta, 0);
  spacer.style.height = `${Math.round(spacerHeight)}px`;
}

// The sizing needs a clock of its own. Every other call site hangs off
// the outer document (a scroll, a resize, a mutation batch), and the
// thing that changes the wanted height is the GRID growing, which
// arrives from a fetch and touches none of them. Without the clock, a
// reader sitting still while a page landed would have nowhere to
// scroll to.
function startSizing(): void {
  if (sizeTimer) return;
  sizeTimer = window.setInterval(() => sizeSpacer(false), SIZE_INTERVAL_MS);
}

function stopSizing(): void {
  window.clearInterval(sizeTimer);
  sizeTimer = 0;
}

// Copy the window's scroll into the overlay. Everything below the dock point
// is the profile header scrolling away; everything above it is grid.
function syncScroll(): void {
  if (!overlay || borrowed) return;
  // The viewer's document is not the grid's: while the viewer is up (or a
  // tile click is mid-flight) the window's scroll says nothing about the
  // grid, and copying it in would scroll the hidden grid to wherever the
  // viewer's short document clamps. Same freeze the sizing takes.
  if (navigating || onPhotoRoute()) return;
  const target = docked ? Math.max(window.scrollY - dockScrollY(), 0) : 0;
  if (Math.abs(overlay.scrollTop - target) > 1) overlay.scrollTop = target;
}

// BORROWING THE WINDOW, because two things still need it and it is the
// reader's now. A tile click rides it to the cell the tile came from so X
// mounts the real anchor and X's own router opens the post; and the degraded
// loader walks it when no payload template is available to ask with. Both put
// it back where they found it. For the duration the feed is un-clipped; a
// ride against a two-screen list is meaningless; the grid is not synced, so
// it does not follow the window down, and the spacer is not measured against a
// document that is mid-flight.
let borrowed = 0;
let borrowReturnY = 0;

function borrowWindow(): void {
  if (borrowed++) return;
  borrowReturnY = window.scrollY;
  document.documentElement.classList.add("xtag-grid-borrowing");
}

function returnWindow(): void {
  if (!borrowed || --borrowed) return;
  document.documentElement.classList.remove("xtag-grid-borrowing");
  window.scrollTo(0, borrowReturnY);
  // The feed's real height came and went under the spacer's feet, so the next
  // measurement starts fresh rather than adding a delta to a stale total.
  lastMaxInner = -1;
  sizeSpacer(true);
  syncScroll();
}

function setStatus(text: string): void {
  // Write only on change: textContent always replaces the text node, and
  // the idle driver re-asserts the status every beat; an unguarded write
  // fed every mutation subscriber a childList record 4x per second.
  if (statusEl && statusEl.textContent !== text) statusEl.textContent = text;
}

// X's theme is chosen IN-APP (default / dim / lights-out), not through the
// OS, so prefers-color-scheme says nothing useful here; read the painted
// background's luminance instead.
function isLightTheme(): boolean {
  const rgb = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
  if (!rgb) return false;
  const [r, g, b] = rgb.map(Number);
  return (r * 299 + g * 587 + b * 114) / 1000 > 128;
}

// --- the layout ------------------------------------------------------------
// The layout is plain JS: walk the grid's children IN DOM ORDER
// (mergeRun keeps that order correct) and flow them into justified rows
// (layoutWideRows). It appends page after page without ever moving a
// placed tile, and needs nothing but each tile's aspect ratio, which
// the payloads carry as original_info.width/height before any image
// loads (the no-shift rule).
//
// Tiles are position:absolute inside .xtag-grid-tiles; the pass writes
// left/top/width/height inline and gives the container its explicit
// height. offsetTop therefore keeps meaning for the driver's content-edge
// math, and stashGrid's DOM-order walk is untouched.
//
// COL_TARGET_PX sizes nothing directly any more; it derives the column
// width a plain grid of this width would have, which is what the row
// height aims near (ROW_TARGET_FACTOR).
const COL_TARGET_PX = 185;
const COL_GAP_PX = 4;
// Aspect clamp: one 10:1 screenshot must not tower over its row, one
// panorama must not vanish into a sliver. Outside the band the tile
// crops (object-fit: cover); the viewer has the full image one click
// away.
const RATIO_MIN = 0.5;
const RATIO_MAX = 2.5;
// Anything wider than 4:3 usually takes the entire row at the grid's
// full width (see layoutWideRows for when it joins a row instead). 4:3
// itself stays an ordinary row member: full-rowing it would turn a
// plain-photos profile into a one-across feed.
const SPAN_RATIO_MAX = 0.75;
// The row shape. Rows aim near the derived column width scaled up a
// touch; the cap bounds the one stretch case (a partial row
// force-closed with a single tile in it), where a lone square would
// otherwise become a grid-width monolith taller than it is wide.
const ROW_TARGET_FACTOR = 1.15;
const ROW_MAX_FRACTION = 0.7;
let layoutTimer = 0;
let lastLayoutWidth = 0;

function tileRatio(el: HTMLElement): number {
  const r = Number(el.dataset.xtagRatio);
  if (!Number.isFinite(r) || r <= 0) return 1;
  return Math.min(Math.max(r, RATIO_MIN), RATIO_MAX);
}

// A tile can outgrow its thumb. `small` fits within 680px on the long
// edge, so a portrait's small variant is only 680/ratio pixels wide,
// and a tile laid out wider than that upscales visibly (the stretched
// final row is the one case left that gets this big). When a layout
// pass hands a tile more CSS width than its small thumb carries, the
// img steps up to `medium` (fits within 1200px), upward only, at most
// once. Thumbs come from the image CDN and spend nothing from the API
// rate bucket; the small thumb stays on screen until the sharper one
// arrives, so the swap never blocks or shifts anything. The RAW ratio
// decides, not tileRatio's clamped one: the thumb has the image's true
// shape whatever the tile shows.
const THUMB_SMALL_EDGE = 680;

function assertThumbScale(el: HTMLElement, cssWidth: number): void {
  const img = el.firstElementChild;
  if (!(img instanceof HTMLImageElement)) return;
  const raw = Number(el.dataset.xtagRatio);
  const ratio = Number.isFinite(raw) && raw > 0 ? raw : 1;
  const smallWidth = ratio > 1 ? THUMB_SMALL_EDGE / ratio : THUMB_SMALL_EDGE;
  if (cssWidth <= smallWidth) return;
  try {
    const url = new URL(img.src);
    if (url.searchParams.get("name") !== "small") return;
    url.searchParams.set("name", "medium");
    img.src = url.toString();
  } catch { /* not a thumb URL we understand; keep it */ }
}

function layoutMosaic(): void {
  if (!gridEl || !overlay) return;
  const width = gridEl.clientWidth;
  if (width <= 0) return;
  lastLayoutWidth = width;
  const cols = Math.min(Math.max(
    Math.floor((width + COL_GAP_PX) / (COL_TARGET_PX + COL_GAP_PX)), 2), 5);
  const colW = (width - COL_GAP_PX * (cols - 1)) / cols;
  // Skeletons lay out only while the loading tail shows; when exhausted
  // they are display:none and must not hold any height.
  const loading = overlay.classList.contains("xtag-grid-loading");
  const children = (Array.from(gridEl.children) as HTMLElement[])
    .filter((child) => loading || !child.classList.contains("xtag-skel"));
  gridEl.style.height =
    `${Math.ceil(layoutWideRows(children, width, colW, loading))}px`;
}

// Justified rows. Fixed-width columns cannot fill every band: with the
// order fixed and the widths fixed, some band always comes up short, so
// the widths are the one degree of freedom that closes every gap. Tiles
// flow into rows in feed order, and every closed row is scaled to one
// shared height at which the widths, kept proportional to each tile's
// aspect, fill the grid exactly. An ordinary row therefore crops
// nothing at all. Wide tiles (ratio < SPAN_RATIO_MAX) take a row of
// their own at their exact ratio, which in a justified layout is just a
// one-tile row; but ONLY when the pending row can close cleanly (empty,
// or stretchable without hitting the rowMax clamp). Otherwise the wide
// tile joins the pending row as its big member and the row flows shut
// normally. Without that rule, a portrait sandwiched between two
// landscapes force-closes alone: stretched to the full grid width,
// clamped by ROW_MAX_FRACTION, it loses about half its height to the
// crop and upscales past its thumb. Absorbed, the same portrait sits
// uncropped beside the landscape.
//
// The one deliberate crop case left is the FINAL row, which stretches
// only once the feed is exhausted, capped by ROW_MAX_FRACTION so no
// tile becomes a grid-width monolith. While loading it keeps natural
// sizes, so the one place a right-edge gap can show is under the
// skeleton shimmer that continues the row. Skeletons never take a wide
// row of their own: a 400px shimmer slab reads as a defect, not as
// loading.
//
// Row closure depends only on the tiles BEFORE the closing point, so an
// appended page can never re-shape a closed row; the no-shift rule
// holds.
function layoutWideRows(children: HTMLElement[], width: number,
                        colW: number, loading: boolean): number {
  const target = colW * ROW_TARGET_FACTOR;
  const rowMax = width * ROW_MAX_FRACTION;
  const aspectOf = (el: HTMLElement): number => 1 / tileRatio(el);
  const naturalH = (tiles: HTMLElement[]): number => {
    const gaps = COL_GAP_PX * (tiles.length - 1);
    return (width - gaps) / tiles.reduce((s, el) => s + aspectOf(el), 0);
  };
  let y = 0;
  let row: HTMLElement[] = [];
  const place = (el: HTMLElement, x: number, w: number, h: number): void => {
    el.style.width = `${w.toFixed(2)}px`;
    el.style.height = `${Math.round(h)}px`;
    el.style.left = `${x.toFixed(2)}px`;
    el.style.top = `${y.toFixed(2)}px`;
    assertThumbScale(el, w);
  };
  const closeRow = (stretch: boolean): void => {
    if (row.length === 0) return;
    const h = stretch ? Math.min(naturalH(row), rowMax) : target;
    const gaps = COL_GAP_PX * (row.length - 1);
    const sumA = row.reduce((s, el) => s + aspectOf(el), 0);
    let x = 0;
    for (let i = 0; i < row.length; i++) {
      // Stretched, the last tile absorbs the float remainder so the row's
      // right edge lands on the grid's to the pixel.
      const w = stretch
        ? (i === row.length - 1
          ? width - x
          : (width - gaps) * (aspectOf(row[i]) / sumA))
        : aspectOf(row[i]) * h;
      place(row[i], x, w, h);
      x += w + COL_GAP_PX;
    }
    y += Math.round(h) + COL_GAP_PX;
    row = [];
  };
  for (const child of children) {
    if (tileRatio(child) < SPAN_RATIO_MAX
      && !child.classList.contains("xtag-skel")
      && (row.length === 0 || naturalH(row) <= rowMax)) {
      closeRow(true);
      const h = Math.round(width * tileRatio(child));
      place(child, 0, width, h);
      y += h + COL_GAP_PX;
      continue;
    }
    row.push(child);
    const h = naturalH(row);
    if (h > target) continue;
    // Close at the count nearer the target height: this row as it
    // stands, or the same row without the newest tile, which then opens
    // the next row.
    const withoutLast = row.length > 1 ? naturalH(row.slice(0, -1)) : Infinity;
    if (withoutLast - target < target - h) {
      const carried = row.pop()!;
      closeRow(true);
      row.push(carried);
    } else {
      closeRow(true);
    }
  }
  closeRow(!loading);
  return Math.max(y - COL_GAP_PX, 0);
}

// Coalesce: a payload page mints ~20 tiles one mergeRun at a time, and a
// harvest batch can teach several ratios in one image-load burst. One
// timeout-zero pass covers them all. Not requestAnimationFrame: a hidden
// tab never paints a frame, and the spacer math reads the laid-out height
// on the driver's own clock.
function scheduleLayout(): void {
  if (layoutTimer) return;
  layoutTimer = window.setTimeout(() => {
    layoutTimer = 0;
    layoutMosaic();
  }, 0);
}

function buildOverlay(): void {
  overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  if (isLightTheme()) overlay.classList.add("xtag-light");
  gridEl = document.createElement("div");
  gridEl.className = "xtag-grid-tiles";
  statusEl = document.createElement("div");
  statusEl.className = "xtag-grid-status";
  // The loading tail: shimmer skeleton tiles while more can still
  // arrive. They are CHILDREN of the tile grid: a separate skeleton grid
  // leaves the last partial row of real tiles hanging beside empty cells
  // with the skeletons in a detached block below. mergeRun keeps real
  // tiles before firstSkel.
  // Varied heights, fixed pattern: the tail should read as a mosaic still
  // arriving, not as a uniform grid bolted under one. (Fixed, not random:
  // a re-render must not shuffle the shimmer.)
  const skelRatios = [1.25, 0.75, 1, 1.4, 0.9, 1.1, 1.55, 0.8, 1, 1.3, 0.7, 1.15];
  for (const ratio of skelRatios) {
    const skel = document.createElement("div");
    skel.className = "xtag-skel";
    skel.dataset.xtagRatio = String(ratio);
    gridEl.appendChild(skel);
    if (!firstSkel) firstSkel = skel;
  }
  // No switcher strip of our own: the grid is page content; scroll up to
  // the real tab bar and use X's own dropdown, which carries the
  // injected Mosaic item.
  overlay.append(gridEl, statusEl);
  overlay.classList.add("xtag-grid-loading");
  // While a dropdown is open through the clip-path hole (see punchHole), a
  // click anywhere else on the grid means click-off: X's own full-viewport
  // backdrop sits UNDER the overlay and can never see it, so forward the
  // close. Capture phase, so a tile under the pointer closes the menu
  // instead of opening; exactly what X's backdrop would do.
  overlay.addEventListener("click", (event) => {
    if (!document.querySelector('[role="menu"]')) return;
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
  }, true);
  // On document.body, nowhere else. insertBefore(document.body, layers)
  // throws on fresh loads (#layers is not a body child there), and any
  // parent inside #react-root is React-owned territory, where the next
  // reconciliation silently discards the overlay while the driver keeps
  // scrolling the page. React never manages body's other children, so
  // body is the one safe parent; the z-index in content.css is what
  // keeps the overlay above the feed.
  document.body.appendChild(overlay);
  placeOverlay();
}

// --- the hole: menus and the hover card -------------------------------------
// A menu can never paint ABOVE a body-level overlay (#layers is a z:1
// context nested inside react-root's z:0; measured), and hiding the
// whole grid for an open dropdown reads as a view switch. So the
// overlay clips a HOLE where the menu is: clip-path's evenodd polygon
// keeps the grid painted everywhere else, and a clipped-away region
// neither paints nor hit-tests, so the menu shows through and takes its
// own clicks. Re-measured per frame while open; X's menus animate in,
// so the rect moves without any DOM mutation to observe.
//
// The profile hover card (the preview X opens over any @handle) is the
// same problem in the same place: it mounts in #layers, so with the
// grid up it painted UNDER the tiles wherever the two overlapped. It
// takes the same hole, and competes on the same overlap terms. Its
// testid node paints the visible sheet itself (opaque background, 16px
// radius; measured), so its measure is a downward walk where the menus
// walk upward from their items.
//
// The hole is cut to the SHEET, not to [role=menu]. A hole bigger than
// the panel it exposes uncovers the photos feed, two ways:
//   1. X's [role=menu] node is a positioned LAYER, and its box is not the
//      panel the reader sees; it can be taller, wider, or the whole
//      viewport, and a padded rect around that clips away most of the grid.
//   2. The panel's corners are ROUNDED, so even an exact rectangle leaves
//      four triangles of feed at the corners, and any padding adds a
//      band of it all the way around.
// So the hole measures the element that actually PAINTS the panel (the
// nearest background-painting ancestor of the items), takes its own
// border-radius, and is cut to exactly that size. The panel's drop
// shadow falls outside and stays covered; a lost shadow is the price,
// and it reads far better than a frame of feed.
let holeRaf = 0;
let holePath = "";
// The hole fades with the menu. Measured on the live menu: X opens its
// dropdowns with a pure OPACITY fade; the panel's box is at full size
// from the first frame. A hole cut in one frame shows tiles snapping to
// black and only then a menu fading in over the black; two stages where
// X's own menus have one. Chrome interpolates same-structure path()
// values in clip-path (verified with a seeked Web Animation; a
// transition on a hidden tab shows nothing), so the hole GROWS from a
// point at the panel's center under a 150ms clip-path transition
// (content.css), in step with the fade, and collapses shut the same
// way when the menu goes.
const HOLE_MS = 150;
let holeClearTimer = 0;
// The last hole's center, in the overlay's own coordinates: the
// collapse target when the menu disappears.
let holeCenter: { x: number; y: number } | null = null;
// Frames in a row that measured no hole. The loop below runs while a menu
// node exists, so this is its stop: a node that never yields a panel is
// not an open dropdown, and a per-frame measure must not outlive it. One
// second is far longer than any X menu takes to animate in.
let holeIdle = 0;
const HOLE_IDLE_FRAMES = 60;

// Everything in #layers that earns a hole. One selector, so presence
// checks and the panel scan can never disagree about what counts.
const HOLE_HOSTS = '[role="menu"], [data-testid="HoverCard"]';

// A background the reader cannot see through. The panel paints one; the
// layers wrapping it do not.
function paintsBackground(el: HTMLElement): boolean {
  const match = /^rgba?\(([^)]+)\)$/.exec(getComputedStyle(el).backgroundColor);
  if (!match) return false;
  const parts = match[1].split(",").map((p) => parseFloat(p));
  return parts.length < 4 || parts[3] >= 1;
}

// The visible panel inside a [role=menu]: walk up from the first item to
// the nearest element that paints a background AND covers every item. The
// containment test is what keeps the walk off a single item; a hovered
// item paints its own background, and a hole cut to it would leave the
// rest of the dropdown buried under the grid.
function menuSheet(menu: HTMLElement, items: DOMRect): HTMLElement {
  const first = menu.querySelector<HTMLElement>('[role="menuitem"]');
  for (let node = first; node; node = node.parentElement) {
    const r = node.getBoundingClientRect();
    if (paintsBackground(node)
      && r.left <= items.left + 1 && r.top <= items.top + 1
      && r.right >= items.right - 1 && r.bottom >= items.bottom - 1) {
      return node;
    }
    if (node === menu) break;
  }
  return menu;
}

// The union of the items' own boxes. It can never be larger than the panel
// they sit in, so it bounds the hole when the walk above lands on a node
// that is still a layer; the shape this whole rewrite exists to contain.
function itemsBox(menu: HTMLElement): DOMRect | null {
  let box: DOMRect | null = null;
  for (const item of Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'))) {
    const r = item.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    box = box
      ? new DOMRect(Math.min(box.x, r.x), Math.min(box.y, r.y),
        Math.max(box.right, r.right) - Math.min(box.x, r.x),
        Math.max(box.bottom, r.bottom) - Math.min(box.y, r.y))
      : r;
  }
  return box;
}

function radiusOf(el: HTMLElement): number {
  const r = parseFloat(getComputedStyle(el).borderTopLeftRadius);
  return Number.isFinite(r) ? r : 0;
}

// The visible card inside a hover-card layer. The testid node paints the
// sheet itself today, so the walk usually ends on its first step; the
// descent is for the day X wraps it in a positioned layer again: follow
// the largest child down until a node paints a background, the same
// test the menus use. Buttons inside the card paint their own
// backgrounds too, but a button is never the largest box on the spine.
function hoverSheet(card: HTMLElement): HTMLElement | null {
  for (let node: HTMLElement | null = card; node;) {
    const r = node.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    if (paintsBackground(node)) return node;
    let next: HTMLElement | null = null;
    let bestArea = 0;
    for (const child of Array.from(node.children)) {
      if (!(child instanceof HTMLElement)) continue;
      const cr = child.getBoundingClientRect();
      if (cr.width * cr.height > bestArea) {
        bestArea = cr.width * cr.height;
        next = child;
      }
    }
    node = next;
  }
  return null;
}

// The open panel's box, in viewport coordinates: a dropdown's sheet or a
// hover card's. The panel that OVERLAPS THE GRID MOST wins, never simply
// the first or last node: X leaves menu nodes mounted elsewhere in
// #layers, and picking one of those aims the hole away from the panel
// the reader just opened.
function holePanel(o: DOMRect): { rect: DOMRect; radius: number } | null {
  let panel: { rect: DOMRect; radius: number } | null = null;
  let best = 0;
  for (const menu of Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]'))) {
    const items = itemsBox(menu);
    if (!items) continue;
    const sheet = menuSheet(menu, items);
    const rect = sheet.getBoundingClientRect();
    const fits = rect.width > 0 && rect.height > 0
      && rect.width * rect.height <= items.width * items.height * 4;
    const candidate = fits
      ? { rect, radius: radiusOf(sheet) }
      : { rect: pad(items, 8), radius: 12 };
    const overlap = overlapArea(candidate.rect, o);
    if (overlap > best) {
      panel = candidate;
      best = overlap;
    }
  }
  for (const card of Array.from(document.querySelectorAll<HTMLElement>('[data-testid="HoverCard"]'))) {
    const sheet = hoverSheet(card);
    if (!sheet) continue;
    const rect = sheet.getBoundingClientRect();
    const overlap = overlapArea(rect, o);
    if (overlap > best) {
      panel = { rect, radius: radiusOf(sheet) };
      best = overlap;
    }
  }
  return panel;
}

function pad(rect: DOMRect, by: number): DOMRect {
  return new DOMRect(rect.x - by, rect.y - by, rect.width + by * 2, rect.height + by * 2);
}

function overlapArea(a: DOMRect, b: DOMRect): number {
  const wide = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const tall = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return wide > 0 && tall > 0 ? wide * tall : 0;
}

// The overlay's whole box, minus a rounded rectangle: evenodd makes the
// inner subpath the hole. Coordinates are px in the overlay's own border
// box, which is what clip-path measures from.
function holeShape(o: DOMRect, x1: number, y1: number, x2: number, y2: number,
                   radius: number): string {
  const n = (v: number): string => v.toFixed(2);
  const r = Math.max(Math.min(radius, (x2 - x1) / 2, (y2 - y1) / 2), 0);
  const outer = `M0 0H${n(o.width)}V${n(o.height)}H0Z`;
  const arc = (x: number, y: number): string => `A${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y)}`;
  const hole = r > 0
    ? `M${n(x1 + r)} ${n(y1)}H${n(x2 - r)}${arc(x2, y1 + r)}V${n(y2 - r)}`
      + `${arc(x2 - r, y2)}H${n(x1 + r)}${arc(x1, y2 - r)}V${n(y1 + r)}${arc(x1 + r, y1)}Z`
    : `M${n(x1)} ${n(y1)}H${n(x2)}V${n(y2)}H${n(x1)}Z`;
  return `path(evenodd, "${outer} ${hole}")`;
}

// A near-zero hole at (x, y), in the same command structure as a real
// one, so the clip-path transition can interpolate between them. The
// epsilon size matters: a truly zero hole clamps its radius to 0 and
// holeShape then emits the arc-free rectangle path, whose command list
// does not match the rounded one, and non-matching paths do not
// interpolate; the transition would snap.
function collapsedHole(x: number, y: number): string {
  if (!overlay) return "";
  return holeShape(overlay.getBoundingClientRect(),
    x - 0.01, y - 0.01, x + 0.01, y + 0.01, 0.01);
}

function setHole(path: string, center: { x: number; y: number } | null = null): void {
  if (!overlay || path === holePath) return;
  window.clearTimeout(holeClearTimer);
  holeClearTimer = 0;
  if (path === "") {
    // Collapse shut where the hole was, then drop the clip entirely
    // once the transition has run; an overlay with no menu open must
    // not keep a clip-path for the compositor to chew on.
    holePath = "";
    if (holeCenter) {
      overlay.style.clipPath = collapsedHole(holeCenter.x, holeCenter.y);
      const el = overlay;
      holeClearTimer = window.setTimeout(() => {
        if (overlay === el && holePath === "") el.style.clipPath = "";
      }, HOLE_MS + 40);
    } else {
      overlay.style.clipPath = "";
    }
    return;
  }
  // Grow from nothing: a fresh hole seeds its collapsed shape first and
  // flushes, so the transition has a start value in the same frame.
  if (holePath === "" && center) {
    overlay.style.clipPath = collapsedHole(center.x, center.y);
    void overlay.offsetWidth;
  }
  holePath = path;
  overlay.style.clipPath = path;
  if (center) holeCenter = center;
}

// How long a mounted menu may measure EMPTY before the hole collapses.
// React's rewrap swaps the items shortly after the menu opens, and for
// a frame or two nothing measures; collapsing on that makes the growing
// hole pulse shut and regrow. Ten frames is far past any swap and far
// short of the reader noticing a stale hole under a menu that truly
// emptied.
const HOLE_EMPTY_GRACE = 10;

function punchHole(): void {
  if (!overlay) return;
  if (!active || !onPhotosFeed()) {
    holeIdle++;
    setHole("");
    return;
  }
  const o = overlay.getBoundingClientRect();
  const panel = holePanel(o);
  if (!panel) {
    holeIdle++;
    // No host node at all is a CLOSE: collapse now (the loop stops with
    // the node gone, so a deferred collapse would strand the hole). A
    // MOUNTED host measuring empty is React swapping its items; hold
    // through the grace instead.
    if (!document.querySelector(HOLE_HOSTS) || holeIdle > HOLE_EMPTY_GRACE) {
      setHole("");
    }
    return;
  }
  holeIdle = 0;
  const m = panel.rect;
  // The overlapping part decides WHETHER to clip: a menu outside the
  // overlay's box (sidebar menus, the account switcher) overlaps nothing
  // and gets no clip, and a hole that would take most of the grid with it
  // is not this dropdown either; leave the grid whole rather than uncover
  // the feed.
  if (overlapArea(m, o) > o.width * o.height * 0.7) {
    setHole("");
    return;
  }
  // The hole itself is cut UNCLAMPED, at the panel's true corners. Clamping
  // the coordinates would round a corner the reader cannot see; the media
  // dropdown opens at the tab bar, so its top edge sits above the overlay;
  // and that rounding leaves a wedge of grid over the panel. Whatever falls
  // outside the overlay's own box paints nothing anyway.
  const x1 = m.left - o.left;
  const y1 = m.top - o.top;
  const x2 = m.right - o.left;
  const y2 = m.bottom - o.top;
  setHole(holeShape(o, x1, y1, x2, y2, panel.radius),
    { x: (x1 + x2) / 2, y: (y1 + y2) / 2 });
}

// The loop runs while a HOST is mounted (a menu or a hover card), not
// while a hole exists. X's dropdown animates in, and mid-animation its
// items measure 0x0; so the first punch after the menu mounts finds
// nothing to cut. Keyed on the hole, the loop never starts, and the
// menu stays buried under the grid until the next mutation batch
// happens to punch again. Keyed on the host, the next frame measures
// the finished panel and the hole opens on its own.
function syncHole(): void {
  // A mutation batch with no loop running is a fresh look at the page: give
  // the next host its full patience again.
  if (!holeRaf) holeIdle = 0;
  punchHole();
  const open = (): boolean => Boolean(overlay) && active
    && holeIdle <= HOLE_IDLE_FRAMES
    && document.querySelector(HOLE_HOSTS) !== null;
  if (holeRaf || !open()) return;
  const tick = (): void => {
    punchHole();
    holeRaf = open() ? requestAnimationFrame(tick) : 0;
  };
  holeRaf = requestAnimationFrame(tick);
}

// Tiles load X's `small` variant (fits within 680px, aspect preserved),
// never the full-size rendition and never a square crop: a square crop
// displayed in a true-ratio box re-crops twice, and a tile with no
// payload ratio learns its ratio from this very thumbnail's natural
// size, which a crop would falsify.
function thumbSrc(src: string): string {
  try {
    const url = new URL(src, location.origin);
    if (url.hostname === "pbs.twimg.com" && url.pathname.startsWith("/media/")) {
      url.searchParams.set("name", "small");
      return url.toString();
    }
  } catch { /* not a URL we understand; use it as-is */ }
  return src;
}

// Open a tile: click the FEED'S OWN photo anchor when that anchor is at
// hand, and deep-link when it is not. Either way X opens the photo
// viewer as a modal over the photos feed; its close is a history.back()
// to the feed; and the grid never deactivates: the path watcher merely
// hides the overlay while the viewer route is up, so backing out of the
// image lands in the grid exactly as it was.
//
// The anchor ride is taken only when it is CHEAP. The loader asks X by
// cursor (see the driveLoop comment) and the feed underneath stays
// clipped, so X's own timeline holds only its shallow passive pages;
// hunting a deep cell would make X fetch its way down one page at a
// time, seconds of waiting spent out of the very rate bucket the floor
// protects. pushPhotoRoute, which costs one TweetDetail fetch, carries
// the rest. Three steps, cheapest first, and every one of them ends in
// the same viewer:
//
//   1. The anchor is mounted: click it, no borrow, no movement at all.
//   2. The tile has a cellY, so X held this cell once: one jump, RIDE_MS
//      of patience for the remount.
//   3. Anything else: deep-link.
//
// A tile with no cellY is one whose cell X has never mounted; that is
// the cell a hunt would spend seconds failing to reach.
const RIDE_MS = 400;

async function openTile(tile: Tile): Promise<void> {
  if (navigating) return;
  navigating = true;
  // The clicked tile dims while the ride runs; without it a click that
  // waits on a remount looks ignored.
  tile.el?.classList.add("xtag-tile-opening");
  try {
    const find = (): HTMLAnchorElement | null => {
      const col = primaryColumn();
      // tile.href is page data; the harvest reads the raw href ATTRIBUTE
      // off X's anchors; and it is interpolated into a quoted attribute
      // selector, where an unescaped quote ends the string early and throws
      // a SyntaxError out of the click. Escaping the two characters a CSS
      // string cares about is the exact fix; CSS.escape is for identifiers,
      // not for the inside of a quoted value.
      const wanted = tile.href.replace(/["\\]/g, "\\$&");
      return col?.querySelector<HTMLAnchorElement>(
        `a[href="${wanted}" i]`) ?? null;
    };
    // Step 1. The clip is visibility + overflow, never display (see the CSS),
    // so a mounted anchor is a live node with a live React handler: the click
    // reaches X's router without the window moving a pixel.
    const mounted = find();
    if (mounted) {
      mounted.click();
      return;
    }
    // Step 2. The ride needs the window and the feed at its true height, and
    // the reader owns both now; so they are borrowed and put back. The click
    // happens INSIDE the borrow: returning re-clips the feed, and X unmounts
    // cells when it does, which would leave the anchor detached and the click
    // doing nothing at all.
    if (tile.cellY !== undefined) {
      borrowWindow();
      try {
        window.scrollTo(0, Math.max(tile.cellY - window.innerHeight / 3, 0));
        const anchor = await pollFor(find, RIDE_MS);
        // The grid deactivated mid-ride (Escape, a tab click, the popup
        // switch): the feed is VISIBLE now and the ride was yanking its
        // scroll around; abort rather than click an anchor on a view the
        // reader already left.
        if (!active) return;
        if (anchor) {
          anchor.click();
          return;
        }
      } finally {
        returnWindow();
      }
      if (!active) return;
    }
    // Step 3. No anchor to ride: deep-link, but the grid STAYS UP (hidden by
    // the path watcher, exactly as on the anchor path) so the close lands the
    // reader back in the grid it left rather than rebuilding it.
    pushPhotoRoute(tile.href);
  } finally {
    tile.el?.classList.remove("xtag-tile-opening");
    navigating = false;
  }
}

// The deep link must carry X's own history state. Measured live on
// x.com: when X's own feed anchor opens the photo viewer it pushes
// `{ key, state: { fromApp: true, previousPath: "/h/media?filter=photo" } }`,
// and the viewer's close reads that entry. With a previousPath it does
// history.back(); the grid returns untouched. With no previousPath (a
// bare `pushState({})`) the close instead PUSHES the tweet's status
// page (X's own state names that branch `usedFallback: true`), so both
// ways out of the viewer strand the reader on that photo's tweet with
// the grid gone, and Back only walks them into the viewer again.
// (Browser Back always works; X's viewer ignores Escape entirely, on
// this path and on the anchor path alike.)
//
// Deep-linking is the ordinary way a tile opens (at the top of a feed
// only the first ~6 tiles have a mounted anchor, measured), so the
// state below is load-bearing rather than a fallback's courtesy. If X
// ever changes the shape it pushes, this is what has to follow it.
//
// The synthetic popstate carries history.state, never a fresh `{}`: X's
// router reads event.state, and handing it a state that disagrees with
// the entry we just pushed is the same lie one level down.
function pushPhotoRoute(href: string): void {
  const previousPath = location.pathname + location.search;
  const key = Math.random().toString(36).slice(2, 8);
  history.pushState({ key, state: { fromApp: true, previousPath } }, "", href);
  window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
}

function makeTileEl(tile: Tile): HTMLAnchorElement {
  const a = document.createElement("a");
  a.className = tile.video ? "xtag-tile xtag-tile-video" : "xtag-tile";
  a.href = tile.href;
  // The tile's identity on the element itself: stashGrid serializes the
  // order it can SEE by walking these children, and the skeleton tiles,
  // which carry no id, drop out of that walk for free.
  a.dataset.xtagId = tile.href.toLowerCase();
  // The layout's input, on the element the layout pass walks. A tile
  // without one lays out square until its thumbnail teaches the truth.
  if (tile.ratio !== undefined) a.dataset.xtagRatio = String(tile.ratio);
  const img = document.createElement("img");
  img.src = thumbSrc(tile.src);
  // EVERY tile fetches eagerly (lazy loading lets a fast reader outrun
  // the fetches into black boxes): this is naturally bounded, because a
  // tile only exists once the driver has walked its cell, and the driver
  // only walks ~bufferPx() ahead of the reader. Cache-restored tiles are
  // bounded by having been loaded once already.
  img.loading = "eager";
  img.decoding = "async";
  img.alt = "";
  // The tile shimmers (CSS) until its image has painted. A failed fetch
  // gets ONE delayed retry (pbs blips happen, and without it the tile is
  // a permanent dark box); a second failure ends the shimmer; a dead
  // thumb must not pulse forever.
  const ready = (): void => {
    a.classList.add("xtag-tile-ready");
    // A harvest-minted tile carries no payload ratio; the `small` thumb
    // preserves aspect, so its natural size IS the ratio. One relayout per
    // lesson, coalesced; the burst of loads after a harvest is one pass.
    if (tile.ratio === undefined && img.naturalWidth > 0) {
      tile.ratio = img.naturalHeight / img.naturalWidth;
      a.dataset.xtagRatio = String(tile.ratio);
      scheduleLayout();
    }
  };
  if (img.complete && img.naturalWidth > 0) {
    ready();
  } else {
    img.addEventListener("load", ready);
    img.addEventListener("error", () => {
      if (!img.dataset.retried) {
        img.dataset.retried = "1";
        const src = img.src;
        window.setTimeout(() => {
          img.removeAttribute("src");
          img.src = src;
        }, 1200);
        return;
      }
      ready();
    });
  }
  a.appendChild(img);
  a.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    void openTile(tile);
  });
  return a;
}

// --- placing tiles: run merging --------------------------------------------
// EVERY source of tiles hands over a RUN; photos it knows to be in feed
// order, newest first. The harvest reads its cells in translateY order and
// each cell's anchors in DOM order; a timeline payload lists its tweets in
// feed order and each tweet's photos in index order; the cache replays the
// order that was last on screen. So the merge never has to compare a tile
// against a number, only to splice a run into the order already on screen.
//
// The photos in a run that the grid ALREADY holds are the anchors: they say
// where the run sits. New photos go immediately before the next anchor, and
// whatever is left over at the end goes just after the last one. A 4-photo
// post is contiguous inside its cell's run, so its four tiles can never be
// split apart.
interface Draft {
  href: string;
  // Null when the feed cell has mounted the anchor but has not painted its
  // <img> yet. Such a photo cannot become a tile (there is nothing to
  // show), but if the grid already holds it, it still ANCHORS the run.
  src: string | null;
  video: boolean;
  ratio?: number;
  cellY?: number;
}

// Is this tile placed in the grid right now? A tile minted earlier in the
// same run is in `tiles` but still waiting in `pending`, and using one of
// those as an insert reference would throw.
function placed(tile: Tile | undefined): tile is Tile & { el: HTMLAnchorElement } {
  return Boolean(tile?.el && tile.el.parentElement === gridEl);
}

// Where a run that shares NO photo with the grid belongs. The driver walks
// the feed forward, so the answer is nearly always the tail; and for a
// payload or cache run, which carries no feed coordinate, the tail is the
// whole answer. A HARVESTED run is different: the window can jump back over
// cells whose photos never painted, and appending those to the end of
// the grid scrambles it. Such a run knows its own translateY, so
// bracket it against the tiles that carry one.
//
// The bracket is TWO-SIDED. The near side alone; "before the first tile
// that sits lower in the feed"; answers nothing for a run past every tile
// the harvest has a coordinate for, which is exactly the case that needs an
// answer: when X serves a timeline page from its own client cache the
// interceptor never sees it, so only the harvest can find those photos, and
// it reaches them long after the payloads for the pages below have minted
// their tiles. Those tiles carry no coordinate to compare against, so the
// far side; after the last tile still above the run; is what keeps the
// page in its place.
function tailRefFor(cellY: number | undefined): Node | null {
  if (cellY === undefined || !gridEl) return firstSkel;
  let after: Node | null = null;
  for (const child of Array.from(gridEl.children) as HTMLElement[]) {
    const id = child.dataset.xtagId;
    const y = id ? tiles.get(id)?.cellY : undefined;
    if (y === undefined) continue;
    if (y > cellY) return child;
    after = child.nextSibling;
  }
  return after ?? firstSkel;
}

function mergeRun(run: Draft[]): number {
  if (!gridEl) return 0;
  let added = 0;
  let pending: Tile[] = [];
  // The last anchor matched, or null while the run has not reached one.
  let anchor: HTMLAnchorElement | null = null;
  // Insert before `before`; the anchor the pending tiles precede, or the
  // grid's own tail. "The tail" means BEFORE the first skeleton: the
  // skeletons are trailing children of this same grid.
  const flush = (before: Node | null): void => {
    for (const tile of pending) gridEl!.insertBefore(tile.el!, before);
    pending = [];
  };
  for (const draft of run) {
    const id = draft.href.toLowerCase();
    const known = tiles.get(id);
    if (placed(known)) {
      flush(known.el);
      anchor = known.el;
      // A payload- or cache-minted tile whose feed cell just mounted: adopt
      // the cell position, so a click can ride the real anchor from here on.
      if (draft.cellY !== undefined) known.cellY = draft.cellY;
      // The reverse hand-me-down: a harvest-minted tile whose payload just
      // arrived learns its true ratio from original_info, one relayout.
      if (draft.ratio !== undefined && known.ratio === undefined) {
        known.ratio = draft.ratio;
        known.el.dataset.xtagRatio = String(draft.ratio);
        scheduleLayout();
      }
      continue;
    }
    // Already minted earlier in THIS run: X repeats the first photo of a
    // multi-photo post (entities.media beside extended_entities.media), and
    // a stale cell can repeat a whole post.
    if (known || draft.src === null) continue;
    const tile: Tile = {
      href: draft.href, src: draft.src, video: draft.video,
      ratio: draft.ratio, cellY: draft.cellY,
    };
    tile.el = makeTileEl(tile);
    tiles.set(id, tile);
    pending.push(tile);
    added++;
  }
  // Whatever is left over follows the last anchor. A run that matched no
  // anchor at all has to be placed by its own feed coordinate instead.
  flush(anchor ? anchor.nextSibling : tailRefFor(pending[0]?.cellY));
  if (added > 0) scheduleLayout();
  return added;
}

// --- harvesting ------------------------------------------------------------

function cellOrder(cell: HTMLElement): number {
  const match = /translateY\((-?[\d.]+)px\)/.exec(cell.getAttribute("style") ?? "");
  return match ? parseFloat(match[1]) : Number.MAX_SAFE_INTEGER;
}

function harvest(): number {
  const col = primaryColumn();
  if (!col) return 0;
  // BY translateY, NOT by document order. The virtualizer recycles its cell
  // nodes, so the mounted cells sit in the DOM in whatever order React last
  // reused them; only the transform says where a cell really is in the
  // feed, and the run below has to be in feed order to merge correctly.
  const cells = Array.from(col.querySelectorAll<HTMLElement>('[data-testid="cellInnerDiv"]'))
    .map((cell) => ({ cell, y: cellOrder(cell) }))
    .filter((c) => c.y !== Number.MAX_SAFE_INTEGER)
    .sort((a, b) => a.y - b.y);
  const run: Draft[] = [];
  for (const { cell, y } of cells) {
    // Each photo wraps its own /status/<id>/photo/<n> anchor; one tile per
    // photo, which is exactly how the old grid tiled a 4-photo post.
    cell.querySelectorAll<HTMLAnchorElement>('a[href*="/photo/"]').forEach((a) => {
      const href = a.getAttribute("href");
      if (!href) return;
      // Only the profile owner's own media: at an SPA transition the LEAVING
      // view's cells can still be mounted for a beat, and a retweet's photo
      // anchor names the ORIGINAL poster; the handle prefix keeps both out.
      // (The owner's own stale post-photos pass, and that is fine: the media
      // feed re-serves the same hrefs and the tile map dedupes them.)
      if (!href.toLowerCase().startsWith(`/${gridHandle}/status/`)) return;
      run.push({
        href,
        src: a.querySelector("img")?.getAttribute("src") ?? null,
        video: Boolean(a.closest('[data-testid="videoComponent"]')),
        cellY: y,
      });
    });
  }
  return mergeRun(run);
}

// --- the API prefill -------------------------------------------------------
// Two requirements, a full grid on the first click AND zero page
// shifting, cannot both be met by DOM harvesting: the virtualizer only
// mounts and fetches what the window scroll reaches, so any
// scroll-driven prefill IS the shift. The initial screens therefore come
// from X's own timeline API: the page already fetched a UserMedia page to
// render this very feed, resource timing carries that request's full URL
// (query ids, variables, feature flags; everything), and the prefill
// REPLAYS it with a paged cursor. Same session, same request shape, same
// data the reader is looking at; display-only, nothing stored. Every step
// degrades gracefully to the harvest-only behavior, and a console.warn
// names the reason (X has been rolling out signed x-client-transaction-id
// headers on some GraphQL routes; if UserMedia starts enforcing them,
// the replay 404s and this whole block quietly stands down).

interface ApiMedia { href: string; src: string; video: boolean; ratio?: number; }

// --- observing the page's own GraphQL traffic ------------------------------
// Resource timing's default buffer is 250 ENTRIES and an X page burns
// through that in seconds (avatars, thumbnails, video segments), so
// getEntriesByType() misses the feed's own request more often than it
// sees it. A PerformanceObserver keeps receiving entries after the
// buffer is full; registered at init, with buffered replay for requests
// that happened before us.
interface SeenRequest { name: string; startTime: number; }
const graphqlSeen: SeenRequest[] = [];

function watchGraphql(): void {
  try {
    performance.setResourceTimingBufferSize(32768);
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.name.includes("/graphql/")) continue;
        graphqlSeen.push({ name: entry.name, startTime: entry.startTime });
        if (graphqlSeen.length > 64) graphqlSeen.shift();
      }
    }).observe({ type: "resource", buffered: true });
  } catch (error) {
    console.warn("[xtag] graphql observer failed:", error);
  }
}

function opNameOf(url: string): string {
  const match = /\/graphql\/[^/]+\/([^/?]+)/.exec(url);
  return match ? match[1] : "?";
}

// The photos feed's op is "UserPhotoTimeline" (measured live; beside
// UserVideoTimeline and UserOriginalsTimeline; nothing called
// "UserMedia" fires on this route any more). "Media" stays as the
// fallback for older naming. A wrong pick is harmless: the owner filter
// discards foreign media and the page loop stops on an empty page.
const MEDIA_OP_RE = /PhotoTimeline|Media/;

function latestMediaTemplate(since: number): string | null {
  for (let i = graphqlSeen.length - 1; i >= 0; i--) {
    const seen = graphqlSeen[i];
    if (seen.startTime >= since && MEDIA_OP_RE.test(opNameOf(seen.name))) {
      return seen.name;
    }
  }
  return null;
}

function csrfToken(): string {
  const match = /(?:^|;\s*)ct0=([^;]+)/.exec(document.cookie);
  return match ? match[1] : "";
}

// --- intercepted payloads --------------------------------------------------
// The MAIN-world interceptor (interceptor.ts) dispatches every
// photos-timeline response body the PAGE fetches. While the grid is active
// they mint tiles directly; which is also what makes deep loading fast:
// tiles arrive at fetch speed instead of render-harvest speed, and the
// driver only has to make X fetch (one bottom hop per ~20 photos) rather
// than walk every viewport. Payloads that arrive before activation are
// buffered briefly (the page fetches the feed around the same moment the
// grid comes up).
let payloadSeen = false;
let payloadTemplate: string | null = null;
let payloadCursor: string | null = null;
let apiCooldownUntil = 0;
// True while payloadCursor is OURS; restored from the cache, or advanced by
// the extension below. Passive page-1 payloads must not rewind it: photos
// timelines only prepend, so a deep cursor stays valid, and new posts arrive
// on page 1 which the interceptor mints anyway.
//
// It covers the extension, not just the cache, and it has to. The feed
// under the grid is clipped, which keeps X fetching its own hidden
// pages; and every one of those payloads would rewind our cursor to X's
// shallow position. We would then re-ask for pages we already had: the
// fetches return twenty photos each and mint no new tile, the loop
// reads that as no progress, and a deep profile ends early (measured: a
// 297-photo profile stopped at 79).
let cursorOurs = false;
// When a PASSIVE page last minted a new tile. X's own client crawls
// this same feed behind the clip (the reader's scroll drives its
// virtualizer) and cannot be stopped; while its pages are delivering
// new tiles, a cursor extension of ours buys the same depth twice.
// The driver yields to a fresh passive page (see driveLoop) so there
// is one buyer at a time.
let lastPassiveProgressAt = 0;
const PASSIVE_QUIET_MS = 4000;
// The cursor path has answered with something other than a page, so deep
// loading falls back to driving the window until the next activation. Kept
// apart from cursorOurs, which answers a different question (whose cursor
// outranks whose) and must not be cleared by a failure here.
//
// Why the cursor path is the default, and it is not about saving
// requests: the page's own scrollbar is the reader's, so the window is
// not ours to walk. Driving asks X for a page by scrolling until X
// decides to fetch one; extending asks for the same page directly, from
// the same session, against the same bucket. One page either way; what
// changes is who holds the scroll while it happens. The bucket is still
// the hazard (a few active pages at once can empty it and 429 X's own
// feeds), so this stays behind the rate floor and the drive's pacing.
let extendBroken = false;
// One replay on the wire at a time. apiPrefill and the driver's cursor
// extension are independent async paths that ask with the SAME cursor,
// so overlapping them buys one page twice; each holds this flag across
// its fetch (retries included) and stands down while the other has it.
let replayInFlight = false;
// The API said the timeline is over: a TimelineTerminateTimeline(Bottom)
// instruction in a payload, or a cursor that echoes past every retry.
// This is what lets the skeleton tail settle in one beat instead of
// waiting out ~6s of stall patience.
let feedEnded = false;
// Several conditions can end a feed, and from the outside every one
// looks the same: the skeletons stop and a count sits there. The reason
// is recorded for the spend receipt; first writer wins.
let feedEndReason = "";
function endFeed(reason: string): void {
  if (!feedEndReason) feedEndReason = reason;
  feedEnded = true;
}
let emptyPages = 0;
// --- the cursor echo is ambiguous ------------------------------------------
// An empty page whose Bottom cursor equals the cursor that asked for it
// has TWO meanings, indistinguishable on sight: the true end (no
// terminate instruction, just the echo past the last content page), or
// a mid-feed STALL (measured live: one grid ended itself at 102 photos
// on one echo while X's own feed read straight past to 148+; the photo
// filter runs server-side over the media timeline, and an echo can mean
// "nothing matched this scan window, ask again", which X's own client
// retries). The only way to tell the end from a stall is to ask again:
// the same cursor gets ECHO_RETRIES more asks, spaced out (a stall is
// transient; hammering the same cursor 180ms apart re-asks the same
// overloaded shard), and only a cursor that echoes every time is the
// end. The price is ECHO_RETRIES requests at every profile's true end.
// Do not simplify this back to single-echo-ends.
const ECHO_RETRIES = 2;
const ECHO_RETRY_MS = 1500;
let stallCursor: string | null = null;
let stallCount = 0;

// One echo observed for `cursor`. Returns true when the echo count says
// this is the real end. Progress through noteCursorProgress resets it.
function noteCursorEcho(cursor: string, source: string): boolean {
  if (cursor === stallCursor) stallCount++;
  else { stallCursor = cursor; stallCount = 1; }
  if (stallCount > ECHO_RETRIES) {
    endFeed(`cursor echoed ${stallCount}x (${source})`);
    return true;
  }
  console.info(`[xtag] mosaic: cursor echo ${stallCount}/${ECHO_RETRIES + 1} `
    + `(${source}); retrying before calling it the end`);
  return false;
}

function noteCursorProgress(): void {
  stallCursor = null;
  stallCount = 0;
}
const payloadBuffer: { url: string; body: string; at: number; handle: string }[] = [];

// X's OWN media total per handle, from the UserByScreenName responses the
// interceptor forwards (legacy.media_count; exact, locale-free; the top
// bar's "N photos & videos" TEXT was rejected: it carries no testid and
// localized abbreviations like "12 हज़ार" or "12万" parse as small
// integers, which would false-end big profiles). It is a CEILING: the
// count includes videos, so tiles can reach it only when the photos
// feed is complete. This is the end signal that needs NO timeline
// payload and NO dock; without it a 1-photo profile shimmers forever,
// because the stall settle is dock-only by design, and a feed X serves
// from its client cache fetches nothing to read an end from. Keyed map,
// so it survives SPA hops and grid re-activations.
const profileMediaCounts = new Map<string, number>();
const PROFILE_COUNTS_MAX = 50;

function applyProfileCount(body: string): void {
  try {
    const scan = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(scan); return; }
      if (!node || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      if (typeof obj["screen_name"] === "string"
        && typeof obj["media_count"] === "number") {
        if (profileMediaCounts.size >= PROFILE_COUNTS_MAX) {
          const oldest = profileMediaCounts.keys().next().value;
          if (oldest !== undefined) profileMediaCounts.delete(oldest);
        }
        profileMediaCounts.set(
          obj["screen_name"].toLowerCase(), obj["media_count"]);
      }
      Object.values(obj).forEach(scan);
    };
    scan(JSON.parse(body));
  } catch { /* not a profile payload after all */ }
}

function noteRateHeaders(remaining: string | null, reset: string | null,
  limit: string | null = null): void {
  if (limit !== null && limit !== "") {
    const n = Number(limit);
    if (Number.isFinite(n) && n > 0) rateLimit = n;
  }
  if (remaining !== null && remaining !== "") {
    const n = Number(remaining);
    if (Number.isFinite(n)) {
      rateRemaining = n;
      if (rateLow === null || n < rateLow) rateLow = n;
    }
  }
  if (reset !== null && reset !== "") {
    const t = Number(reset);
    if (Number.isFinite(t) && t > 0) rateResetAt = t * 1000;
  }
  saveRateState();
  assertQuotaPill();
}

function noteRate429(): void {
  apiCooldownUntil = Math.max(apiCooldownUntil, Date.now() + API_COOLDOWN_MS);
  rateRemaining = 0;
  last429At = Date.now();
  // A headerless 429 still pauses: a 15-min window is X's standard.
  if (rateResetAt < Date.now()) rateResetAt = Date.now() + 15 * 60_000;
  saveRateState();
  assertQuotaPill();
}

// --- the rate picture survives the page (same tab) -------------------------
// The bucket is X's per-account window, but this module's picture of it
// used to live only as long as the page. A reload while limited forgot
// the 429s, and X's own client BACKS OFF after one (it can stop asking
// entirely), so nothing re-taught them: the driver then read the dead
// air as a complete feed and stall-ended a 4-photo grid in silence,
// while the native view showed X's error with no note. The picture is
// mirrored into sessionStorage (per tab; nothing leaves the page) and
// restored at boot; an entry expires with the window it describes.
const RATE_STATE_KEY = "xtag:rate";

function saveRateState(): void {
  try {
    sessionStorage.setItem(RATE_STATE_KEY, JSON.stringify({
      remaining: rateRemaining, resetAt: rateResetAt, last429At,
      cooldownUntil: apiCooldownUntil, limit: rateLimit,
    }));
  } catch { /* private mode etc.; the page-lifetime picture still works */ }
}

function loadRateState(): void {
  try {
    const raw = sessionStorage.getItem(RATE_STATE_KEY);
    if (!raw) return;
    const s = JSON.parse(raw) as Record<string, unknown>;
    const resetAt = typeof s["resetAt"] === "number" ? s["resetAt"] : 0;
    // The window it described is over; the next response teaches afresh.
    if (Date.now() >= resetAt) return;
    rateResetAt = resetAt;
    if (typeof s["remaining"] === "number") rateRemaining = s["remaining"];
    // The pill's denominator; without it a reloaded page shows the
    // "N left" fallback until a fresh response carries the header.
    if (typeof s["limit"] === "number" && s["limit"] > 0) rateLimit = s["limit"];
    if (typeof s["last429At"] === "number") last429At = s["last429At"];
    if (typeof s["cooldownUntil"] === "number") {
      apiCooldownUntil = Math.max(apiCooldownUntil, s["cooldownUntil"]);
    }
  } catch { /* a corrupt entry teaches nothing */ }
}

// Low-budget pacing: our pages slow down as the bucket drains, so a
// deep scroll burns smoothly toward the floor instead of racing there,
// and X's own client keeps room between our pages.
function drivePaceMs(): number {
  return rateRemaining !== null && rateRemaining <= 25 ? 1200 : DRIVE_STEP_MS;
}

// Non-zero = the driver must not cause fetches until this epoch-ms time.
function ratePauseUntil(): number {
  if (rateRemaining === null || rateRemaining > RATE_FLOOR) return 0;
  if (Date.now() >= rateResetAt) {
    // The window rolled over; the next response re-teaches the budget.
    rateRemaining = null;
    return 0;
  }
  return rateResetAt;
}

// The visit's receipt, logged when the mosaic closes. Read it after a
// normal read of a profile before theorizing about the bucket.
function logSpend(): void {
  if (ownPages === 0 && passivePages === 0) return;
  const secs = Math.max(1, Math.round((Date.now() - spendStartedAt) / 1000));
  const budget = rateLimit === null
    ? "budget unknown (no x-rate-limit-limit seen)"
    : `${rateRemaining ?? "?"}/${rateLimit} left`
      + (rateLow !== null ? `, low-water ${rateLow}` : "");
  const share = rateLimit !== null && rateLimit > 0
    ? ` = ${(ownPages / rateLimit * 100).toFixed(1)}% of the window`
    : "";
  const perReq = ownPages > 0
    ? ` (${(ownAdded / ownPages).toFixed(1)} new/request, `
      + `${(ownPhotos / ownPages).toFixed(1)} found/request, count=${PAGE_COUNT})`
    : "";
  const stated = profileMediaCounts.get(gridHandle);
  const why = feedEndReason
    ? `; ended: ${feedEndReason}`
    : (exhausted ? "; ended: unrecorded" : "; still loading");
  console.info(`[xtag] mosaic spend on /${gridHandle}: ${ownPages} request(s) `
    + `of ours${share}${perReq}, ${passivePages} passive, ${tiles.size} photos, `
    + `${secs}s; ${budget}`
    + `${stated === undefined ? "" : `, X states media_count=${stated}`}${why}`);
}

function fmtTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// "1 photo", never "1 photos".
function nphotos(n: number): string {
  return n === 1 ? "1 photo" : `${n} photos`;
}

// The settled line. A grid with tiles counts them. Empty, it depends
// on why: when X itself says the profile HAS media (media_count) and
// still sent none, the feed is withheld, not absent (X soft-throttles
// an account by answering photo timelines with empty pages while the
// budget headers stay healthy; measured live). Saying "No photos
// here." then is a lie; say what happened instead.
function settleStatus(): string {
  if (tiles.size > 0) return nphotos(tiles.size);
  const stated = profileMediaCounts.get(gridHandle);
  // The AFFIRMATIVE empty (terminate on an empty page 1, and the
  // UserMedia fallback found nothing either or could not run): the
  // timeline is empty by X's own word, not withheld by a throttle, so
  // "try again later" would be a false promise. GIF-only and
  // video-only profiles land here when the fallback comes up dry.
  if (feedEndReason.includes("empty timeline")) {
    return stated !== undefined && stated > 0
      ? `X serves none of this profile's ${stated} media as photos`
      : "X sent an empty photo feed for this profile";
  }
  return stated !== undefined && stated > 0
    ? "X sent no photos · try again later"
    : "No photos here.";
}

// The grid's status line: the count, and the pause whenever X's limit
// has bitten. Said in EVERY non-exhausted state, docked or not: a
// reader at the top of an empty rate-limited grid must see why it is
// empty. With nothing on screen the count itself goes: "0 photos"
// under a limit reads as an empty profile, which is a lie.
function statusLine(): string {
  const pausedUntil = ratePauseUntil();
  if (!pausedUntil) return nphotos(tiles.size);
  const when = fmtTime(pausedUntil);
  return tiles.size === 0
    ? `X image quota depleted · photos return at ${when}`
    : `${nphotos(tiles.size)} · X image quota low · loading resumes ${when}`;
}

// --- the native-view rate notice -------------------------------------------
// The bucket is shared with X's OWN photos view, so when it empties,
// that view fails too ("Something went wrong. Try reloading.") and the
// reader has no idea why or for how long. While a photos-timeline 429
// is fresh and the window has not reset, a one-line note under the
// profile's tab strip says when photos return. Native view only: the
// grid's own status line says the same while the overlay is up.
// Re-asserted per mutation batch (the note's home is React's, and a
// re-render drops it) and removed the moment the condition clears.
const RATE_NOTE_ID = "xtag-rate-note";
const RATE_429_FRESH_MS = 16 * 60_000;
let last429At = 0;
// When X last answered a photos page EMPTY for a profile whose own
// media_count says there is media. That is the soft-throttle shape: no
// 429, healthy budget headers, and still nothing served (measured
// live; X's client then backs off entirely). The native view shows a
// bare "no photos" then, which reads as an empty profile.
let softEmptyAt = 0;
const SOFT_EMPTY_FRESH_MS = 5 * 60_000;

// --- the quota pill --------------------------------------------------------
// The loading-limit pill, where the reader can see it while scrolling:
// once the window runs low (the same threshold that slows our pages), a
// small pill sits at the bottom of any photos view, grid or native,
// and leaves when the window resets or the reader navigates away. The
// label carries NO count: "17 of 50" read as 50 IMAGES, not 50 page
// loads (user report); the bar says how much is left, the tooltip says
// what is counted. It
// lives on body, like the overlay: React never reconciles body's
// children, so there is nothing to fight and nothing to re-render it
// out. Asserted wherever the numbers change (noteRateHeaders,
// noteRate429) and on every mutation batch for route changes.
const QUOTA_ID = "xtag-quota";
const QUOTA_SHOW_AT = 25;

function assertQuotaPill(): void {
  let pill = document.getElementById(QUOTA_ID);
  const wanted = onPhotosFeed() && rateRemaining !== null
    && rateRemaining <= QUOTA_SHOW_AT && Date.now() < rateResetAt;
  if (!wanted || rateRemaining === null) {
    pill?.remove();
    return;
  }
  if (!pill) {
    pill = document.createElement("div");
    pill.id = QUOTA_ID;
    pill.title = "Photo page loads left in X's 15-minute window, shared "
      + "with normal browsing. This pill is from revertX.";
    const label = document.createElement("span");
    const track = document.createElement("div");
    track.className = "xtag-quota-track";
    track.appendChild(document.createElement("div"))
      .className = "xtag-quota-fill";
    pill.append(label, track);
    document.body.appendChild(pill);
  }
  const text = rateRemaining === 0
    ? `X image quota depleted · photos return at ${fmtTime(rateResetAt)}`
    : `X image quota low · resets ${fmtTime(rateResetAt)}`;
  const label = pill.firstElementChild as HTMLElement;
  if (label.textContent !== text) label.textContent = text;
  // The bar needs a denominator; without one the pill is text only.
  const track = pill.querySelector<HTMLElement>(".xtag-quota-track");
  if (track) {
    const show = rateLimit !== null && rateLimit > 0;
    track.style.display = show ? "" : "none";
    if (show) {
      const fill = track.firstElementChild as HTMLElement;
      const width = `${Math.round(Math.max(0, Math.min(1, rateRemaining / rateLimit!)) * 100)}%`;
      if (fill.style.width !== width) fill.style.width = width;
    }
  }
  // Centered on the COLUMN, not the viewport: X's column sits off
  // center between its sidebars, and a viewport-centered pill reads as
  // misplaced against the grid.
  const col = primaryColumn();
  const rect = col?.getBoundingClientRect();
  const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
  const left = `${Math.round(cx)}px`;
  if (pill.style.left !== left) pill.style.left = left;
}

function assertRateNotice(): void {
  const existing = document.getElementById(RATE_NOTE_ID);
  const now = Date.now();
  const limited = now - last429At < RATE_429_FRESH_MS && now < rateResetAt;
  // The soft tier only when the native grid is actually empty: a
  // normal profile's stray empty page (a video-only stretch) must not
  // put a warning under a grid full of photos.
  const softEmpty = !limited && !active && onPhotosFeed()
    && now - softEmptyAt < SOFT_EMPTY_FRESH_MS
    && !document.querySelector('[data-testid="primaryColumn"] a[href*="/photo/"]');
  const wanted = !active && onPhotosFeed() && (limited || softEmpty);
  if (!wanted) {
    existing?.remove();
    return;
  }
  const text = limited
    ? "X image quota depleted · photos return at " + fmtTime(rateResetAt)
    : "X sent no photos · try again later";
  if (existing) {
    if (existing.textContent !== text) existing.textContent = text;
    return;
  }
  const strip = document.querySelector<HTMLElement>('main [role="tablist"]');
  if (!strip) return;
  const note = document.createElement("div");
  note.id = RATE_NOTE_ID;
  note.textContent = text;
  note.title = "X limits how much an account can load in 15 minutes, "
    + "shared with normal browsing. This note is from revertX.";
  // Never beside the tablist: on x.com the strip's own wrapper sizes
  // and clips to its tabs, so a sibling in there makes the bar taller
  // while the text stays hidden. The note goes after the COLUMN CHILD
  // the strip lives in, between the header block and the timeline (or
  // X's error view), in plain column flow.
  let anchor: HTMLElement = strip;
  const col = primaryColumn();
  if (col && col.contains(strip)) {
    while (anchor.parentElement && anchor.parentElement !== col) {
      anchor = anchor.parentElement;
    }
  }
  anchor.insertAdjacentElement("afterend", note);
}

// The cursor a request ASKED with, read back out of its own URL; the
// other half of the non-advancing-cursor end signal below.
function requestCursorOf(url: string): string | null {
  try {
    const rawVars = new URL(url).searchParams.get("variables");
    if (!rawVars) return null;
    const cursor = (JSON.parse(rawVars) as Record<string, unknown>)["cursor"];
    return typeof cursor === "string" && cursor ? cursor : null;
  } catch {
    return null;
  }
}

function applyPayload(url: string, body: string, srcHandle: string): void {
  try {
    const parsed: unknown = JSON.parse(body);
    const media: ApiMedia[] = [];
    const cursors: string[] = [];
    const flags = { terminated: false, terminatedAny: false };
    scanApiPayload(parsed, media, cursors, flags);
    if (mintApiTiles(media) > 0) lastPassiveProgressAt = Date.now();
    // Only THIS profile's payloads flip the drive into bottom-hop mode:
    // a stale buffered page from a previously-viewed profile says nothing
    // about whether this feed fetches, and on a client-cache revisit the
    // harvest walk is the only source there is.
    if (srcHandle === gridHandle) {
      payloadSeen = true;
      // The UserMedia fallback's source (see tryGifFallback): an EMPTY
      // page arms no payloadTemplate (owned stays 0 on a profile X
      // serves nothing for), but its URL still carries this profile's
      // userId and the features blob, which is everything the fallback
      // needs to ask the combined media timeline instead.
      fallbackSourceUrl = url;
    }
    const owned = media.filter(
      (m) => m.href.toLowerCase().startsWith(`/${gridHandle}/status/`)).length;
    // The non-advancing cursor (measured live): X can end a timeline
    // with NO terminate instruction at all; the terminal page is
    // cursor-only entries whose Bottom cursor EQUALS the cursor that
    // requested it. A mid-feed cursor-only page (the deleted-tweets
    // shape the empty-page distrust exists for) always ADVANCES its
    // cursor, so bottom == requested can only mean "nothing past here".
    // Gated on the handle the payload ARRIVED under (recorded at
    // interception time), so a stale buffered page from a
    // previously-viewed profile can never end this one's feed.
    const reqCursor = requestCursorOf(url);
    if (media.length === 0 && srcHandle === gridHandle && cursors.length) {
      if (reqCursor && cursors[cursors.length - 1] === reqCursor) {
        // X's own client retries ITS stalled cursors; those retries land
        // here as identical echoes and must not vote on OUR frontier when
        // the replay chain is already deeper (cursorOurs). Only an echo
        // of the cursor we would ask with next is evidence about our end.
        if (!cursorOurs || reqCursor === payloadCursor) {
          noteCursorEcho(reqCursor, "passive page");
        }
      }
    }
    // Any page with content clears the stall count: the echo it was
    // counting is either resolved or beside the point now.
    if (media.length > 0) noteCursorProgress();
    // X can TERMINATE an empty FIRST page outright (direction "Top";
    // measured on /colordifference: an 802-byte page of two cursor
    // entries and no media at all, against a header media_count of 33).
    // A GIF-only profile looks exactly like this: X serves animated_gif
    // posts on NEITHER media filter. No deeper page can exist behind an
    // empty terminated page 1, so this ends the feed with no
    // media_count needed (X often omits media_count), and it is what
    // hands the empty grid to the UserMedia fallback. Only while the
    // grid is EMPTY: on a GIF profile this page arrives on EVERY visit,
    // and a revisit restored from the cache must keep paging past its
    // frontier, not freeze under a photos-op verdict about a grid the
    // UserMedia template is serving.
    if (flags.terminatedAny && media.length === 0 && !reqCursor
      && srcHandle === gridHandle && tiles.size === 0) {
      endFeed("empty timeline: terminated at page 1");
    }
    // The template and cursor come only from a payload that provably
    // belongs to THIS profile (owned > 0): the buffer holds payloads for
    // minutes now, so a stale entry from a previously-viewed profile must
    // not arm the replay/cursor machinery with a foreign template.
    if (owned > 0) {
      payloadTemplate = url;
      // A cursor of ours outranks the passive page-1 one; see cursorOurs.
      // EXCEPT the page that answers our exact next ask: a passive page
      // requested WITH our own frontier cursor is the page the extension
      // would buy next, so its Bottom cursor advances the frontier for
      // free. Without this, X's co-crawl passing our replay leaves the
      // frontier frozen behind it, and the extension re-buys pages the
      // co-crawl already delivered (measured live on /NASA: passive
      // pages ran past the prefill's page within one visit).
      if (cursors.length && (!cursorOurs
        || (reqCursor !== null && reqCursor === payloadCursor))) {
        payloadCursor = cursors[cursors.length - 1];
      }
    }
    // The terminate instruction, if X ever sends one. It did not on any
    // page measured, so the non-advancing cursor echo is the end signal
    // that does the work; but a payload that DOES say terminate is still
    // saying the timeline is over. A page's SIZE says nothing: a sparse
    // page mid-feed is the normal shape of a photos timeline filtered
    // server-side.
    if (flags.terminated) endFeed("X sent TimelineTerminateTimeline");
  } catch (error) {
    console.warn("[xtag] media payload parse failed:", error);
  }
}

function handleMediaPayload(url: string, body: string): void {
  // The profile the payload arrived UNDER, recorded now; by drain time
  // the reader may be on a different profile, and the non-advancing-cursor
  // end signal must never cross that line.
  const srcHandle = (location.pathname.split("/")[1] ?? "").toLowerCase();
  // The soft-throttle signature, read on BOTH paths (an inactive grid
  // buffers payloads unparsed, and the native view is exactly where
  // the soft note lives): a photos page carrying no media at all, for
  // a profile X itself counts media on. A string scan, not a parse.
  if (!body.includes('"media_url_https"')) {
    const stated = profileMediaCounts.get(srcHandle);
    if (stated !== undefined && stated > 0) softEmptyAt = Date.now();
  }
  if (active) {
    applyPayload(url, body, srcHandle);
    return;
  }
  payloadBuffer.push({ url, body, at: Date.now(), handle: srcHandle });
  if (payloadBuffer.length > 4) payloadBuffer.shift();
}

// 10 minutes, deliberately long: "browse the photos feed a while, then
// pick a grid from the dropdown" must not activate with an expired
// buffer; no payload means no end signal, and on a profile too small to
// dock the tail shimmers forever. Staleness across profiles is handled
// structurally, not by the clock: mintApiTiles owner-filters every tile
// and applyPayload arms the template/cursor/end only on owned > 0.
const PAYLOAD_BUFFER_TTL_MS = 10 * 60_000;

function drainPayloadBuffer(): void {
  const now = Date.now();
  for (const entry of payloadBuffer.splice(0)) {
    if (now - entry.at < PAYLOAD_BUFFER_TTL_MS) {
      applyPayload(entry.url, entry.body, entry.handle);
    }
  }
}

// One media entity as one ApiMedia, or null for anything else. `index` is
// the entity's 1-BASED POSITION in the media array it was reached
// through, and it OVERRIDES the number in expanded_url. Measured live on
// a 4-photo post: X writes /photo/1 on EVERY media entity of a
// multi-photo post: four distinct media_url_https, four identical
// expanded_urls. The per-photo index exists only as array position
// (which is also how X's own viewer routes: the n-th media opens
// /photo/<n>, counted across the whole array, videos included).
// Building the href off expanded_url alone dedupes a 4-photo post down
// to one tile.
function mediaEntityOf(
  obj: Record<string, unknown>, index: number | null,
): ApiMedia | null {
  const exp = obj["expanded_url"];
  const src = obj["media_url_https"];
  const type = obj["type"];
  if (typeof exp !== "string" || typeof src !== "string"
    || typeof type !== "string" || !exp.includes("/photo/")) {
    return null;
  }
  try {
    let href = new URL(exp).pathname;
    if (index !== null) href = href.replace(/\/photo\/\d+$/, `/photo/${index}`);
    // original_info rides every media entity beside media_url_https and
    // carries the ORIGINAL dimensions; the layout's ratio, known
    // before any thumbnail loads. Absent or malformed, the tile lays
    // out square and the thumb's load event teaches the truth.
    let ratio: number | undefined;
    const info = obj["original_info"];
    if (info && typeof info === "object") {
      const w = (info as Record<string, unknown>)["width"];
      const h = (info as Record<string, unknown>)["height"];
      if (typeof w === "number" && typeof h === "number" && w > 0 && h > 0) {
        ratio = h / w;
      }
    }
    return { href, src, video: type !== "photo", ratio };
  } catch { /* unparseable expanded_url; skip the item */ }
  return null;
}

// Walk the whole payload rather than a hardcoded instruction path: the
// timeline envelope reshapes (modules vs entries, grid vs list), but a
// photo is always an object carrying expanded_url + media_url_https +
// type, the next page is always a Bottom cursor, and the end of the
// timeline is a TimelineTerminateTimeline instruction whose direction
// includes Bottom.
//
// X carries a post's first photo TWICE (entities.media beside
// extended_entities.media), so the raw walk finds it once per copy.
// Nothing downstream breaks (the tile map dedupes by href), but `found`
// would count both, which flatters the spend receipt. The dedupe is
// WITHIN ONE PAGE only, deliberately: across pages a repeat is a real
// signal (we bought something we already held), and the end detection
// reads `found === 0` to spot the terminal page.
function scanApiPayload(
  node: unknown, media: ApiMedia[], cursors: string[],
  flags?: { terminated: boolean; terminatedAny: boolean },
): void {
  const start = media.length;
  scanApiPayloadInto(node, media, cursors, flags);
  const run = media.splice(start);
  const seen = new Set<string>();
  for (const m of run) {
    const key = m.href.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    media.push(m);
  }
}

function scanApiPayloadInto(
  node: unknown, media: ApiMedia[], cursors: string[],
  flags?: { terminated: boolean; terminatedAny: boolean },
): void {
  if (Array.isArray(node)) {
    // An array whose direct elements are media entities is a tweet's media
    // array: mint each with its position (see mediaEntityOf). A minted
    // entity is not scanned deeper; it holds no cursors, and the object
    // branch below would mint it AGAIN, unindexed.
    for (let i = 0; i < node.length; i++) {
      const item: unknown = node[i];
      const m = item && typeof item === "object" && !Array.isArray(item)
        ? mediaEntityOf(item as Record<string, unknown>, i + 1)
        : null;
      if (m) {
        media.push(m);
      } else {
        scanApiPayloadInto(item, media, cursors, flags);
      }
    }
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  // A media entity reached OUTSIDE an array (no position to speak of):
  // keep expanded_url's own number rather than drop the photo. If X ever
  // nests entities behind per-item wrappers, this is the branch that
  // still shows page 1 of each post.
  const solo = mediaEntityOf(obj, null);
  if (solo) media.push(solo);
  if (obj["cursorType"] === "Bottom" && typeof obj["value"] === "string") {
    cursors.push(obj["value"]);
  }
  if (flags && obj["type"] === "TimelineTerminateTimeline") {
    // Any direction: a terminate on an EMPTY first page means the whole
    // timeline is empty (see the empty-timeline end in applyPayload);
    // only a Bottom terminate says a feed with content is over.
    flags.terminatedAny = true;
    if (typeof obj["direction"] === "string" && obj["direction"].includes("Bottom")) {
      flags.terminated = true;
    }
  }
  for (const value of Object.values(obj)) scanApiPayloadInto(value, media, cursors, flags);
}

// A tile's thumbnail must come from X's own media host. The href is already
// constrained to this profile's own /status/ path below, but the src had no
// such bound; and a forged payload (the page can dispatch the interceptor's
// event) could point every tile at an arbitrary host, turning the grid into
// a beacon that reports the reader. pbs.twimg.com is where X serves media.
function isMediaHost(src: string): boolean {
  try {
    const { protocol, hostname } = new URL(src, location.origin);
    return protocol === "https:"
      && (hostname === "twimg.com" || hostname.endsWith(".twimg.com"));
  } catch {
    return false;
  }
}

// scanApiPayload walks the response in document order, so `found` is already
// in feed order; one run, merged as it stands.
function mintApiTiles(found: ApiMedia[]): number {
  return mergeRun(found
    // The same owner filter the harvest applies; it also quietly discards
    // a stale template's media if the resource entry belonged to a
    // previously-viewed profile.
    .filter((m) => m.href.toLowerCase().startsWith(`/${gridHandle}/status/`)
      && isMediaHost(m.src))
    .map((m) => ({ href: m.href, src: m.src, video: m.video, ratio: m.ratio })));
}

// The replay carries the reader's SESSION: cookies (credentials: include),
// the ct0 CSRF token and the web bearer. So the template's origin has to be
// proven before any of that is sent, and neither source of a template is
// trustworthy on its own:
//
//   - payloadTemplate comes from the MAIN-world interceptor's CustomEvent,
//     and any script running on the page can dispatch that event with a url
//     of its choosing;
//   - latestMediaTemplate reads resource-timing entries, which cover EVERY
//     origin the page loads from, not just x.com's API.
//
// Without this check a forged template would deliver the reader's ct0 to an
// attacker's host as a request header (a permissive CORS preflight is
// enough; the response never has to be readable). Anything that is not
// x.com's own GraphQL API is refused outright.
const API_HOSTS = new Set(["x.com", "twitter.com", "api.x.com", "api.twitter.com"]);

function assertOwnApi(template: string): URL {
  const url = new URL(template, location.origin);
  if (url.protocol !== "https:" || !API_HOSTS.has(url.hostname.toLowerCase())
    || !url.pathname.startsWith("/i/api/graphql/")) {
    throw new Error(`refusing to replay a non-X template: ${url.origin}`);
  }
  return url;
}

async function fetchMediaPage(
  template: string, cursor: string | null,
): Promise<{ added: number; found: number; next: string | null; echoed: boolean }> {
  const url = assertOwnApi(template);
  const rawVars = url.searchParams.get("variables");
  if (!rawVars) throw new Error("template has no variables param");
  const vars = JSON.parse(rawVars) as Record<string, unknown>;
  // The template is a request the PAGE made, and X's own deeper fetches
  // carry a cursor of their own. Asking with no cursor means "from the
  // top", so a leftover one has to go; otherwise the prefill's single
  // replay re-asks for a page we already hold, and the answer is thrown
  // away by the tile map.
  if (cursor) vars["cursor"] = cursor;
  else delete vars["cursor"];
  vars["count"] = PAGE_COUNT;
  url.searchParams.set("variables", JSON.stringify(vars));
  const resp = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      authorization: PREFILL_BEARER,
      "x-csrf-token": csrfToken(),
      "x-twitter-active-user": "yes",
      "x-twitter-auth-type": "OAuth2Session",
    },
  });
  ownPages++;
  noteRateHeaders(resp.headers.get("x-rate-limit-remaining"),
    resp.headers.get("x-rate-limit-reset"),
    resp.headers.get("x-rate-limit-limit"));
  if (resp.status === 429) noteRate429();
  if (!resp.ok) throw new Error(`UserMedia answered ${resp.status}`);
  const body: unknown = await resp.json();
  const media: ApiMedia[] = [];
  const cursors: string[] = [];
  const flags = { terminated: false, terminatedAny: false };
  scanApiPayload(body, media, cursors, flags);
  const next = cursors.length ? cursors[cursors.length - 1] : null;
  // Our own empty page carries the same soft-throttle signature the
  // passive path reads in handleMediaPayload; on a client-cache revisit
  // it can be the ONLY page, so it must teach softEmptyAt too.
  if (media.length === 0) {
    const stated = profileMediaCounts.get(gridHandle);
    if (stated !== undefined && stated > 0) softEmptyAt = Date.now();
  }
  if (flags.terminated) endFeed("X sent TimelineTerminateTimeline (replay)");
  // The empty-timeline end, same signal as applyPayload's: a from-top
  // replay answered empty AND terminated means the timeline has nothing.
  // Same empty-grid gate too: a sparse cache-restored grid must not be
  // ended by the photos op's verdict.
  if (flags.terminatedAny && media.length === 0 && !cursor
    && tiles.size === 0) {
    endFeed("empty timeline: terminated at page 1 (replay)");
  }
  // A missing cursor is an immediate end; no shape of stall withholds the
  // cursor entirely. The ECHO is no longer ruled on here: it is ambiguous
  // (true end vs mid-feed stall, see noteCursorEcho) and the callers own
  // the retry, so this only reports the shape. An empty page whose cursor
  // ADVANCES is also left alone; that is the deleted-tweets shape, which
  // X's own feed reads straight past.
  const echoed = media.length === 0 && next !== null && next === cursor;
  if (media.length === 0 && !next) endFeed("terminal page: no cursor");
  if (media.length > 0) noteCursorProgress();
  ownPhotos += media.length;
  const added = mintApiTiles(media);
  ownAdded += added;
  return { added, found: media.length, next, echoed };
}

async function apiPrefill(): Promise<void> {
  const startedFor = gridHandle;
  // Only a request from THIS visit may be the template: on an SPA hop from
  // another profile's media tab the old UserMedia entries are still in the
  // buffer (the owner filter in mintApiTiles is the belt behind this).
  const since = performance.now() - 5000;
  try {
    // PASSIVE FIRST: the interceptor mints the page's own first photos
    // page as it lands; most activations need no request of ours at all.
    await pollFor(
      () => (tiles.size >= PREFILL_MIN_TILES || feedEnded || !active
        || gridHandle !== startedFor
        ? true : null),
      6000);
    if (!active || gridHandle !== startedFor) return;
    // A feed that already ENDED needs no replay whatever the tile count:
    // a profile with 3 photos is full at 3.
    if (feedEnded || tiles.size >= PREFILL_MIN_TILES) {
      console.info(`[xtag] mosaic prefill: ${tiles.size} photos, all passive`);
      return;
    }
    if (Date.now() < apiCooldownUntil || ratePauseUntil()) {
      console.warn("[xtag] mosaic prefill: in rate-limit cooldown; scroll-loading only");
      return;
    }
    const template = payloadTemplate ?? latestMediaTemplate(since);
    if (!template) {
      // Name what WAS seen: if X renames the photos-feed op, this line is
      // the whole diagnosis.
      const ops = Array.from(new Set(graphqlSeen.map((s) => opNameOf(s.name))));
      console.warn("[xtag] mosaic prefill: no media timeline request observed; "
        + "scroll-loading only. GraphQL ops seen: "
        + (ops.join(", ") || "(none)"));
      return;
    }
    // The driver's cursor extension is already buying pages; a second
    // ask here would be for the same cursor.
    if (replayInFlight) return;
    // At most ONE active page of CONTENT; replays share the page's own
    // rate-limit bucket, and a multi-page prefill can empty it (429s
    // that take X's own feeds down with it). A stalled ask buys
    // nothing, and this is the only asker on an undocked tiny profile:
    // if it treats one echo as final, nothing else ever settles that
    // grid (the stall settle is dock-only).
    replayInFlight = true;
    let page: Awaited<ReturnType<typeof fetchMediaPage>>;
    try {
      page = await fetchMediaPage(template, payloadCursor);
      while (page.echoed && !feedEnded
        && !noteCursorEcho(payloadCursor ?? "", "prefill replay")) {
        await new Promise((r) => setTimeout(r, ECHO_RETRY_MS));
        if (!active || gridHandle !== startedFor) return;
        page = await fetchMediaPage(template, payloadCursor);
      }
    } finally {
      replayInFlight = false;
    }
    if (!active || gridHandle !== startedFor) return;
    // The page's own Bottom cursor is the frontier now. Dropped, the
    // next asker (the extension, or a drive making X re-fetch from the
    // top) buys this same page a second time.
    if (!page.echoed && page.next) {
      payloadCursor = page.next;
      cursorOurs = true;
    }
    console.info(`[xtag] mosaic prefill: +${page.added} photos via `
      + `${opNameOf(template)} replay`);
  } catch (error) {
    if (String(error).includes("429")) {
      // noteRate429 (inside fetchMediaPage) already set the cooldown.
      console.warn("[xtag] mosaic prefill: rate limited (429); active replays "
        + "paused for 10 minutes; passive + scroll-loading continue");
    } else {
      console.warn("[xtag] mosaic prefill failed (scroll-loading still works):", error);
    }
  }
}

// --- the GIF fallback: the combined media timeline --------------------------
// X's media tab rides two ops now (UserPhotoTimeline / UserVideoTimeline)
// and animated_gif posts appear in NEITHER (measured on /colordifference:
// both filters answered empty terminated pages against a header
// media_count of 33, and X's own views said "hasn't posted photos"). The
// old combined UserMedia op still ships in X's bundle and still answers:
// the photos op's features blob works on it verbatim, GIF entities
// arrive with /photo/N expanded_urls, media_url_https and original_info
// (so the whole mosaic pipeline handles them unchanged, play glyph
// included), and the op has its OWN rate bucket (500/15min measured,
// against the photos op's 50). So when the photos feed settles EMPTY,
// one UserMedia page is fetched through the same guarded replay; if it
// carries media, the grid re-arms on the UserMedia template and loads
// on by cursor as usual, floor and pacing included.
let gifFallbackTried = false;
let fallbackSourceUrl: string | null = null;
let userMediaQid: string | null | undefined;

// The UserMedia queryId, read from X's own bundle scripts (the browser
// already holds them in its HTTP cache, so this costs no real network
// and nothing from any rate bucket). null = scanned and absent;
// undefined = not scanned yet. Query ids rotate on X's deploys, which
// is exactly why this cannot be a constant.
async function userMediaQueryId(): Promise<string | null> {
  if (userMediaQid !== undefined) return userMediaQid;
  userMediaQid = null;
  const srcs = Array.from(document.querySelectorAll<HTMLScriptElement>("script[src]"))
    .map((s) => s.src)
    .filter((s) => /(?:twimg|x)\.com\//.test(s));
  for (const src of srcs) {
    try {
      const text = await (await fetch(src)).text();
      const m = /queryId\s*:\s*"([\w-]+)"\s*,\s*operationName\s*:\s*"UserMedia"/.exec(text);
      if (m) {
        userMediaQid = m[1];
        break;
      }
    } catch { /* not fetchable; try the next script */ }
  }
  return userMediaQid;
}

async function tryGifFallback(): Promise<void> {
  if (gifFallbackTried || replayInFlight) return;
  if (tiles.size > 0 || !fallbackSourceUrl) return;
  gifFallbackTried = true;
  const startedFor = gridHandle;
  try {
    const qid = await userMediaQueryId();
    if (!qid || !active || gridHandle !== startedFor) return;
    // The source URL is a photos-timeline request for THIS profile
    // (handle-gated at arrival), so it carries the right userId and
    // features; only the op segment changes. assertOwnApi still rules
    // on the result before anything is sent.
    const src = new URL(fallbackSourceUrl);
    src.pathname = src.pathname.replace(/\/[^/]+\/[^/]+$/, `/${qid}/UserMedia`);
    const template = src.toString();
    replayInFlight = true;
    let page: Awaited<ReturnType<typeof fetchMediaPage>>;
    try {
      page = await fetchMediaPage(template, null);
    } finally {
      replayInFlight = false;
    }
    if (!active || gridHandle !== startedFor) return;
    if (page.added === 0) {
      console.info("[xtag] mosaic: UserMedia fallback found nothing either");
      return;
    }
    // The grid is a media grid from here: re-arm the loader on the
    // UserMedia template so the cursor extension pages on as usual, and
    // the settled empty state un-settles. Passive photos pages cannot
    // rewind any of this (cursorOurs, and their owned count stays 0).
    feedEnded = false;
    feedEndReason = "";
    exhausted = false;
    stalls = 0;
    emptyPages = 0;
    // A photos-template failure earlier in the visit says nothing about
    // this fresh template; without the reset the extension never pages it.
    extendBroken = false;
    noteCursorProgress();
    payloadTemplate = template;
    if (page.next) {
      payloadCursor = page.next;
      cursorOurs = true;
    }
    setStatus(statusLine());
    console.info("[xtag] mosaic: photos feed empty; UserMedia fallback carried "
      + `+${page.added} media (GIF-only profiles live there)`);
  } catch (error) {
    console.warn("[xtag] mosaic: UserMedia fallback failed:", error);
  }
}

// --- the grid cache --------------------------------------------------------

function stashGrid(): void {
  if (!gridHandle || tiles.size === 0 || !gridEl) return;
  // The grid's own children ARE the order (see the Tile comment: tiles
  // carry no ordering number). Skeletons carry no xtagId and drop out
  // of the walk.
  const entries: CachedGrid["entries"] = [];
  for (const child of Array.from(gridEl.children) as HTMLElement[]) {
    const tile = child.dataset.xtagId ? tiles.get(child.dataset.xtagId) : undefined;
    if (tile) {
      entries.push({
        href: tile.href, src: tile.src, video: tile.video, ratio: tile.ratio,
      });
    }
  }
  if (entries.length === 0) return;
  gridCache.delete(gridHandle);
  gridCache.set(gridHandle, {
    entries,
    cursor: payloadCursor,
    template: payloadTemplate,
    // ONLY the hard end signals (terminate, confirmed cursor echo,
    // media_count, no cursor) are worth caching. The soft stall end is
    // not: a driver that stalls because a rate-limited X stopped
    // answering looks identical to one at a true end, and caching that
    // guess froze short grids at a handful of photos for the TTL.
    ended: feedEnded,
    at: Date.now(),
  });
  while (gridCache.size > GRID_CACHE_MAX) {
    const oldest = gridCache.keys().next().value;
    if (oldest === undefined) break;
    gridCache.delete(oldest);
  }
}

// Runs right after buildOverlay: the revisit paints from the stash before
// any network happens. Restored tiles carry no cellY; the cell positions
// from the previous visit are stale; so harvest adopts fresh ones as X
// re-mounts the cells, exactly the payload-tile path.
function restoreGrid(): void {
  const cached = gridCache.get(gridHandle);
  if (!cached || Date.now() - cached.at > GRID_CACHE_TTL_MS) return;
  const added = mergeRun(cached.entries.map(
    (e) => ({ href: e.href, src: e.src, video: e.video, ratio: e.ratio })));
  payloadTemplate = cached.template;
  payloadCursor = cached.cursor;
  cursorOurs = Boolean(cached.template && cached.cursor);
  if (cached.template) payloadSeen = true;
  if (cached.ended) {
    endFeed("cached end (memory)");
    exhausted = true;
  }
  if (tiles.size) setStatus(statusLine());
  console.info(`[xtag] mosaic: ${added} tiles restored from cache`);
}

// --- the loading driver ----------------------------------------------------
// Real window scrolling behind the opaque overlay: the virtualizer mounts
// and fetches exactly as it would for a reader scrolling the feed, and the
// overlay's own overscroll-contained scrollbar keeps the user's view still.
// Paced, and it only walks while the grid actually needs tiles ahead.

async function driveLoop(): Promise<void> {
  const startedFor = overlay;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  // Each position's render clock starts at activation / at the last step.
  let lastStepAt = Date.now();
  // Progress = ANY new tile, harvested or payload-minted: the interceptor
  // mints whole pages the moment X's fetch lands, so gating on harvest
  // alone would read a perfectly-loading grid as stalled.
  let lastTotal = -1;
  while (active && overlay === startedFor) {
    // Belt against every "overlay left the DOM while active" class: a
    // driver scrolling for a grid nobody can see is the worst failure
    // mode this feature has (see buildOverlay's comment).
    if (!overlay!.isConnected) {
      document.body.appendChild(overlay!);
    }
    // Self-healing placement: scroll and resize events re-place the overlay,
    // but hiding the window scrollbar (gridmode CSS) can re-lay-out the
    // column WITHOUT either event firing, so re-measure every beat.
    placeOverlay();
    const added = harvest();
    const progressed = added > 0 || tiles.size !== lastTotal;
    lastTotal = tiles.size;
    if (progressed) {
      stalls = 0;
      // A terminated feed stays terminated; the last page usually
      // carries both its final tiles AND the terminate instruction, and
      // clearing the end on that page's own progress would re-arm the
      // stall wait it exists to skip.
      if (!feedEnded) {
        exhausted = false;
      } else if (exhausted) {
        // Tiles CAN land after the settle: in a background tab X renders
        // no feed cells at all, so the end signals (non-advancing cursor,
        // media_count) fire first and the harvest mints only once the tab
        // fronts; the settled status must follow the count, or it reads
        // "No photos here." under a visible tile (seen live).
        setStatus(settleStatus());
      }
    }
    // X's own ceiling: media_count from UserByScreenName counts photos
    // AND videos, so the photos feed can never yield more; tiles
    // reaching it means complete, whatever happened to the timeline
    // payloads. This is the one end signal that works UNDOCKED with no
    // payload at all (client-cache revisits); 0 >= 0 also settles a truly
    // media-less profile to "No photos here.".
    if (!feedEnded) {
      const stated = profileMediaCounts.get(gridHandle);
      if (stated !== undefined && tiles.size >= stated) {
        endFeed(`media_count ceiling (${tiles.size} tiles >= ${stated} stated)`);
      }
    }
    // The soft-withheld EMPTY grid: X answers media pages with no media
    // at all for a profile it counts media on (soft throttle, or
    // server-side filtering; /colordifference served empty photo AND
    // video timelines against media_count 33, measured live), and no
    // end signal ever comes. The stall settle cannot reach this shape:
    // with zero tiles the reader never docks, and the stall paths are
    // dock-only, so the skeletons shimmered forever over "0 photos",
    // which reads as a silent quota hit. Settle directly instead. The
    // soft end is never cached, and any later tile clears it as always.
    if (!exhausted && tiles.size === 0
      && Date.now() - softEmptyAt < SOFT_EMPTY_FRESH_MS
      && Date.now() - activatedAt > 8000) {
      exhausted = true;
      setStatus(settleStatus());
    }
    // The API's own word that the timeline is over: settle NOW instead
    // of waiting out ~6s of stall patience after the last tile.
    if (feedEnded && !exhausted) {
      exhausted = true;
      setStatus(settleStatus());
    }
    // An empty settled grid gets ONE shot at the combined media
    // timeline; a GIF-only profile has all its media there and none on
    // the photos op (see tryGifFallback).
    if (exhausted && tiles.size === 0) void tryGifFallback();
    // The skeleton tail shows whenever more tiles can still arrive; not
    // while resting for the rate limit (statusLine says why instead),
    // and not while an END PROBE is running: the first cursor echo is
    // nearly always the true end, and the 3x retry protocol that
    // confirms it (kept for the rare mid-feed stall; see noteCursorEcho)
    // takes seconds of widening waits. So the tail settles on echo one
    // and the retries continue silently; a retry that recovers content
    // resets stallCount and the tail returns. Flipping the class moves
    // the skeletons in or out of the grid, so a real flip re-lays-out.
    const loadingNow = !exhausted && !ratePauseUntil() && stallCount === 0;
    if (overlay!.classList.contains("xtag-grid-loading") !== loadingNow) {
      overlay!.classList.toggle("xtag-grid-loading", loadingNow);
      scheduleLayout();
    }
    // The content edge is where the skeletons start, NOT gridEl's
    // scrollHeight; the skeletons are grid children now and would count
    // ~4 rows of themselves as loaded content. (A hidden firstSkel reads
    // offsetTop 0, but that only happens while exhausted, which the next
    // guard owns.)
    const contentEdge = firstSkel && overlay!.classList.contains("xtag-grid-loading")
      ? firstSkel.offsetTop
      : gridEl ? gridEl.scrollHeight : 0;
    const need = gridEl
      && contentEdge - (overlay!.scrollTop + overlay!.clientHeight) < bufferPx();
    if (!need || exhausted) {
      if (!exhausted) setStatus(statusLine());
      await sleep(IDLE_MS);
      continue;
    }
    // The driver only ever moves the window while DOCKED on the photos
    // feed: before the dock the header is on screen and the window scroll
    // belongs to the user (their own scrolling is what loads; see the
    // no-prefill rule above bufferPx); on the photo-viewer route the
    // grid is merely hidden under the viewer; and a tile click is riding
    // the window scroll itself.
    if (!docked || navigating || !onPhotosFeed()) {
      if (onPhotosFeed()) setStatus(statusLine());
      await sleep(IDLE_MS);
      continue;
    }
    // The rate-limit floor: more tiles are wanted, but the budget X's
    // own headers report is nearly spent. Every fetch here
    // (driven, replayed or cursor-extended) draws from the bucket X's
    // real feeds run on, so the driver rests instead of draining it to
    // zero, and says when loading resumes.
    const pausedUntil = ratePauseUntil();
    if (pausedUntil) {
      setStatus(statusLine());
      await sleep(1000);
      continue;
    }
    // Which way the next page arrives, decided once, because the two ways
    // have different ends.
    const willExtend = !extendBroken && !feedEnded && !!payloadTemplate
      && !!payloadCursor;
    // One buyer at a time: while X's own crawl is delivering NEW tiles
    // passively, the cursor does not ask; the profile loads at exactly
    // the native grid's pace and cost. The cursor asks once X goes
    // quiet: stalled, backed off, ended, or serving nothing new past a
    // cached frontier (a revisit's passive pages mint nothing, so the
    // gate never holds there).
    if (willExtend && (replayInFlight
      || Date.now() - lastPassiveProgressAt < PASSIVE_QUIET_MS)) {
      setStatus(statusLine());
      await sleep(POLL_MS);
      continue;
    }
    const doc = document.documentElement;
    // The document's bottom is not the feed's end. The page's scroll is
    // the READER'S, and its end is simply the last tile they can see,
    // which is precisely where they are standing when they want the
    // next page; reading it as the end calls a deep profile finished
    // early. So the bottom only speaks for the driving path, the one
    // whose progress the window still governs. When the next page comes
    // from a request, the end comes from the answer to that request; no
    // next cursor, two empty pages in a row, or X's own terminal
    // marker; every one of which the extension below already reads.
    const atBottom = !willExtend
      && window.scrollY + window.innerHeight >= doc.scrollHeight - 60;
    // RENDER-GATED: give the current position time to paint (or the next
    // payload time to land) before moving; poll instead of stepping on a
    // fixed clock. At the document's bottom with payloads flowing the
    // window shrinks (BOTTOM_PATIENCE_MS): there is nothing to render,
    // only the question of whether one more page is coming.
    const patience = atBottom && payloadSeen ? BOTTOM_PATIENCE_MS : STEP_PATIENCE_MS;
    if (!progressed && Date.now() - lastStepAt < patience) {
      setStatus(tiles.size ? nphotos(tiles.size) : "");
      await sleep(POLL_MS);
      continue;
    }
    // Grace period: on a fresh page load the feed renders AFTER the grid
    // activates, and an empty, short document reads as "at the bottom with
    // nothing new"; which would call a loading account photo-less.
    const settled = tiles.size > 0 || Date.now() - activatedAt > 8000;
    if (atBottom && !progressed) {
      if (settled) {
        stalls++;
        if (stalls >= STALLS_FOR_END) {
          exhausted = true;
          setStatus(settleStatus());
          continue;
        }
      }
      // At the bottom with nothing new: wait out another patience window
      // rather than scrolling into nowhere.
      lastStepAt = Date.now();
      await sleep(POLL_MS);
      continue;
    }
    setStatus(tiles.size ? nphotos(tiles.size) : "");
    // Cursor extension: past a cache-restored frontier, one replayed
    // page from the saved cursor costs exactly one request.
    // Driving the window instead would make X re-fetch every page ABOVE
    // the frontier first; strictly more spend for the same tiles. Falls
    // back to the drive when the template goes stale (X rotates query
    // ids on deploys; the replay then 404s).
    if (willExtend && payloadTemplate && payloadCursor) {
      replayInFlight = true;
      try {
        const page = await fetchMediaPage(payloadTemplate, payloadCursor);
        if (page.echoed) {
          // The ambiguous shape: end or stall (see noteCursorEcho). Keep
          // the cursor, wait a widening beat, ask again; only a cursor
          // that echoes every time is the end. emptyPages is NOT touched:
          // that counter reads the deleted-tweets shape, where the cursor
          // advances, and an echo would double-vote through it.
          if (!noteCursorEcho(payloadCursor, "cursor extension")) {
            lastStepAt = Date.now();
            await sleep(ECHO_RETRY_MS * stallCount);
            continue;
          }
        } else {
          payloadCursor = page.next;
          // Ours from here on: X's own hidden pages must not rewind us
          // to a position we have already read past.
          cursorOurs = true;
          if (page.found === 0) {
            // The EMPTY page that still advances: one is a stray
            // (deleted tweets), two in a row is the end.
            emptyPages++;
            if (emptyPages >= 2) {
              endFeed("two empty pages in a row");
            }
          } else {
            emptyPages = 0;
            // A page WITH content ends the feed only by running out of
            // cursor. Its size means nothing; see the short-page rule
            // above PAGE_COUNT.
            if (!page.next) endFeed("page carried no next cursor");
          }
        }
      } catch (error) {
        if (!String(error).includes("429")) {
          console.warn("[xtag] mosaic: cursor extension failed; driving instead:", error);
          extendBroken = true;
          cursorOurs = false;
        }
        // A 429 keeps the cursor: the pause branch owns the wait, and
        // extension resumes from the same spot after the reset.
      } finally {
        replayInFlight = false;
      }
      lastStepAt = Date.now();
      await sleep(drivePaceMs());
      continue;
    }
    // THE DEGRADED PATH, and it is the only one left that moves the window.
    // Everything above asks X for the next page by cursor; this runs when
    // there is nothing to ask with; no template from the interceptor, or a
    // replay that stopped working because X rotated its query ids. The window
    // is the reader's, so it is borrowed for the step and put straight back,
    // with the feed un-clipped for the duration so a walk through it means
    // something. Rare by construction, and it degrades rather than stops.
    //
    // But it does not repeat forever: a drive that keeps yielding
    // nothing is the same stall as waiting at the bottom, and it ends
    // the same way. X can serve EMPTY photo timelines on a healthy
    // budget (a soft-throttled account, measured live: boot fires ~7
    // requests, all empty, then X's client backs off entirely), and an
    // un-capped drive borrow-jumped the window every step forever: the
    // reader saw flicker and skeletons that never settled. Any later
    // tile clears the soft end as always.
    if (!progressed && settled) {
      stalls++;
      if (stalls >= STALLS_FOR_END) {
        exhausted = true;
        setStatus(settleStatus());
        continue;
      }
    }
    borrowWindow();
    try {
      const realDoc = document.documentElement.scrollHeight;
      if (payloadSeen) {
        // Payloads are flowing: tiles come from X's fetch responses, not
        // from mounted cells, so the driver's only job is making X fetch:
        // one hop to the document's end per page instead of walking
        // every viewport.
        window.scrollTo(0, realDoc);
      } else {
        // Harvest-only mode: one viewport per step; far enough to make
        // progress, never past what the renderer can fill in.
        window.scrollBy(0, Math.max(window.innerHeight, 800));
      }
      // Held across the wait: X answers a scroll with a fetch, and putting the
      // window back before the answer lands would ask it for nothing.
      await sleep(DRIVE_STEP_MS);
    } finally {
      returnWindow();
    }
    lastStepAt = Date.now();
    // The same low-budget pacing the extension path gets (drivePaceMs):
    // each step here makes X fetch from the same bucket. The rest is
    // held OUTSIDE the borrow, which must stay short.
    const rest = drivePaceMs() - DRIVE_STEP_MS;
    if (rest > 0) await sleep(rest);
  }
}

// --- activation ------------------------------------------------------------

function activate(): void {
  if (active) return;
  active = true;
  exhausted = false;
  stalls = 0;
  payloadSeen = false;
  payloadTemplate = null;
  payloadCursor = null;
  cursorOurs = false;
  lastPassiveProgressAt = 0;
  // A stale template is X's deploy, not this profile's; the next activation
  // gets a fresh one from the interceptor and deserves the cursor path back.
  extendBroken = false;
  feedEnded = false;
  feedEndReason = "";
  emptyPages = 0;
  gifFallbackTried = false;
  fallbackSourceUrl = null;
  noteCursorProgress();
  activatedAt = Date.now();
  // The meter counts ONE visit. rateRemaining/rateResetAt deliberately
  // do NOT reset here; the bucket is the reader's, and it spans profiles.
  ownPages = 0;
  ownPhotos = 0;
  ownAdded = 0;
  passivePages = 0;
  rateLow = null;
  spendStartedAt = Date.now();
  gridHandle = location.pathname.split("/")[1].toLowerCase();
  tiles.clear();
  claimed = false;
  try {
    // The gridmode clip and the scroll reset are applied by the first
    // successful placeOverlay (see `claimed`).
    buildOverlay();
  } catch (error) {
    // Whatever failed, never leave the page as a black hole: the class
    // hides the window scrollbar, so it must not outlive a failed build.
    console.warn("[xtag] mosaic failed to build:", error);
    active = false;
    overlay?.remove();
    overlay = gridEl = statusEl = firstSkel = null;
    document.documentElement.classList.remove("xtag-gridmode");
    return;
  }
  spacer = document.createElement("div");
  spacer.id = SPACER_ID;
  spacerHeight = 0;
  lastMaxInner = -1;
  assertSpacer();
  startSizing();
  setStatus("");
  assertTabLabel();
  // A revisit paints from the cache first (zero network), THEN the page's
  // own buffered photos fetch mints on top of it (dupes no-op; genuinely
  // new page-1 posts still arrive).
  restoreGrid();
  drainPayloadBuffer();
  void apiPrefill();
  void driveLoop();
}

function deactivate(restoreScroll = true): void {
  if (!active) return;
  logSpend();
  stashGrid();
  active = false;
  stopSizing();
  // The window goes to the TOP before the feed comes back, and the order
  // is the whole point. The reader's position is a position in the GRID,
  // measured against a spacer that is about to be zero; the document it
  // is about to belong to is X's own feed at its real height. Handing
  // one to the other lets the browser clamp into a collapsed document
  // and then X re-measure a feed far taller than it was. Going to the
  // top first, while the feed is still clipped and there is nothing to
  // clamp against, is what X's own tab switch does anyway.
  // A grid that never claimed the page never moved it either; the
  // reader's scroll on X's own view is not ours to reset.
  if (restoreScroll && claimed) window.scrollTo(0, 0);
  claimed = false;
  unwatchColumn();
  spacer?.remove();
  spacer = null;
  spacerHeight = 0;
  lastMaxInner = -1;
  borrowed = 0;
  document.documentElement.classList.remove("xtag-grid-borrowing");
  overlay?.remove();
  overlay = gridEl = statusEl = firstSkel = null;
  window.clearTimeout(layoutTimer);
  layoutTimer = 0;
  lastLayoutWidth = 0;
  // The next activation builds a fresh overlay with no clip on it; a stale
  // path here would make setHole skip the first write to that new element.
  holePath = "";
  holeCenter = null;
  window.clearTimeout(holeClearTimer);
  holeClearTimer = 0;
  document.documentElement.classList.remove("xtag-gridmode");
  // The tab goes back to X's own label ("Photos") the moment the grid is
  // no longer the view on screen.
  assertTabLabel();
}

function evaluate(): void {
  // The photo viewer over the grid: keep everything alive, just hidden:
  // the viewer's close is a history.back() to the photos feed, where the
  // grid reappears untouched (scroll, tiles, driver state all kept).
  if (active && onPhotoRoute()) {
    overlay?.classList.add("xtag-grid-viewing");
    return;
  }
  if (shouldGrid()) {
    activate();
    if (overlay?.classList.contains("xtag-grid-viewing")) {
      overlay.classList.remove("xtag-grid-viewing");
      // BACK FROM THE VIEWER: X tore the column down and rebuilt it, so
      // the document changed shape while the sizing was frozen. The next
      // measurement starts fresh rather than adding a delta to a stale
      // total; returnWindow's rule, for the same reason.
      lastMaxInner = -1;
    }
  } else {
    deactivate(active);
    // The override is per-visit: anywhere that is neither the media view
    // nor the photo viewer over it forgets it, so the next Media-tab
    // arrival starts from the stored default again.
    if (!onPhotosFeed() && !onPhotoRoute()) override = null;
  }
}

// --- the injected dropdown item --------------------------------------------
// X's media menu has two items (Videos / Photos, no testids, words follow
// the UI language). The media menu is recognized structurally: exactly two
// real items, one of which repeats the selected media tab's own label.
// The injected Mosaic item is a CLONE of the item that is not the
// current choice (the one without the ✓), so it wears X's own menu
// styling whatever the theme.

function realMenuItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .filter((item) => !item.hasAttribute(GRID_ITEM_ATTR));
}

function isMediaMenu(menu: HTMLElement): boolean {
  if (!MEDIA_PATH_RE.test(location.pathname)) return false;
  const tab = selectedMediaTab();
  if (!tab) return false;
  const tabText = tabOriginalLabel(tab);
  const items = realMenuItems(menu);
  return items.length === 2
    && items.some((item) => (item.textContent ?? "").trim() === tabText);
}

// Write-on-change: this is re-asserted per mutation batch now (see
// assertMenuChecks), and an unguarded write would feed the observer a
// characterData record every batch the menu stays open.
function setItemText(item: HTMLElement, text: string): void {
  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const current = (node.textContent ?? "").trim();
    if (!current) continue;
    if (current !== text) node.textContent = text;
    return;
  }
}

// No rate note on the injected item: a second line makes the row
// overflow the panel X sizes for its own items. The cost note lives in
// the popup beside the select, and the status line says so the moment
// the floor bites.

function injectGridItem(menu: HTMLElement): void {
  if (menu.querySelector(`[${GRID_ITEM_ATTR}]`)) return;
  if (!isMediaMenu(menu)) return;
  const tab = selectedMediaTab();
  const tabText = tab ? tabOriginalLabel(tab) : "";
  const items = realMenuItems(menu);
  // Clone the item WITH the checkmark when one is on screen: the copy
  // then carries X's own ✓ (the blue svg, at X's size and place), and
  // assertMenuChecks shows it while the grid is up. A text-glyph "✓"
  // reads as foreign beside X's. Visibility keeps the svg's layout
  // slot, exactly how the real items' ✓ is handled one function down.
  // The item goes AFTER X's last item, and assertMenuChecks re-glues it
  // there every batch (see the rewrap comment there).
  const donor = items.find((item) => item.querySelector("svg"))
    ?? items.find((item) => (item.textContent ?? "").trim() !== tabText)
    ?? items[1];
  const clone = donor.cloneNode(true) as HTMLElement;
  clone.setAttribute(GRID_ITEM_ATTR, "");
  setItemText(clone, GRID_TAB_LABEL);
  clone.style.cursor = "pointer";
  items[items.length - 1].insertAdjacentElement("afterend", clone);
  assertMenuChecks();
}

// While the grid is up, the choice on screen is the grid; X's own ✓ on
// the Photos item (true about the underlying feed, wrong about the view)
// reads as two selections at once. Hide, don't remove: the node is
// React-owned, and visibility keeps its layout slot. Re-asserted every
// mutation batch; hiding once at inject time is not enough, because
// React re-renders the item after our pass and mounts the ✓ back, which
// is exactly the tab label's re-assert problem one node over.
function assertMenuChecks(): void {
  const menu = document.querySelector<HTMLElement>('[role="menu"]');
  if (!menu) return;
  const clone = menu.querySelector<HTMLElement>(`[${GRID_ITEM_ATTR}]`);
  if (!clone) return;
  // The clone's label and ✓ follow `active`, re-asserted per batch,
  // never written once at inject time: a menu can outlive an activation
  // change (picking Mosaic activates under the still-open menu), which
  // would leave a live grid behind an item with no ✓, beside X's ✓s
  // this very function had hidden.
  const check = clone.querySelector("svg");
  if (check) {
    // X's own glyph, shown while the grid is up; write-on-change,
    // re-asserted per mutation batch (a hover re-render mutates, and
    // observer callbacks run before that frame paints).
    const want = active ? "visible" : "hidden";
    if (check.style.visibility !== want) check.style.visibility = want;
    setItemText(clone, GRID_TAB_LABEL);
  } else {
    // No ✓ was on screen to clone from; the text glyph is the fallback.
    setItemText(clone, active ? `${GRID_TAB_LABEL} ✓` : GRID_TAB_LABEL);
  }
  // The clone stays GLUED to X's own items; unglued it shows a seam of
  // bare panel. Shortly after the menu mounts, React re-renders it and
  // REWRAPS its two items into a fresh container (measured live: the
  // menu becomes [wrapper > Videos, Photos]); nodes it does not own are
  // left OUTSIDE that wrapper, wherever reconciliation dropped them,
  // beside whatever helper nodes X renders. Anchored to the last real
  // item, inside the same parent, the clone sits flush in X's own flow
  // (measured: contiguous 44px rows, the menu's auto height following,
  // stable across re-renders) and every stray X node lands outside it.
  // Write-on-move: the node is touched only when it is not already in
  // place.
  const real = realMenuItems(menu);
  const lastReal = real[real.length - 1];
  if (lastReal?.parentElement
    && (clone.parentElement !== lastReal.parentElement
      || clone.previousElementSibling !== lastReal)) {
    lastReal.insertAdjacentElement("afterend", clone);
  }
  if (!active) return;
  const tab = selectedMediaTab();
  const tabText = tab ? tabOriginalLabel(tab) : "";
  for (const item of realMenuItems(menu)) {
    if ((item.textContent ?? "").trim() !== tabText) continue;
    item.querySelectorAll("svg").forEach((svg) => {
      if (svg.style.visibility !== "hidden") svg.style.visibility = "hidden";
    });
  }
}

// A synthetic Escape does NOT close X's menus (measured); clicking the
// full-viewport backdrop X renders under every dropdown does.
function closeMenu(): void {
  const menu = document.querySelector('[role="menu"]');
  // Nothing to close is not an Escape. The fallback at the end of this
  // function dispatches a real keydown as far as the rest of the module
  // is concerned, and the Escape handler in initMosaic reads one as
  // "the reader wants X's own view"; so calling this with no menu open
  // would clear a choice nobody revoked. A tidy-up must never read as
  // a choice.
  if (!menu) return;
  const layers = document.getElementById("layers");
  if (layers) {
    // The LAYOUT viewport, never window.innerWidth: innerWidth counts
    // the window scrollbar, and X sizes the backdrop to the layout
    // viewport (measured: backdrop 1351x931 against innerWidth 1366).
    // An innerWidth test never matches, falls through to the synthetic
    // Escape, and X ignores that.
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const backdrop = Array.from(layers.querySelectorAll("div")).find((d) => {
      const r = d.getBoundingClientRect();
      return r.width >= vw - 2 && r.height >= vh - 2 && !d.contains(menu);
    });
    if (backdrop) {
      // The full gesture: mousedown + mouseup + click is what today's
      // backdrop was measured to answer.
      backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      backdrop.click();
      return;
    }
  }
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

function onMenuClick(event: MouseEvent): void {
  // Synthetic clicks are never intent. Our own handler below rides X's
  // Photos item to reach the photos view; reading that click as the
  // user explicitly choosing the feed would clear the pick and keep the
  // grid from ever activating.
  if (selfClicking) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const item = target.closest<HTMLElement>('[role="menuitem"]');
  if (!item) return;
  const menu = item.closest<HTMLElement>('[role="menu"]');
  if (!menu || !menu.querySelector(`[${GRID_ITEM_ATTR}]`)) return;

  if (item.hasAttribute(GRID_ITEM_ATTR)) {
    event.preventDefault();
    event.stopPropagation();
    // The override answers NOW; the write makes it the default (the
    // storage echo lands a beat later and changes nothing the override
    // has not already said).
    override = "mosaic";
    void chrome.storage.local.set({ mediaview: "mosaic" });
    if (onPhotosFeed()) {
      closeMenu();
      evaluate();
    } else {
      // On the videos view: ride X's own Photos item (the one not naming
      // the current tab); the arrival watcher builds the grid on landing.
      const tab = selectedMediaTab();
      const tabText = tab ? tabOriginalLabel(tab) : "";
      const photos = realMenuItems(menu)
        .find((other) => (other.textContent ?? "").trim() !== tabText);
      selfClicking = true;
      try {
        photos?.click();
      } finally {
        selfClicking = false;
      }
      if (!photos) closeMenu();
    }
    return;
  }
  // A REAL item in the media menu is an explicit choice of X's own view,
  // and it persists like the Mosaic pick does. Which view it names is
  // read structurally, never by word (the labels follow the UI
  // language): the item wearing the tab's own label IS the current view,
  // and the other item is the other one.
  const tab = selectedMediaTab();
  const tabText = tab ? tabOriginalLabel(tab) : "";
  override = "feed";
  // No tab to compare against means no idea which item this was; stand
  // down without rewriting the stored default on a guess.
  if (tabText) {
    const current = onPhotosFeed() ? "photos" : "videos";
    const picked = (item.textContent ?? "").trim() === tabText
      ? current
      : current === "photos" ? "videos" : "photos";
    void chrome.storage.local.set({ mediaview: picked });
  }
  deactivate();
}

// --- wiring ----------------------------------------------------------------

export function initMosaic(): void {
  // Before anything else: what this tab already learned about the rate
  // window. Without it, a reload while limited boots blind and a
  // backing-off X teaches nothing (see loadRateState).
  loadRateState();
  watchGraphql();
  // Payloads from the MAIN-world interceptor: a JSON string in the event
  // detail (strings cross the isolated-world boundary unambiguously).
  document.addEventListener("xtag:media-payload", (event) => {
    const detail = (event as CustomEvent).detail;
    if (typeof detail !== "string") return;
    try {
      const parsed = JSON.parse(detail) as {
        url?: unknown; body?: unknown; status?: unknown;
        remaining?: unknown; reset?: unknown; limit?: unknown; kind?: unknown;
      };
      // A profile payload only carries the media_count ceiling; it spends
      // a different rate bucket, so it must not touch the driver's budget.
      if (parsed.kind === "profile") {
        if (typeof parsed.body === "string" && parsed.body) {
          applyProfileCount(parsed.body);
        }
        return;
      }
      // The budget lesson rides EVERY forwarded response, success or not.
      noteRateHeaders(
        typeof parsed.remaining === "string" ? parsed.remaining : null,
        typeof parsed.reset === "string" ? parsed.reset : null,
        typeof parsed.limit === "string" ? parsed.limit : null);
      if (parsed.status === 429) {
        noteRate429();
        // Now, not on the next mutation batch: X can render its error
        // view and then go quiet, and a batch may never come.
        assertRateNotice();
        console.warn("[xtag] X answered 429 on the photos timeline; "
          + "grid loading pauses until the window resets");
        return;
      }
      if (typeof parsed.url === "string" && typeof parsed.body === "string"
        && parsed.body) {
        passivePages++;
        handleMediaPayload(parsed.url, parsed.body);
      }
    } catch { /* not a payload of ours */ }
  });
  // The handshake half of the interceptor's init-race queue: this script
  // registers at document_idle while the interceptor emits from
  // document_start, so the earliest payloads (UserByScreenName above
  // all) would dispatch into nothing on a full page load. Telling the
  // interceptor we exist makes it replay everything it queued.
  document.dispatchEvent(new CustomEvent("xtag:media-listen"));
  document.addEventListener("click", onMenuClick, true);
  // Leaving the grid by click. X handles a tab or nav click at whatever
  // scroll the window is at, and while docked that is thousands of
  // pixels deep. X renders the NEXT view from it (clamp, virtualizer
  // churn, header re-render) before deactivate restores anything, and
  // that churn re-mounts the header nodes our elements live beside, so
  // everything on screen blinks. Snapping back to the dock point in the
  // CAPTURE phase, before X's own handler runs, makes a grid exit
  // identical to a plain tab switch. (The dropdown's Photos/Videos
  // exits already restore first; onMenuClick is capture-phase and
  // deactivates before X's bubble handler.)
  document.addEventListener("click", (event) => {
    if (!active || !docked || navigating) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (overlay && overlay.contains(target)) return;
    if (!target.closest('a[href^="/"], [data-testid="app-bar-back"]')) return;
    window.scrollTo(0, dockScrollY());
  }, true);
  window.addEventListener("resize", placeOverlay);
  // The dock/undock flip rides the window scroll (the user's before the
  // dock, the driver's after it).
  window.addEventListener("scroll", placeOverlay, { passive: true });
  // Escape = back to the plain photos feed (an explicit feed choice). On
  // document, not the overlay: in the undocked mode the overlay is not the
  // focused scroller, so a node-local listener would miss it. Gated on the
  // photos feed so Escape inside the photo viewer stays X's (it closes the
  // viewer, which returns to the grid).
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !active || !onPhotosFeed()) return;
    // A SYNTHETIC ESCAPE IS OURS, NEVER THE READER'S; the same rule
    // onMenuClick follows for synthetic clicks, and for the same reason.
    // closeMenu falls back to dispatching one, so without this the module
    // could hand itself an explicit feed choice nobody made.
    if (!event.isTrusted) return;
    // Escape inside a text field belongs to that field (X's search box
    // closes its typeahead with it); it must not tear the grid down.
    const target = event.target;
    if (target instanceof HTMLElement
      && (target.isContentEditable || target.matches("input, textarea, select"))) {
      return;
    }
    // Per-visit only: Escape does NOT rewrite the stored default. Backing
    // out of a mosaic for one profile is not a decision about every
    // profile; the dropdown and the popup are where that decision lives.
    override = "feed";
    deactivate();
  });

  let lastHref = location.href;
  subscribeToMutations((mutations) => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      evaluate();
    }
    for (const mutation of mutations) {
      if (mutation.type !== "childList") continue;
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        const menu = node.closest<HTMLElement>('[role="menu"]') ?? null;
        if (menu) injectGridItem(menu);
        node.querySelectorAll<HTMLElement>('[role="menu"]').forEach(injectGridItem);
      });
    }
    // Placement rides every batch too, not just the driver's beat: a
    // React commit that moves the tab bar lands here BEFORE the frame
    // paints, so the overlay is corrected in the same frame (the
    // ResizeObserver in watchColumn covers the size changes; this
    // covers node swaps).
    if (active) placeOverlay();
    // The tab wears the grid's name while the grid is the view on
    // screen, X's ✓ stays off the Photos item (React re-renders restore
    // both, so re-assert per batch), an open menu or hover card gets
    // its clip-path hole (see punchHole), and a rate-limited native
    // photos view gets its notice.
    assertTabLabel();
    assertMenuChecks();
    syncHole();
    assertRateNotice();
    assertQuotaPill();
  });
  // A popup change applies on the spot in every open tab. The override
  // is cleared first: the reader just made a NEW choice, and a stale
  // per-visit Escape must not outrank it.
  chrome.storage.onChanged.addListener((changes) => {
    if (!changes["mediaview"]) return;
    override = null;
    evaluate();
  });
  // The first evaluation waits for the initial storage reads: the getter
  // answers "photos" until then, and a direct load of the photos URL
  // with a stored grid default would otherwise never activate. The rate
  // notice gets its first look here too: with the picture restored from
  // sessionStorage, a page that renders X's error before document_idle
  // and then goes quiet would otherwise never show it.
  void settingsReady().then(() => {
    evaluate();
    assertRateNotice();
    assertQuotaPill();
  });
}
