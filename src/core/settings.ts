// Cached boolean settings. An unset key means on.
const values = new Map<string, boolean>();
const watched = new Set<string>();

export function watchSetting(key: string): () => boolean {
  if (!watched.has(key)) {
    watched.add(key);
    values.set(key, true);
    void chrome.storage.local.get(key).then((s) => {
      values.set(key, s[key] !== false);
    });
  }
  return () => values.get(key) !== false;
}

chrome.storage.onChanged.addListener((changes) => {
  for (const key of watched) {
    if (changes[key]) values.set(key, changes[key].newValue !== false);
  }
});

// The Media-tab switch. 1.x stored it as `mediaview` ("grid" | "photos" |
// "videos") and before that as a `mediaphotos` boolean; either one saying
// videos carries over as off.
export function readMediaGrid(stored: Record<string, unknown>): boolean {
  if (typeof stored["mediagrid"] === "boolean") return stored["mediagrid"];
  if (stored["mediaview"] === "videos") return false;
  if (stored["mediaphotos"] === false) return false;
  return true;
}
