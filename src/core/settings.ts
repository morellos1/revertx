// Cached boolean settings. An unset key means on.
const values = new Map<string, boolean>();
const watched = new Set<string>();

// The initial storage reads are async, so a getter answers its DEFAULT
// until its read resolves, and nothing re-fires when it does (onChanged
// only covers changes). Any init-time decision taken from these getters
// must wait on settingsReady(): the 1.x grid once activated on a direct
// photos-feed load for a user whose switch was off, and nothing ever tore
// it down. User-timescale reads (clicks, menu opens) need no wait.
const initialReads: Promise<unknown>[] = [];

export function settingsReady(): Promise<void> {
  return Promise.all(initialReads).then(() => undefined);
}

export function watchSetting(key: string): () => boolean {
  if (!watched.has(key)) {
    watched.add(key);
    values.set(key, true);
    initialReads.push(chrome.storage.local.get(key).then((s) => {
      values.set(key, s[key] !== false);
    }));
  }
  return () => values.get(key) !== false;
}

// String-valued settings (a choice among modes). `read` interprets a whole
// storage snapshot, so a renamed setting can read its predecessors and a
// stray stored value normalizes instead of leaking to callers.
const choices = new Map<string, string>();
const choiceReaders = new Map<string, (stored: Record<string, unknown>) => string>();
// The last full snapshot, kept in step with onChanged. A choice must
// re-read from the WHOLE snapshot (that is the predecessor-key
// contract above; a synthetic one-key snapshot hides the legacy keys),
// and it must do so SYNCHRONOUSLY: listeners registered after this
// module (mosaic's own onChanged) read the cache in the same tick.
const snapshot: Record<string, unknown> = {};

export function watchChoice(
  key: string,
  read: (stored: Record<string, unknown>) => string,
): () => string {
  if (!choiceReaders.has(key)) {
    choiceReaders.set(key, read);
    choices.set(key, read({}));
    initialReads.push(chrome.storage.local.get(null).then((s) => {
      Object.assign(snapshot, s);
      choices.set(key, read(snapshot));
    }));
  }
  return () => choices.get(key) ?? read({});
}

chrome.storage.onChanged.addListener((changes) => {
  for (const key of watched) {
    if (changes[key]) values.set(key, changes[key].newValue !== false);
  }
  for (const key of Object.keys(changes)) {
    if (changes[key].newValue === undefined) delete snapshot[key];
    else snapshot[key] = changes[key].newValue;
  }
  for (const [key, read] of choiceReaders) choices.set(key, read(snapshot));
});

// The Media-tab default. One value, three generations of keys: 2.1
// writes `mediaview` ("photos" | "mosaic" | "videos"). 2.0 wrote the
// `mediagrid` boolean; 1.x wrote `mediaview` ("grid" | "photos" |
// "videos") and before that a `mediaphotos` boolean. Anything that
// meant videos still means videos, and 1.x's "grid" maps to the native
// photo grid. "masonry" existed only in unreleased builds; it maps to
// the surviving view.
export function readMediaView(stored: Record<string, unknown>): string {
  const v = stored["mediaview"];
  if (v === "photos" || v === "mosaic" || v === "videos") return v;
  if (v === "masonry") return "mosaic";
  if (v === "grid") return "photos";
  if (typeof stored["mediagrid"] === "boolean") {
    return stored["mediagrid"] ? "photos" : "videos";
  }
  if (stored["mediaphotos"] === false) return "videos";
  return "photos";
}

// The half the interceptor mirror needs: does the Media tab open on the
// photos URL (both photo views ride ?filter=photo) or stay on Videos.
export function readMediaGrid(stored: Record<string, unknown>): boolean {
  return readMediaView(stored) !== "videos";
}
