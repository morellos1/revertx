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
      // The same polarity as the boot read above: likestab and
      // sharecopy default ON when unset, postgrid defaults OFF. A
      // removed key must not read differently here than there.
      if (changes[key]) {
        const v = changes[key].newValue;
        on[key] = key === "postgrid" ? v === true : v !== false;
      }
    }
    // A dropdown pick on the page while the popup is open: follow it.
    // From the whole snapshot, like the boot read: readMediaView's
    // fallback chain covers the legacy keys, and a one-key snapshot
    // hides them from it.
    if (changes["mediaview"]) {
      void chrome.storage.local.get(null).then((s) => {
        view.value = readMediaView(s);
        syncMosaicNote();
      });
    }
    if (changes[NATIVE_KEY]) report = changes[NATIVE_KEY].newValue as NativeReport | null;
    showWarnings(report, on);
  });
})();
