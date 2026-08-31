// One shared MutationObserver for every feature.
type MutationHandler = (mutations: MutationRecord[]) => void;

const handlers: MutationHandler[] = [];

export function subscribeToMutations(handler: MutationHandler): void {
  handlers.push(handler);
  if (handlers.length > 1) return;
  new MutationObserver((mutations) => {
    // Isolated per handler: one feature throwing on a DOM shape it
    // mishandles must not starve the features registered after it.
    for (const h of handlers) {
      try {
        h(mutations);
      } catch (error) {
        console.warn("[xtag] mutation handler failed:", error);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}
