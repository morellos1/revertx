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

// The Media default is a 4-way choice now (photos | masonry | mosaic |
// videos), one stored `mediaview` string shared with the dropdown picks
// on the page. Masonry is the column view, Mosaic the justified rows.
// The rate note shows while either revertX flavor is the pick; the
// other two views are X's own and cost nothing. This note is the ONE
// place the cost is said up front; the injected menu items carry no
// second line (they overflowed X's panel; user screenshot 2026-08-27).
const view = $<HTMLSelectElement>("mediaview");

function syncMosaicNote(): void {
  $("mosaic-note").hidden = view.value !== "masonry" && view.value !== "mosaic";
}

view.addEventListener("change", () => {
  void chrome.storage.local.set({ mediaview: view.value });
  syncMosaicNote();
});

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
    if (changes[NATIVE_KEY]) report = changes[NATIVE_KEY].newValue as NativeReport | null;
    showWarnings(report, on);
  });
})();
