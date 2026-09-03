// Runs in the page's own world at document_start. Three jobs:
//
//   1. Flip two of X's feature flags before X reads them.
//   2. Open the Media tab on the photo grid.
//   3. Route the Likes tab's click through X's router.
//
// chrome.storage is not reachable from here in time, so the content script
// mirrors the switches into localStorage (see core/native.ts). What this
// script did is written to a <html> attribute for the content script.
(() => {
  const MIRROR_KEY = "xtag:flags";
  const NATIVE_ATTR = "data-xtag-native";

  interface Switches { mediagrid: boolean; likestab: boolean; postgrid: boolean }
  const readSwitches = (): Switches => {
    const defaults: Switches = { mediagrid: true, likestab: true, postgrid: false };
    try {
      const raw = localStorage.getItem(MIRROR_KEY);
      if (!raw) return defaults;
      const s = JSON.parse(raw) as Record<string, unknown>;
      return {
        mediagrid: s["mediagrid"] !== false,
        likestab: s["likestab"] !== false,
        postgrid: s["postgrid"] === true,
      };
    } catch {
      return defaults;
    }
  };

  // --- Flags ---------------------------------------------------------------
  // X ships every feature flag inline in window.__INITIAL_STATE__. Two of
  // them, set to false, bring back code X still ships:
  //
  //   responsive_web_history_screen_enabled: /<handle>/likes renders under
  //     the profile instead of redirecting to /i/history/likes. X's History
  //     page stops working while this is off.
  //   rweb_media_carousel_enabled: the 2x2 photo grid inside posts instead
  //     of the slider.
  //
  // X reads a flag as `customOverrides[key] ?? user.config[key].value`, so
  // both are written. The override survives the later settings re-fetch.
  const HISTORY = "responsive_web_history_screen_enabled";
  const CAROUSEL = "rweb_media_carousel_enabled";

  type FlagConfig = Record<string, { value?: unknown } | undefined>;
  interface FeatureSwitch {
    defaultConfig?: FlagConfig;
    user?: { config?: FlagConfig };
    customOverrides?: Record<string, unknown>;
  }

  const patchFlags = (state: unknown): void => {
    if (!state || typeof state !== "object") return;
    const fs = (state as { featureSwitch?: FeatureSwitch }).featureSwitch;
    if (!fs || typeof fs !== "object") return;
    const configs = [fs.defaultConfig, fs.user?.config]
      .filter((c): c is FlagConfig => !!c && typeof c === "object");
    const present = (key: string): boolean => configs.some((c) => {
      const flag = c[key];
      return !!flag && typeof flag === "object";
    });
    const sw = readSwitches();
    const wanted = new Set<string>();
    if (sw.likestab) wanted.add(HISTORY);
    if (sw.postgrid) wanted.add(CAROUSEL);
    const flipped = new Set<string>();
    const overrides: Record<string, boolean> = {};
    for (const key of wanted) {
      if (!present(key)) continue;
      for (const c of configs) {
        const flag = c[key];
        if (flag && typeof flag === "object") flag.value = false;
      }
      overrides[key] = false;
      flipped.add(key);
    }
    if (flipped.size > 0) {
      fs.customOverrides = { ...(fs.customOverrides ?? {}), ...overrides };
    }
    // Which flags were flipped, and which X still ships. The popup warns
    // when a switch is on for a flag X removed.
    const report = {
      likes: flipped.has(HISTORY),
      postgrid: flipped.has(CAROUSEL),
      flags: { history: present(HISTORY), carousel: present(CAROUSEL) },
    };
    document.documentElement.setAttribute(NATIVE_ATTR, JSON.stringify(report));
  };

  // X's inline boot script assigns window.__INITIAL_STATE__ once, after
  // this script runs. A plain property would take the assignment silently,
  // so the global is replaced with an accessor that patches whatever X
  // stores. The accessor stays configurable because X deletes the global
  // after boot. Hooking the state this way, instead of rewriting X's
  // script, is a widely used pattern; see THIRD_PARTY_NOTICES.md.
  const STATE_KEY = "__INITIAL_STATE__";
  const hookBootState = (): void => {
    const win = window as unknown as Record<string, unknown>;
    let held: unknown = Object.hasOwn(win, STATE_KEY) ? win[STATE_KEY] : undefined;
    if (held !== undefined) patchFlags(held);
    Object.defineProperty(win, STATE_KEY, {
      configurable: true,
      enumerable: true,
      get() { return held; },
      set(next: unknown) {
        held = next;
        patchFlags(next);
      },
    });
  };
  try {
    hookBootState();
  } catch {
    // Leave X alone. Without the attribute the popup reports nothing flipped.
  }

  // --- X's router ----------------------------------------------------------
  // Two clicks below have to navigate through X's own router. A pushState
  // plus a synthetic popstate would work, but X treats a popstate as a
  // history traversal and restores the scroll position it keeps per path,
  // so the page jumps. X's tab links push `{lockScroll: true}`, which holds
  // the page still. The history object sits in the props of an element a
  // few fibers below #react-root. If it cannot be found, the popstate path
  // is the fallback.
  interface XHistory {
    push(path: string, state?: Record<string, unknown>): void;
    replace(path: string, state?: Record<string, unknown>): void;
  }
  interface Fiber { child?: Fiber | null; memoizedProps?: { history?: unknown } | null }
  const xHistory = (): XHistory | null => {
    try {
      const root = document.getElementById("react-root") as
        (HTMLElement & Record<string, unknown>) | null;
      const key = root && Object.keys(root).find((k) => k.startsWith("__reactContainer"));
      let fiber = key ? (root[key] as Fiber | undefined) : undefined;
      for (let hops = 0; fiber && hops < 40; hops++) {
        const h = fiber.memoizedProps?.history as Partial<XHistory> | undefined;
        if (h && typeof h.push === "function" && typeof h.replace === "function") {
          return h as XHistory;
        }
        fiber = fiber.child ?? undefined;
      }
    } catch { /* not X's tree */ }
    return null;
  };
  const TAB_STATE = { lockScroll: true };
  // Modifier clicks (new tab, new window) belong to the browser.
  const modified = (e: MouseEvent): boolean =>
    e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;

  // --- Media tab -----------------------------------------------------------
  // X's Media tab opens on Videos. Photos mode is the same page with
  // `?filter=photo`; there is no flag. Two ways in:
  //
  //   Direct load of /<handle>/media: rewrite the URL before X boots.
  //   Click on the tab: take the click and push the photo URL through X's
  //     router with X's tab state.
  //
  // Fallback without the router: let X's own push finish, then replace the
  // entry's URL and fire a popstate on the next task. X's router routes
  // from its own copy of the location, so rewriting the push itself does
  // not work, and a popstate fired inside pushState gets overwritten.
  //
  // Only a click on an unselected Media tab is touched. Picking Videos from
  // the tab's dropdown pushes the same bare path, and that has to stay.
  const MEDIA_PATH_RE = /^\/[A-Za-z0-9_]{1,15}\/media\/?$/;
  const PHOTO_QUERY = "?filter=photo";
  const ARM_TTL_MS = 2000;

  const mediaPath = (url: string | URL | null | undefined): string | null => {
    if (url === undefined || url === null) return null;
    try {
      const to = new URL(String(url), location.href);
      if (to.origin !== location.origin || to.search || to.hash) return null;
      return MEDIA_PATH_RE.test(to.pathname) ? to.pathname.replace(/\/$/, "") : null;
    } catch {
      return null;
    }
  };

  try {
    if (readSwitches().mediagrid && mediaPath(location.href)) {
      history.replaceState(history.state, "", location.pathname + PHOTO_QUERY);
    }
  } catch { /* leave the URL alone */ }

  let armed: { path: string; until: number } | null = null;
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const tab = target.closest<HTMLAnchorElement>('a[role="tab"]');
    if (!tab || tab.getAttribute("aria-selected") === "true") return;
    const path = mediaPath(tab.getAttribute("href") ?? "");
    if (!path || modified(event)) return;
    if (!readSwitches().mediagrid) { armed = null; return; }
    armed = null;
    const h = xHistory();
    if (h) {
      try {
        h.push(path + PHOTO_QUERY, TAB_STATE);
        event.preventDefault();
        event.stopPropagation();
        return;
      } catch { /* fall back below */ }
    }
    armed = { path, until: Date.now() + ARM_TTL_MS };
  }, true);

  const origPush = History.prototype.pushState;
  const origReplace = History.prototype.replaceState;
  History.prototype.pushState = function (
    this: History, state: unknown, title: string, url?: string | URL | null,
  ) {
    const ret = origPush.call(this, state, title, url);
    try {
      const arm = armed;
      if (arm && Date.now() < arm.until && mediaPath(url) === arm.path) {
        armed = null;
        const target = arm.path + PHOTO_QUERY;
        setTimeout(() => {
          if (location.pathname.replace(/\/$/, "") !== arm.path || location.search) return;
          origReplace.call(history, history.state, "", target);
          dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
        }, 0);
      }
    } catch { /* never break the page's own navigation */ }
    return ret;
  };

  // --- Likes tab -----------------------------------------------------------
  // likes-tab.ts adds the tab as a clone of one of X's, so it has none of
  // X's click handlers. Without this, a click is a full page load.
  const LIKES_TAB_ATTR = "data-xtag-likes-tab";
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const tab = target.closest<HTMLAnchorElement>(`a[${LIKES_TAB_ATTR}]`);
    if (!tab || modified(event)) return;
    const href = tab.getAttribute("href");
    if (!href) return;
    event.preventDefault();
    event.stopPropagation();
    const h = xHistory();
    if (h) {
      try {
        h.push(href, TAB_STATE);
        return;
      } catch { /* fall back below */ }
    }
    // X's entries carry a random key; match the shape so Back stays sane.
    const key = Math.random().toString(36).slice(2, 8);
    origPush.call(history, { key, state: undefined }, "", href);
    setTimeout(() => {
      dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    }, 0);
  }, true);

  // --- Media-timeline tap (mosaic.ts) --------------------------------------
  // The grid must not fetch pages of its own by default: replays spend
  // the same per-user rate bucket as X's own feeds, and a few gridded
  // profiles in a row can empty it (429s take the whole site down). So
  // this wraps fetch and XHR in the PAGE's world and hands every
  // photos-timeline response the page fetches anyway to the content
  // script: zero extra requests. Payloads travel as a JSON string in a
  // CustomEvent detail (strings cross the isolated-world boundary
  // unambiguously in both engines).
  //
  // The emit also carries x-rate-limit-remaining/reset (same-origin GraphQL,
  // headers readable) and fires on 429s too, body-less: the mosaic's driver
  // holds a floor on the remaining budget so the bucket is never driven to
  // zero.
  const MEDIA_RE = /\/i\/api\/graphql\/[^/]+\/[^/?]*(?:PhotoTimeline|UserMedia)/;
  // UserByScreenName carries legacy.media_count, X's own exact total for
  // the profile's media tab. The mosaic uses it as a CEILING end signal
  // (the one that exists even when X serves a revisited view from its
  // client cache and no timeline payload ever arrives). kind="profile"
  // payloads carry NO rate headers on purpose: that endpoint spends a
  // DIFFERENT bucket than the photos timeline, and forwarding its numbers
  // would poison the driver's rate floor.
  const PROFILE_RE = /\/i\/api\/graphql\/[^/]+\/UserByScreenName/;

  // The init race: this script runs at document_start and X's first
  // fetches land within ~1s, but the isolated-world listener registers
  // at document_idle. On a full page load the earliest payloads
  // (UserByScreenName above all, sometimes the page-1 timeline too)
  // would dispatch into nothing and be lost, which starves the
  // media_count end signal on exactly the small profiles that need it.
  // So emissions QUEUE until the content script says it is listening
  // (the xtag:media-listen handshake), then replay.
  let listenerReady = false;
  const pendingPayloads: string[] = [];
  const PENDING_MAX = 20;

  const dispatchPayload = (detail: string): void => {
    document.dispatchEvent(new CustomEvent("xtag:media-payload", { detail }));
  };

  // `path` is location.pathname as the REQUEST left, not as the answer
  // landed: a response can arrive after the reader hops to the next
  // profile, and the content script keys every end signal and cursor on
  // the profile the page was asked for, never the one it arrived under.
  const emit = (url: string, body: string, status: number,
    remaining: string | null, reset: string | null,
    limit: string | null, kind: string, path: string): void => {
    const detail = JSON.stringify({ url, body, status, remaining, reset, limit, kind, path });
    if (listenerReady) {
      dispatchPayload(detail);
      return;
    }
    pendingPayloads.push(detail);
    if (pendingPayloads.length > PENDING_MAX) pendingPayloads.shift();
  };

  document.addEventListener("xtag:media-listen", () => {
    listenerReady = true;
    for (const detail of pendingPayloads.splice(0)) dispatchPayload(detail);
  });

  const origFetch = window.fetch;
  window.fetch = async function (...args: Parameters<typeof fetch>) {
    const path = location.pathname;
    const resp = await origFetch.apply(this, args);
    try {
      const first = args[0];
      const url = typeof first === "string"
        ? first
        : first instanceof Request ? first.url : String(first);
      if (MEDIA_RE.test(url)) {
        const remaining = resp.headers.get("x-rate-limit-remaining");
        const reset = resp.headers.get("x-rate-limit-reset");
        const limit = resp.headers.get("x-rate-limit-limit");
        if (resp.ok) {
          resp.clone().text()
            .then((body) => emit(url, body, resp.status, remaining, reset, limit, "media", path))
            .catch(() => { /* stream gone */ });
        } else {
          // A failed page still teaches: a 429 (or any refusal) carries
          // the budget headers the driver paces itself by.
          emit(url, "", resp.status, remaining, reset, limit, "media", path);
        }
      } else if (PROFILE_RE.test(url) && resp.ok) {
        resp.clone().text()
          .then((body) => emit(url, body, resp.status, null, null, null, "profile", path))
          .catch(() => { /* stream gone */ });
      }
    } catch { /* never break the page's own fetch */ }
    return resp;
  };

  // A version marker page-context probes can read (fetch.toString() shows
  // only the wrapper body, which barely changes between builds). Bump
  // when the tap's behavior changes.
  try {
    (window.fetch as typeof window.fetch & { __xtagV?: number }).__xtagV = 8;
  } catch { /* marker only */ }

  // X's app is fetch-based; the XHR wrap is the belt.
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest & { __xtagUrl?: string; __xtagPath?: string; __xtagHooked?: boolean },
    method: string,
    url: string | URL,
    isAsync?: boolean,
    username?: string | null,
    password?: string | null,
  ) {
    this.__xtagUrl = String(url);
    this.__xtagPath = location.pathname;
    // One listener per XHR instance: open() may legally be called again on
    // the same object, and stacking a listener per call double-emitted the
    // payload (harmless, tiles dedupe, but wasted parse work).
    if (this.__xtagHooked) {
      return origOpen.call(this, method, url, isAsync ?? true, username, password);
    }
    this.__xtagHooked = true;
    this.addEventListener("load", function (
      this: XMLHttpRequest & { __xtagUrl?: string; __xtagPath?: string },
    ) {
      try {
        if (!this.__xtagUrl) return;
        const path = this.__xtagPath ?? location.pathname;
        // The responseText GETTER throws for a non-text responseType
        // ("json", "arraybuffer", "blob"); typeof does not guard the
        // access, and the throw used to abort this whole handler, body
        // and headers both. Gate on responseType instead, and mirror
        // the fetch tap's statuses: body for any 2xx that is readable,
        // headers alone for every other completed answer.
        const textual = this.responseType === "" || this.responseType === "text";
        const ok = this.status >= 200 && this.status < 300;
        if (MEDIA_RE.test(this.__xtagUrl)) {
          const remaining = this.getResponseHeader("x-rate-limit-remaining");
          const reset = this.getResponseHeader("x-rate-limit-reset");
          const limit = this.getResponseHeader("x-rate-limit-limit");
          if (ok && textual) {
            emit(this.__xtagUrl, this.responseText, this.status, remaining, reset, limit,
              "media", path);
          } else if (this.status !== 0) {
            emit(this.__xtagUrl, "", this.status, remaining, reset, limit, "media", path);
          }
        } else if (PROFILE_RE.test(this.__xtagUrl) && ok && textual) {
          emit(this.__xtagUrl, this.responseText, this.status, null, null, null,
            "profile", path);
        }
      } catch { /* never break the page's own XHR */ }
    });
    return origOpen.call(this, method, url, isAsync ?? true, username, password);
  };
})();
