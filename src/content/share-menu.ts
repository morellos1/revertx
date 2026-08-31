// Moves "Copy link" back to the top of the post share menu. Only a menu
// that contains a "Copy link" item is touched.
import { watchSetting } from "../core/settings";
import { subscribeToMutations } from "./observer";

const COPY_LINK_RE = /copy\s*link/i;
const MENU_SELECTOR = '[role="menu"], [data-testid="Dropdown"]';

// The child of `ancestor` that contains `node`.
function findDirectChildOf(ancestor: HTMLElement, node: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = node;
  while (current && current.parentElement !== ancestor) {
    current = current.parentElement;
  }
  return current;
}

function reorderShareMenu(menu: HTMLElement): void {
  const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  if (items.length < 2) return;
  const first = items[0];
  const copyItem = items.find((item) => COPY_LINK_RE.test(item.textContent ?? ""));
  if (!copyItem || copyItem === first) return;

  // Move at the lowest common ancestor, so it works whether or not each
  // item has its own wrapper.
  const copyAncestors = new Set<HTMLElement>();
  for (let node: HTMLElement | null = copyItem; node && node !== menu; node = node.parentElement) {
    copyAncestors.add(node);
  }
  copyAncestors.add(menu);
  let lca: HTMLElement | null = first;
  while (lca && !copyAncestors.has(lca)) lca = lca.parentElement;
  if (!lca) return;

  const copyBranch = findDirectChildOf(lca, copyItem);
  const firstBranch = findDirectChildOf(lca, first);
  if (!copyBranch || !firstBranch || copyBranch === firstBranch) return;
  lca.insertBefore(copyBranch, firstBranch);
}

// Items may arrive after the menu container, so check the enclosing menu
// as well as descendants.
function collectMenus(node: HTMLElement, into: Set<HTMLElement>): void {
  const enclosing = node.closest<HTMLElement>(MENU_SELECTOR);
  if (enclosing) into.add(enclosing);
  node.querySelectorAll<HTMLElement>(MENU_SELECTOR).forEach((menu) => into.add(menu));
}

export function initShareMenu(): void {
  const enabled = watchSetting("sharecopy");
  subscribeToMutations((mutations) => {
    if (!enabled()) return;
    // No menu in the document means no added node can hold one (the
    // observer runs after the change), and a menu is open a fraction
    // of a percent of the time: one presence query gates the
    // per-added-node closest/querySelectorAll scans off the common
    // batch.
    if (!document.querySelector(MENU_SELECTOR)) return;
    const menus = new Set<HTMLElement>();
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement) collectMenus(node, menus);
      });
    }
    menus.forEach(reorderShareMenu);
  });
}
