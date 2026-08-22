// One shared MutationObserver for every feature.
type MutationHandler = (mutations: MutationRecord[]) => void;

const handlers: MutationHandler[] = [];

export function subscribeToMutations(handler: MutationHandler): void {
  handlers.push(handler);
  if (handlers.length > 1) return;
  new MutationObserver((mutations) => {
    for (const h of handlers) h(mutations);
  }).observe(document.body, { childList: true, subtree: true });
}
