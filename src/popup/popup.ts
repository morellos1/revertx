import { NATIVE_KEY, type NativeReport } from "../core/native";
import { readMediaGrid } from "../core/settings";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const KEYS = ["mediagrid", "likestab", "postgrid", "sharecopy"] as const;

for (const key of KEYS) {
  const box = $<HTMLInputElement>(key);
  box.addEventListener("change", () => {
    void chrome.storage.local.set({ [key]: box.checked });
  });
}

// Warn when a switch is on for a flag X no longer ships.
function showWarnings(report: NativeReport | null | undefined, on: Record<string, boolean>): void {
  const flags = report?.flags;
  $("likestab-warn").hidden = !(on["likestab"] && !!flags && !flags.history);
  $("postgrid-warn").hidden = !(on["postgrid"] && !!flags && !flags.carousel);
}

(async () => {
  const stored = await chrome.storage.local.get(
    [...KEYS, "mediaview", "mediaphotos", NATIVE_KEY]);
  const on: Record<string, boolean> = {
    mediagrid: readMediaGrid(stored),
    likestab: stored["likestab"] !== false,
    postgrid: stored["postgrid"] === true,
    sharecopy: stored["sharecopy"] !== false,
  };
  for (const key of KEYS) $<HTMLInputElement>(key).checked = on[key];
  let report = stored[NATIVE_KEY] as NativeReport | null;
  showWarnings(report, on);
  chrome.storage.onChanged.addListener((changes) => {
    for (const key of KEYS) {
      if (changes[key]) on[key] = changes[key].newValue === true;
    }
    if (changes[NATIVE_KEY]) report = changes[NATIVE_KEY].newValue as NativeReport | null;
    showWarnings(report, on);
  });
})();
