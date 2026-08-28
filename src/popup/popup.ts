import { NATIVE_KEY, type NativeReport } from "../core/native";
import { readMediaView } from "../core/settings";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const KEYS = ["likestab", "postgrid", "sharecopy"] as const;

for (const key of KEYS) {
  const box = $<HTMLInputElement>(key);
  box.addEventListener("change", () => {
    void chrome.storage.local.set({ [key]: box.checked });
  });
}

// The Media default is a 3-way choice (photos | mosaic | videos), one
// stored `mediaview` string shared with the dropdown picks on the page.
// The loading note shows while Mosaic is the pick; the other two views
// are X's own and load nothing. The note is the one place the cost is
// said up front: a second line on the injected menu item overflows X's
// panel.
const view = $<HTMLSelectElement>("mediaview");

function syncMosaicNote(): void {
  $("mosaic-note").hidden = view.value !== "mosaic";
}

view.addEventListener("change", () => {
  void chrome.storage.local.set({ mediaview: view.value });
  syncMosaicNote();
});

// The photo-loading budget, as X last reported it to a page: shown
// while the window it describes is still running, hidden after it
// resets (the numbers are then stale by definition). A 1s tick keeps
// the countdown honest while the popup is open.
const rateLine = $("rate-line");
interface RateSnapshot { remaining?: unknown; limit?: unknown; resetAt?: unknown }
let rate: RateSnapshot | null = null;

function renderRate(): void {
  const remaining = typeof rate?.remaining === "number" ? rate.remaining : null;
  const resetAt = typeof rate?.resetAt === "number" ? rate.resetAt : 0;
  const left = resetAt - Date.now();
  if (remaining === null || left <= 0) {
    rateLine.hidden = true;
    return;
  }
  const back = `${Math.floor(left / 60_000)}m ${Math.floor((left % 60_000) / 1000)}s`;
  const limit = typeof rate?.limit === "number" ? ` of ${rate.limit}` : "";
  rateLine.textContent = remaining === 0
    ? `Photo loading: used up · back in ${back}`
    : `Photo loading: ${remaining}${limit} left · resets in ${back}`;
  rateLine.hidden = false;
}
window.setInterval(renderRate, 1000);

// Warn when a switch is on for a flag X no longer ships.
function showWarnings(report: NativeReport | null | undefined, on: Record<string, boolean>): void {
  const flags = report?.flags;
  $("likestab-warn").hidden = !(on["likestab"] && !!flags && !flags.history);
  $("postgrid-warn").hidden = !(on["postgrid"] && !!flags && !flags.carousel);
}

(async () => {
  // The whole snapshot: readMediaView reads three generations of keys.
  const stored = await chrome.storage.local.get(null);
  const on: Record<string, boolean> = {
    likestab: stored["likestab"] !== false,
    postgrid: stored["postgrid"] === true,
    sharecopy: stored["sharecopy"] !== false,
  };
  for (const key of KEYS) $<HTMLInputElement>(key).checked = on[key];
  view.value = readMediaView(stored);
  syncMosaicNote();
  rate = stored["rate"] as RateSnapshot | null;
  renderRate();
  let report = stored[NATIVE_KEY] as NativeReport | null;
  showWarnings(report, on);
  chrome.storage.onChanged.addListener((changes) => {
    for (const key of KEYS) {
      if (changes[key]) on[key] = changes[key].newValue === true;
    }
    // A dropdown pick on the page while the popup is open: follow it.
    if (changes["mediaview"]) {
      view.value = readMediaView({ mediaview: changes["mediaview"].newValue });
      syncMosaicNote();
    }
    if (changes["rate"]) {
      rate = changes["rate"].newValue as RateSnapshot | null;
      renderRate();
    }
    if (changes[NATIVE_KEY]) report = changes[NATIVE_KEY].newValue as NativeReport | null;
    showWarnings(report, on);
  });
})();
