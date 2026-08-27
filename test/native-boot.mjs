// The boot test. Loads the unpacked extension into Chromium and serves a
// fixture under https://x.com/* that boots like X: an inline
// window.__INITIAL_STATE__ with feature flags, a mini main.js that reads
// them the way X does, a profile strip whose tabs push history, and an
// X-shaped history object on a fake React fiber (switched off for the
// fallback cases).
//
// Run:  npm run build && node test/native-boot.mjs
// Needs playwright-core (npm i --no-save playwright-core). XTAG_CHROME
// overrides the browser binary, XTAG_EXT the extension directory. Headful,
// because Chromium loads extensions only that way.
import { chromium } from "playwright-core";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const EXT = process.env.XTAG_EXT ?? path.resolve("extension");
// XTAG_CHROME, else the Chromium playwright-core expects, else the newest
// one in Playwright's cache (the installed playwright-core may be a
// different revision from the browsers on disk).
const chromeBinary = () => {
  if (process.env.XTAG_CHROME) return process.env.XTAG_CHROME;
  const expected = chromium.executablePath();
  if (existsSync(expected)) return expected;
  const cache = path.dirname(path.dirname(path.dirname(expected.split("/Contents/")[0])));
  const dirs = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
  for (const d of dirs) {
    for (const app of ["chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
      const bin = path.join(cache, d, app);
      if (existsSync(bin)) return bin;
    }
  }
  return expected;
};
const CHROME = chromeBinary();
// The unpacked extension's id, derived the way Chrome does it.
const extId = (p) => [...createHash("sha256").update(p).digest().subarray(0, 16)]
  .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");
const ID = extId(EXT);

const HISTORY = "responsive_web_history_screen_enabled";
const CAROUSEL = "rweb_media_carousel_enabled";
const FLAGS = [HISTORY, CAROUSEL];
const OWN = "morello"; // the fixture's logged-in reader

// X's router in miniature, where interceptor.ts looks for it.
const ROUTER = `
  var xpushes = []; out.xpushes = xpushes;
  var xh = {
    push: function(path, state){ history.pushState({key:'x'+(n++), state: Object.assign({fromApp:true}, state||{})}, '', path); routerLocation = path; xpushes.push([path, state||null]); reselect(); },
    replace: function(path, state){ history.replaceState({key:'x'+(n++), state: state}, '', path); routerLocation = path; reselect(); }
  };
  document.getElementById('react-root')['__reactContainer$fixture'] = { memoizedProps: null, child: { memoizedProps: {}, child: { memoizedProps: { history: xh }, child: null } } };
`;

// variant: "full" | "noflags" | "nohistory" | "nostate"; router: whether
// the fake fiber (and X's history on it) is there to be found
function fixture(variant, url, router) {
  const cfg = (keys) => Object.fromEntries(keys.map((k) => [k, { value: true }]));
  const keys = variant === "noflags" ? ["some_other_flag"]
    : variant === "nohistory" ? [CAROUSEL, "some_other_flag"]
    : [...FLAGS, "some_other_flag"];
  const state = JSON.stringify({ optimist: [], featureSwitch: {
    defaultConfig: cfg(keys), user: { config: cfg(keys) }, customOverrides: {},
    isLoaded: true, isLoading: false } });
  const assign = variant === "nostate" ? "" : `window.__INITIAL_STATE__=${state};window.__META_DATA__={};`;
  const handle = (new URL(url).pathname.match(/^\/([A-Za-z0-9_]{1,15})/) || [])[1] || "NASA";
  return `<!DOCTYPE html><html dir="ltr" lang="en"><head><meta charset="utf-8"><title>X</title>
<script type="text/javascript">${assign}</script></head>
<body>
<header><nav><a data-testid="AppTabBar_Profile_Link" href="/${OWN}">Profile</a><a data-testid="SideNav_NewTweet_Button" style="background-color: rgb(29, 155, 240)">Post</a></nav></header>
<main><h2 style="color: rgb(231, 233, 234)">${handle}</h2><div data-testid="UserDescription">bio <a href="/someone" style="color: rgb(255, 122, 0)">@someone</a></div>
<div role="tablist">
  <div><a role="tab" href="/${handle}" aria-selected="true"><div><span style="font-weight:700">Posts</span><svg class="chevron"></svg></div><div class="underline"></div></a></div>
  <div><a role="tab" href="/${handle}/with_replies" aria-selected="false"><div><span>Replies</span></div></a></div>
  <div><a role="tab" href="/${handle}/media" aria-selected="false"><div><span>Media</span></div></a></div>
</div>
<button id="videos-pick">Videos</button>
<button id="selected-media-click">selected media tab click</button>
<div id="timeline"></div>
</main>
<div id="react-root"></div>
<script>
(function(){
  var st = window.__INITIAL_STATE__;
  // Count loads in the page; Playwright's load event misses one now and then.
  try { sessionStorage.setItem('xtag:test-loads', String(parseInt(sessionStorage.getItem('xtag:test-loads') || '0', 10) + 1)); } catch (e) { /* none */ }
  var out = { hadState: !!st, bootSearch: location.search, bootPath: location.pathname, pushes: [], pops: [] };
  if (st) {
    var fs = st.featureSwitch;
    var read = function(k){ var o = fs.customOverrides && fs.customOverrides[k]; if (o != null) return o; var f = fs.user.config[k]; return f ? f.value : undefined; };
    out.history = read("${HISTORY}");
    out.carousel = read("${CAROUSEL}");
    out.other = read("some_other_flag");
    out.overrides = Object.assign({}, fs.customOverrides);
    delete window.__INITIAL_STATE__;
    out.deletedOk = !("__INITIAL_STATE__" in window);
  }
  window.__probe = out;
  // A tab click pushes the bare path and renders from the router's own
  // location; only a popstate makes it re-read window.location.
  var routerLocation = location.pathname + location.search;
  out.routerLocation = function(){ return routerLocation; };
  var n = 0;
  out.xpushes = [];
  ${router ? ROUTER : ""}
  document.querySelectorAll('a[role="tab"]').forEach(function(a){
    a.addEventListener('click', function(e){ e.preventDefault(); var href = a.getAttribute('href'); if (/\\/likes$/.test(href)) { location.href = href; return; } history.pushState({key:'k'+(n++)}, '', href); routerLocation = href; out.pushes.push(href); });
  });
  document.getElementById('videos-pick').addEventListener('click', function(){ history.pushState({key:'k'+(n++)}, '', '/${handle}/media'); routerLocation = '/${handle}/media'; out.pushes.push('/${handle}/media'); });
  document.getElementById('selected-media-click').addEventListener('click', function(){ var t = document.querySelector('a[href="/${handle}/media"]'); t.setAttribute('aria-selected','true'); t.click(); });
  // Re-render the strip per route, as X does, and swap the timeline so the
  // content script's observer fires.
  var reselect = function(){ document.querySelectorAll('a[role="tab"]:not([data-xtag-likes-tab])').forEach(function(a){ a.setAttribute('aria-selected', a.getAttribute('href') === location.pathname ? 'true' : 'false'); }); document.getElementById('timeline').replaceChildren(document.createTextNode(location.pathname)); };
  window.addEventListener('popstate', function(){ routerLocation = location.pathname + location.search; out.pops.push(routerLocation); reselect(); });
  // On the likes route X selects no tab.
  if (/\\/likes$/.test(location.pathname)) document.querySelectorAll('a[role="tab"]').forEach(function(a){ a.setAttribute('aria-selected','false'); a.querySelector('.underline') && a.querySelector('.underline').remove(); });
})();
</script></body></html>`;
}

async function launch() {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "xtag-e2e-"));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false, executablePath: CHROME,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run"],
  });
  let variant = "full";
  let router = true;
  await ctx.route("https://x.com/**", (route) => route.fulfill({
    status: 200, contentType: "text/html", body: fixture(variant, route.request().url(), router) }));
  return { ctx, setVariant: (v) => { variant = v; }, setRouter: (v) => { router = v; } };
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + JSON.stringify(detail)));
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const readPage = (page) => page.evaluate(() => ({
  probe: { ...window.__probe, routerLocation: window.__probe.routerLocation && window.__probe.routerLocation(), xpushes: window.__probe.xpushes ?? [] },
  attr: JSON.parse(document.documentElement.getAttribute("data-xtag-native") ?? "null"),
  mirror: localStorage.getItem("xtag:flags"),
  loads: parseInt(sessionStorage.getItem("xtag:test-loads") || "0", 10),
  url: location.pathname + location.search,
  likesTab: (() => { const t = document.querySelector("[data-xtag-likes-tab]"); return t ? { href: t.getAttribute("href"), text: t.textContent.trim(), selected: t.getAttribute("aria-selected"), inStrip: !!t.closest('[role="tablist"]'), last: t.closest('[role="tablist"]')?.querySelectorAll('a[role="tab"]').length } : null; })(),
}));
const waitMirror = (page, want) => page.waitForFunction(
  (w) => localStorage.getItem("xtag:flags") === w, want, { timeout: 3000 }).catch(() => {});
