// The Likes tab in the profile strip.
//
// With the history flag off (interceptor.ts), X renders /<handle>/likes
// under your own profile header, but it does not draw the tab. This adds
// one anchor to the strip on your own profile. The anchor is a clone of
// one of X's tabs, so it looks right in either theme. The selected look is
// cloned from X's selected tab when one is on screen and kept in
// sessionStorage for a direct load of the likes route; with nothing cached,
// inline styles approximate it. The click is handled in interceptor.ts.
import { settingsReady, watchSetting } from "../core/settings";
import { subscribeToMutations } from "./observer";

const TAB_ATTR = "data-xtag-likes-tab";
const BOX_ATTR = "data-xtag-likes-box";
const TEMPLATE_KEY = "xtag:likes-tab-selected";
const LIKES_RE = /^\/([A-Za-z0-9_]{1,15})\/likes\/?$/i;
const PROFILE_RE = /^\/([A-Za-z0-9_]{1,15})\/?$/;

const enabled = watchSetting("likestab");

// Your own handle, from the sidebar's Profile link.
function ownHandle(): string | null {
  const link = document.querySelector<HTMLAnchorElement>(
    '[data-testid="AppTabBar_Profile_Link"]');
  const m = link?.getAttribute("href")?.match(PROFILE_RE);
  return m ? m[1].toLowerCase() : null;
}

// The profile strip: the tablist whose first tab links to /<handle>.
function profileStrip(): { strip: HTMLElement; handle: string } | null {
  for (const strip of Array.from(document.querySelectorAll<HTMLElement>('main [role="tablist"]'))) {
    const first = strip.querySelector<HTMLAnchorElement>('a[role="tab"]');
    const m = first?.getAttribute("href")?.match(PROFILE_RE);
    if (m) return { strip, handle: m[1] };
  }
  return null;
}

// Remove the tab and its wrapper. X's tabs are flex children that share
// the row, so an empty wrapper left behind squeezes the real tabs.
function removeTab(): void {
  document.querySelectorAll(`[${BOX_ATTR}], [${TAB_ATTR}]`)
    .forEach((node) => node.remove());
}

function firstTextNode(root: Node): Text | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if ((node.textContent ?? "").trim()) return node as Text;
  }
  return null;
}

function onLikesRoute(handle: string): boolean {
  const m = location.pathname.match(LIKES_RE);
  return !!m && m[1].toLowerCase() === handle.toLowerCase();
}

// Remember what X's selected tab looks like whenever one is on screen.
let remembered: string | null = null;
// The node the template last came from. Serializing innerHTML is a
// multi-KB string per call and this runs on every mutation batch of a
// profile page; the selected tab's NODE only changes when X remounts
// the strip (measured: it remounts per tab switch), so the element
// identity is the cheap gate in front of the serialization.
let rememberedFrom: Element | null = null;
function rememberSelected(strip: HTMLElement): void {
  const selected = strip.querySelector<HTMLAnchorElement>(
    `a[role="tab"][aria-selected="true"]:not([${TAB_ATTR}])`);
  if (!selected || selected === rememberedFrom) return;
  rememberedFrom = selected;
  const html = selected.innerHTML;
  if (html === remembered) return;
  remembered = html;
  try {
    sessionStorage.setItem(TEMPLATE_KEY, html);
  } catch { /* fallback styles will do */ }
}

// The selected look with nothing to clone: a bold label and a 4px underline,
// in colours read off the page so they follow the theme. The accent comes
// from a link in the bio; the sidebar's Post button is white on Premium.
function styleSelectedFallback(tab: HTMLElement): void {
  const label = firstTextNode(tab)?.parentElement;
  if (label) {
    const ink = getComputedStyle(document.querySelector("main h2") ?? document.body).color;
    label.style.color = ink;
    label.style.fontWeight = "700";
  }
  const accentSource = document.querySelector(
    '[data-testid="UserDescription"] a, [data-testid="UserUrl"]');
  const accent = accentSource ? getComputedStyle(accentSource).color : "rgb(29, 155, 240)";
  const bar = document.createElement("div");
  bar.style.cssText = `position:absolute;left:0;right:0;bottom:0;height:4px;border-radius:9999px;background-color:${accent};`;
  const box = label?.parentElement ?? tab;
  box.style.position = "relative";
  box.appendChild(bar);
}

function buildTab(strip: HTMLElement, handle: string, selected: boolean): HTMLAnchorElement | null {
  const tabs = Array.from(strip.querySelectorAll<HTMLAnchorElement>(`a[role="tab"]:not([${TAB_ATTR}])`));
  if (tabs.length === 0) return null;
  const unselected = tabs.find((t) => t.getAttribute("aria-selected") !== "true") ?? tabs[0];
  const tab = unselected.cloneNode(true) as HTMLAnchorElement;
  tab.setAttribute(TAB_ATTR, "");
  tab.setAttribute("href", `/${handle}/likes`);
  tab.setAttribute("aria-selected", selected ? "true" : "false");
  tab.removeAttribute("id");
  tab.tabIndex = selected ? 0 : -1;
  let template: string | null = null;
  if (selected) {
    try { template = sessionStorage.getItem(TEMPLATE_KEY); } catch { /* none */ }
    if (template) {
      const doc = new DOMParser().parseFromString(template, "text/html");
      tab.replaceChildren(...Array.from(doc.body.childNodes));
    }
  }
  // The template usually comes from the Posts tab, which has a dropdown
  // chevron. Likes has no menu.
  tab.querySelectorAll("svg").forEach((svg) => svg.remove());
  const text = firstTextNode(tab);
  if (!text) return null;
  text.textContent = "Likes";
  if (selected && !template) styleSelectedFallback(tab);
  return tab;
}

// Idempotent; runs per mutation batch because X re-renders the strip on
// every route change.
function evaluate(): void {
  const found = profileStrip();
  const existing = document.querySelector<HTMLAnchorElement>(`[${TAB_ATTR}]`);
  const own = ownHandle();
  if (!found || !enabled() || !own || found.handle.toLowerCase() !== own) {
    removeTab();
    return;
  }
  const { strip, handle } = found;
  rememberSelected(strip);
  const selected = onLikesRoute(handle);
  if (existing && strip.contains(existing)
    && (existing.getAttribute("aria-selected") === "true") === selected) {
    return;
  }
  removeTab();
  const tab = buildTab(strip, handle, selected);
  if (!tab) return;
  // After the last of X's tabs, inside the same kind of wrapper.
  const last = Array.from(strip.querySelectorAll<HTMLAnchorElement>('a[role="tab"]')).pop();
  if (!last) return;
  const wrapper = last.parentElement === strip ? null : last.parentElement;
  if (wrapper && wrapper.parentElement === strip) {
    const box = wrapper.cloneNode(false) as HTMLElement;
    box.setAttribute(BOX_ATTR, "");
    box.appendChild(tab);
    wrapper.after(box);
  } else {
    last.after(tab);
  }
}

export function initLikesTab(): void {
  chrome.storage.onChanged.addListener((changes) => {
    if (changes["likestab"]) evaluate();
  });
  window.addEventListener("popstate", evaluate);
  subscribeToMutations(evaluate);
  // Not before the storage read: enabled() answers its default (on)
  // until then, and a boot-time evaluate could inject the tab for a
  // reader who turned it off (settings.ts's own init-time rule).
  void settingsReady().then(evaluate);
}
