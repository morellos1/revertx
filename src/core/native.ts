// The content-script side of interceptor.ts: mirror the switches where the
// page world can read them, and copy the boot report back for the popup.
import { readMediaGrid } from "./settings";

const MIRROR_KEY = "xtag:flags";
const NATIVE_ATTR = "data-xtag-native";
export const NATIVE_KEY = "native";

export interface NativeReport {
  likes: boolean;
  postgrid: boolean;
  flags: { history: boolean; carousel: boolean };
}

const SWITCH_KEYS = ["mediagrid", "likestab", "postgrid", "mediaview", "mediaphotos"];

// Keep the switches in localStorage, which the page world can read
// synchronously at document_start.
export function mirrorSwitches(): void {
  const write = (s: Record<string, unknown>, persist: boolean): void => {
    const mediagrid = readMediaGrid(s);
    // First run after the 1.x update: store the migrated value once.
    if (persist && typeof s["mediagrid"] !== "boolean") {
      void chrome.storage.local.set({ mediagrid });
    }
    try {
      localStorage.setItem(MIRROR_KEY, JSON.stringify({
        mediagrid,
        likestab: s["likestab"] !== false,
        postgrid: s["postgrid"] === true,
      }));
    } catch { /* the interceptor falls back to defaults */ }
  };
  void chrome.storage.local.get(SWITCH_KEYS).then((s) => write(s, true));
  chrome.storage.onChanged.addListener((changes) => {
    if (!SWITCH_KEYS.some((k) => changes[k])) return;
    void chrome.storage.local.get(SWITCH_KEYS).then((s) => write(s, false));
  });
}

// Copy the boot report into storage for the popup. If the boot used a
// stale mirror (no x.com tab was open to hear the popup), reload once so
// the next boot matches storage. A sessionStorage note stops a loop.
const RELOAD_NOTE = "xtag:reloaded-for";

export function reportNative(): void {
  const raw = document.documentElement.getAttribute(NATIVE_ATTR);
  let report: NativeReport | null = null;
  if (raw) {
    try {
      const p = JSON.parse(raw) as NativeReport;
      if (p && typeof p === "object" && p.flags) report = p;
    } catch { /* not ours */ }
  }
  void chrome.storage.local.set({ [NATIVE_KEY]: report });
  if (!report) return;
  void chrome.storage.local.get(["likestab", "postgrid"]).then((s) => {
    const want = {
      likes: s["likestab"] !== false && report.flags.history,
      postgrid: s["postgrid"] === true && report.flags.carousel,
    };
    if (want.likes === report.likes && want.postgrid === report.postgrid) return;
    const asked = JSON.stringify(want);
    try {
      if (sessionStorage.getItem(RELOAD_NOTE) === asked) return;
      sessionStorage.setItem(RELOAD_NOTE, asked);
    } catch {
      return;
    }
    location.reload();
  });
}
