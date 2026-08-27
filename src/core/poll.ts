// Poll `fn` until it returns non-null or `timeoutMs` passes. One helper —
// media-grid and media-tab each carried their own copy of this loop.
export async function pollFor<T>(
  fn: () => T | null,
  timeoutMs: number,
  intervalMs = 60,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== null) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