const settle = (page, ms = 700) => page.waitForTimeout(ms);
const zeroLoads = (page) => page.evaluate(() => sessionStorage.removeItem("xtag:test-loads"));

const { ctx, setVariant, setRouter } = await launch();
try {
  const page = await ctx.newPage();
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${ID}/popup.html`);
  const storage = (keys) => popup.evaluate((k) => chrome.storage.local.get(k), keys);
  const setStorage = (v) => popup.evaluate((v) => chrome.storage.local.set(v), v);
  const clearStorage = () => popup.evaluate(() => chrome.storage.local.clear());
  const resetMirror = () => page.evaluate(() => { localStorage.removeItem("xtag:flags"); sessionStorage.clear(); });

  // A: defaults, no mirror yet
  await page.goto("https://x.com/NASA");
  await settle(page);
  let r = await readPage(page);
  check("A defaults: likes flipped, postgrid not", r.attr && r.attr.likes === true && r.attr.postgrid === false, r.attr);
  check("A X reads history=false, carousel=true, other untouched", r.probe.history === false && r.probe.carousel === true && r.probe.other === true, r.probe);
  check("A overrides hold only history", eq(r.probe.overrides, { [HISTORY]: false }), r.probe.overrides);
  check("A page could delete the global", r.probe.deletedOk === true, r.probe);
  await waitMirror(page, JSON.stringify({ mediagrid: true, likestab: true, postgrid: false }));
  r = await readPage(page);
  check("A mirror written by content script", r.mirror === JSON.stringify({ mediagrid: true, likestab: true, postgrid: false }), r.mirror);
  let st = await storage(["mediagrid", "native"]);
  check("A mediagrid persisted once, report stored for the popup", st.mediagrid === true && st.native && st.native.likes === true && st.native.flags.carousel === true, st);
  check("A no Likes tab on someone else's profile", r.likesTab === null, r.likesTab);

  // B: the Media tab, direct arrival
  await page.goto("https://x.com/NASA/media"); await settle(page);
  r = await readPage(page);
  check("B direct /media boots on ?filter=photo", r.probe.bootSearch === "?filter=photo" && r.url === "/NASA/media?filter=photo", r.probe);
  await page.goto("https://x.com/NASA/media?filter=video"); await settle(page);
  r = await readPage(page);
  check("B an explicit filter is left alone", r.probe.bootSearch === "?filter=video", r.probe);

  // C: the Media tab, by click
  await page.goto("https://x.com/NASA"); await settle(page);
  let h0 = await page.evaluate(() => history.length);
  await page.click('a[role="tab"][href="/NASA/media"]');
  await settle(page, 400);
  r = await readPage(page);
  let h1 = await page.evaluate(() => history.length);
  check("C Media click: one entry, URL and router both on ?filter=photo, X's push with lockScroll, no popstate", h1 - h0 === 1 && r.url === "/NASA/media?filter=photo" && r.probe.routerLocation === "/NASA/media?filter=photo" && r.probe.pops.length === 0 && eq(r.probe.xpushes, [["/NASA/media?filter=photo", { lockScroll: true }]]), { h: h1 - h0, url: r.url, router: r.probe.routerLocation, pops: r.probe.pops, xpushes: r.probe.xpushes });
  await page.click("#videos-pick"); await settle(page, 400);
  r = await readPage(page);
  check("C an explicit Videos pick stays bare", r.url === "/NASA/media" && r.probe.routerLocation === "/NASA/media" && r.probe.pops.length === 0 && r.probe.xpushes.length === 1, { url: r.url, pops: r.probe.pops, xpushes: r.probe.xpushes });
  await page.click("#selected-media-click"); await settle(page, 400);
  r = await readPage(page);
  check("C a click on the SELECTED tab is X's own", r.url === "/NASA/media" && r.probe.pops.length === 0 && r.probe.xpushes.length === 1, { url: r.url, pops: r.probe.pops, xpushes: r.probe.xpushes });
  await setStorage({ mediagrid: false });
  await waitMirror(page, JSON.stringify({ mediagrid: false, likestab: true, postgrid: false }));
  await page.goto("https://x.com/NASA"); await settle(page);
  await page.click('a[role="tab"][href="/NASA/media"]'); await settle(page, 400);
  r = await readPage(page);
  check("C switch off: the click is left alone", r.url === "/NASA/media" && r.probe.pops.length === 0 && r.probe.xpushes.length === 0, { url: r.url, pops: r.probe.pops, xpushes: r.probe.xpushes });
  await page.goto("https://x.com/NASA/media"); await settle(page);
  r = await readPage(page);
  check("C switch off: the direct arrival is left alone", r.probe.bootSearch === "", r.probe);
  await setStorage({ mediagrid: true });
  await waitMirror(page, JSON.stringify({ mediagrid: true, likestab: true, postgrid: false }));

  // C, fallback: no router
  setRouter(false);
  await page.goto("https://x.com/NASA"); await settle(page);
  h0 = await page.evaluate(() => history.length);
  await page.click('a[role="tab"][href="/NASA/media"]'); await settle(page, 400);
  r = await readPage(page);
  h1 = await page.evaluate(() => history.length);
  check("C fallback Media click: one entry, URL and router both on ?filter=photo by popstate", h1 - h0 === 1 && r.url === "/NASA/media?filter=photo" && r.probe.routerLocation === "/NASA/media?filter=photo" && r.probe.pops.length === 1 && r.probe.xpushes.length === 0, { h: h1 - h0, url: r.url, router: r.probe.routerLocation, pops: r.probe.pops });
  await page.click("#videos-pick"); await settle(page, 400);
  r = await readPage(page);
  check("C fallback: an explicit Videos pick stays bare", r.url === "/NASA/media" && r.probe.routerLocation === "/NASA/media" && r.probe.pops.length === 1, { url: r.url, pops: r.probe.pops });
  await page.click("#selected-media-click"); await settle(page, 400);
  r = await readPage(page);
  check("C fallback: a click on the SELECTED tab arms nothing", r.url === "/NASA/media" && r.probe.pops.length === 1, { url: r.url, pops: r.probe.pops });
  setRouter(true);

  // D: the Likes tab on the reader's own profile
  await page.goto(`https://x.com/${OWN}`); await settle(page);
  r = await readPage(page);
  check("D own profile: Likes tab injected last, unselected, X's markup", r.likesTab && r.likesTab.href === `/${OWN}/likes` && r.likesTab.text === "Likes" && r.likesTab.selected === "false" && r.likesTab.inStrip && r.likesTab.last === 4, r.likesTab);
  const tmpl = await page.evaluate(() => sessionStorage.getItem("xtag:likes-tab-selected"));
  check("D selected template remembered from X's Posts tab", typeof tmpl === "string" && tmpl.includes("underline"), tmpl);
  const noChevron = await page.evaluate(() => !document.querySelector("[data-xtag-likes-tab] svg"));
  check("D the clone drops X's dropdown chevron", noChevron, noChevron);
  await zeroLoads(page);
  await page.click("[data-xtag-likes-tab]"); await settle(page);
  r = await readPage(page);
  let fullLoads = r.loads;
  const selectedLook = await page.evaluate(() => { const t = document.querySelector("[data-xtag-likes-tab]"); return { underline: !!t.querySelector(".underline"), svg: !!t.querySelector("svg"), others: [...document.querySelectorAll('a[role="tab"]:not([data-xtag-likes-tab])')].map((a) => a.getAttribute("aria-selected")) }; });
  check("D click: X's own push with lockScroll, no page load, no popstate", fullLoads === 0 && r.url === `/${OWN}/likes` && r.probe.routerLocation === `/${OWN}/likes` && r.probe.pops.length === 0 && eq(r.probe.xpushes, [[`/${OWN}/likes`, { lockScroll: true }]]), { fullLoads, url: r.url, router: r.probe.routerLocation, pops: r.probe.pops, xpushes: r.probe.xpushes });
  check("D likes route: our tab selected with the cloned look, no chevron, X's none", r.likesTab && r.likesTab.selected === "true" && selectedLook.underline && !selectedLook.svg && selectedLook.others.every((v) => v === "false"), { tab: r.likesTab, selectedLook });
  setRouter(false);
  await page.goto(`https://x.com/${OWN}`); await settle(page);
  await zeroLoads(page);
  await page.click("[data-xtag-likes-tab]"); await settle(page);
  r = await readPage(page);
  fullLoads = r.loads;
  check("D fallback click: SPA route (push + popstate), no page load, router re-read", fullLoads === 0 && r.url === `/${OWN}/likes` && r.probe.routerLocation === `/${OWN}/likes` && r.probe.pops.length === 1 && r.probe.xpushes.length === 0 && r.likesTab && r.likesTab.selected === "true", { fullLoads, url: r.url, router: r.probe.routerLocation, pops: r.probe.pops, tab: r.likesTab });
  setRouter(true);
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(`https://x.com/${OWN}/likes`); await settle(page);
  const fallback = await page.evaluate(() => { const t = document.querySelector("[data-xtag-likes-tab]"); const bar = [...t.querySelectorAll("div")].find((d) => d.style.height === "4px"); const label = [...t.querySelectorAll("span")].find((s) => s.textContent.trim() === "Likes"); return { selected: t.getAttribute("aria-selected"), bar: bar ? getComputedStyle(bar).backgroundColor : null, bold: label ? getComputedStyle(label).fontWeight : null }; });
  check("D direct likes load, nothing cached: fallback look, accent from the bio link", fallback.selected === "true" && fallback.bar === "rgb(255, 122, 0)" && fallback.bold === "700", fallback);
  // The strip must not grow: a leftover wrapper per switch squeezes the tabs.
  await page.goto(`https://x.com/${OWN}`); await settle(page);
  const strip0 = await page.evaluate(() => document.querySelector('main [role="tablist"]').children.length);
  for (let i = 0; i < 3; i++) {
    await page.click("[data-xtag-likes-tab]"); await settle(page, 300);
    await page.click(`a[role="tab"][href="/${OWN}/media"]`); await settle(page, 300);
  }
  const after = await page.evaluate(() => ({
    children: document.querySelector('main [role="tablist"]').children.length,
    tabs: document.querySelectorAll("[data-xtag-likes-tab]").length,
    empty: [...document.querySelector('main [role="tablist"]').children].filter((c) => !c.querySelector('a[role="tab"]')).length,
  }));
  check("D three Media/Likes round trips leave the strip the same width", after.children === strip0 && after.tabs === 1 && after.empty === 0, { strip0, after });

  await setStorage({ likestab: false }); await settle(page, 300);
  r = await readPage(page);
  check("D switch off: the tab leaves at once", r.likesTab === null, r.likesTab);
  await setStorage({ likestab: true });
  await waitMirror(page, JSON.stringify({ mediagrid: true, likestab: true, postgrid: false }));

  // E: popup switches -> mirror -> next boot
  await setStorage({ likestab: false, postgrid: true });
  await waitMirror(page, JSON.stringify({ mediagrid: true, likestab: false, postgrid: true }));
  await page.reload(); await settle(page);
  r = await readPage(page);
  check("E next boot: postgrid flipped, history not", r.attr && r.attr.likes === false && r.attr.postgrid === true && r.probe.carousel === false && r.probe.history === true && eq(r.probe.overrides, { [CAROUSEL]: false }), { attr: r.attr, probe: r.probe });

  // F: migration from 1.x media choices
  for (const [stored, want] of [[{ mediaview: "videos" }, false], [{ mediaphotos: false }, false], [{ mediaview: "grid" }, true], [{}, true]]) {
    await clearStorage(); await setStorage(stored); await resetMirror();
    await page.reload(); await settle(page);
    st = await storage(["mediagrid"]);
    check(`F migrate ${JSON.stringify(stored)} -> mediagrid=${want}`, st.mediagrid === want, st);
  }
  await clearStorage(); await resetMirror();

  // G: X removed a flag -> reported, not a reload loop
  setVariant("nohistory");
  await zeroLoads(page);
  await page.reload(); await settle(page, 2500);
  r = await readPage(page); st = await storage(["native"]);
  let loads = r.loads;
  check("G history flag gone: likes reported off, report says so, no reload", loads === 1 && r.attr && r.attr.likes === false && st.native.flags.history === false, { loads, attr: r.attr });
  setVariant("noflags");
  await page.reload(); await settle(page);
  r = await readPage(page);
  check("G all flags gone: nothing flipped, overrides untouched", r.attr && !r.attr.likes && !r.attr.postgrid && eq(r.probe.overrides, {}), r);
  setVariant("nostate");
  await page.reload(); await settle(page);
  r = await readPage(page); st = await storage(["native"]);
  check("G no boot state: no attribute, null report, page fine", r.attr === null && r.probe.hadState === false && st.native === null, { attr: r.attr, st });
  setVariant("full");

  // H: a stale mirror reloads once and lands right
  await clearStorage(); await setStorage({ likestab: false });
  await page.evaluate(() => { localStorage.setItem("xtag:flags", JSON.stringify({ mediagrid: true, likestab: true, postgrid: false })); sessionStorage.clear(); });
  await page.reload(); await settle(page, 2500);
  r = await readPage(page);
  loads = r.loads;
  check("H stale mirror: one extra reload, then the boot matches storage", loads === 2 && r.attr && r.attr.likes === false && r.probe.history === true, { loads, attr: r.attr });

  // I: a corrupt mirror falls back to defaults
  await clearStorage();
  await page.evaluate(() => { localStorage.setItem("xtag:flags", "{not json"); sessionStorage.clear(); });
  await page.reload(); await settle(page);
  r = await readPage(page);
  check("I corrupt mirror: defaults apply", r.attr && r.attr.likes === true && r.attr.postgrid === false, r.attr);

  // J: the popup reflects storage and the report
  await clearStorage();
  await setStorage({ mediagrid: false, likestab: true, postgrid: true, native: { likes: true, postgrid: false, flags: { history: true, carousel: false } } });
  await popup.reload(); await popup.waitForTimeout(300);
  const ui = await popup.evaluate(() => ({
    mediaview: document.getElementById("mediaview").value,
    mosaicNote: !document.getElementById("mosaic-note").hidden,
    likestab: document.getElementById("likestab").checked,
    postgrid: document.getElementById("postgrid").checked,
    sharecopy: document.getElementById("sharecopy").checked,
    likesWarn: !document.getElementById("likestab-warn").hidden,
    postgridWarn: !document.getElementById("postgrid-warn").hidden,
  }));
  check("J popup: controls from storage, warning only for the gone flag", ui.mediaview === "videos" && !ui.mosaicNote && ui.likestab && ui.postgrid && ui.sharecopy && !ui.likesWarn && ui.postgridWarn, ui);
  // The select writes the shared mediaview key, and the rate note rides the Mosaic pick only.
  await popup.evaluate(() => { const v = document.getElementById("mediaview"); v.value = "mosaic"; v.dispatchEvent(new Event("change")); });
  await popup.waitForTimeout(200);
  st = await storage(["mediaview"]);
  const noteAfter = await popup.evaluate(() => !document.getElementById("mosaic-note").hidden);
  check("J popup: picking Mosaic writes mediaview and shows the rate note", st.mediaview === "mosaic" && noteAfter, { st, noteAfter });
  await popup.evaluate(() => { const b = document.getElementById("postgrid"); b.checked = false; b.dispatchEvent(new Event("change")); });
  await popup.waitForTimeout(200);
  st = await storage(["postgrid"]);
  const warnAfter = await popup.evaluate(() => !document.getElementById("postgrid-warn").hidden);
  check("J popup: unticking writes storage and clears the warning", st.postgrid === false && !warnAfter, { st, warnAfter });

  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
} finally {
  await ctx.close();
}
