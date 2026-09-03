# revertX

A Chrome and Firefox extension that gives X back four things it removed,
and adds one it never had:

- **Media tab opens the photo grid** instead of Videos.
- **Likes tab on your own profile**, instead of the History page.
- **Photo grid in posts** (2x2) instead of the slider. Off by default.
- **Copy link first** in the share menu.
- **Mosaic**, an optional Media tab view that shows every photo at its
  own shape instead of a square crop. Off by default; it is the one
  feature that loads pages itself (see below).

No servers, no analytics, no tracking. One permission (`storage`), x.com only.

> Not affiliated with X Corp.

## Install

**Easiest:** install from the
[Chrome Web Store](https://chromewebstore.google.com/detail/revertx/emnkkmbblhgoapdkbnhejimjpklajlng)
or [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/revertx/)
(Firefox 142 or later).

**From source:**

1. Install [Node.js](https://nodejs.org).
2. Download this repo (green **Code** button, **Download ZIP**) and unzip it.
3. Open a terminal in that folder and run:

   ```
   npm install
   npm run build
   ```

4. Load it in your browser:
   - **Chrome:** go to `chrome://extensions`, turn on **Developer mode**,
     click **Load unpacked**, pick the `extension` folder.
   - **Firefox:** go to `about:debugging#/runtime/this-firefox`, click
     **Load Temporary Add-on**, pick `extension-firefox/manifest.json`.
     This is removed when Firefox quits.

## Use

Click the revertX icon in your toolbar to turn each feature on or off.
Reload x.com after a change.

**Media tab opens** is a choice of three: the **photo grid** (X's own),
**Mosaic**, or **Videos** (X's default). Mosaic lays photos into
justified rows with no gaps, and a landscape photo usually gets a full
row of its own. Profiles that only post GIFs, which X's own Media tab
shows as empty, get a grid too. The Media tab's own dropdown carries
the same three, and picking one there sets it for next time too. Press
Escape in the Mosaic view to drop back to X's grid for that visit only.

While the Likes tab is on, X's History page (`/i/history`) does not work.
Both share one X feature flag.

### What Mosaic costs

Every other feature is a flag, a URL or a DOM change, and costs nothing.
Mosaic sometimes asks X for the next page of photos, the same request
X's own page makes when you scroll. X allows each account about 50 such
requests per 15 minutes, shared with your normal browsing. Reading one
profile of about 200 photos to the end takes 10 to 20 of them, so a few
long profiles in a row can use most of the allowance.

Three things keep that small. Most pages are free: the view reuses the
responses X's own page already fetched, and only asks when those run
out. It stops asking well before the allowance is used up, and the view
says when loading continues. Going back to a profile you already read
shows the saved grid instead of loading it again.

When the allowance runs low, an "image quota" pill at the bottom of
the view shows what is left on a small bar and when it resets.

If the allowance still runs out (normal browsing spends it too), X's
own photo pages fail with "Something went wrong" for the rest of the
window. revertX then puts one line under the tab bar that says when
photos return.

GIF posts are a special case: X serves them on neither of the Media
tab's feeds, so a profile that only posts GIFs looks empty even on X's
own views. When that happens, Mosaic asks X's combined media timeline
instead. Same kind of request, same safeguards, and a separate
allowance of about 500.

If you never pick Mosaic, revertX makes no requests at all.

## How it works

Each feature uses a different trick. None of them rewrites X's code.

- **Media tab:** a URL. X's Photos grid still exists at
  `/<handle>/media?filter=photo`. revertX sends the tab's click to that
  URL through X's own router, so the page does not reload or jump. No flag
  is touched, which is why the Reposts tab and the Posts dropdown survive.
- **Likes tab:** a feature flag plus a tab. Setting
  `responsive_web_history_screen_enabled` to `false` before X boots makes
  `/<handle>/likes` render again. X draws no tab for it, so revertX clones
  one from X's own tab strip and routes its click the same way.
- **Photo grid in posts:** a feature flag. `rweb_media_carousel_enabled`
  set to `false` brings back the 2x2 layout.
- **Copy link:** a DOM reorder of the share menu.
- **Mosaic:** an overlay of X's own photos, laid out by revertX. Each
  photo's real dimensions ride along in X's timeline responses, so
  tiles are placed at the right shape before any image loads and
  nothing on screen shifts as the page fills. Photos flow into
  justified rows with no gaps, and a photo wider than 4:3 usually takes
  the full row. The images are X's thumbnails and every tile opens X's
  own viewer. A GIF-only profile is served from X's combined media
  timeline, the one place X still lists GIFs; that request's query id
  is read from X's own script bundle, which the browser already holds.

The flags are patched through an accessor on `window.__INITIAL_STATE__`.
The popup warns when X no longer ships a flag, and the switch does nothing.

## Develop

| Command | What it does |
| --- | --- |
| `npm run watch` | Rebuild on save |
| `npm run typecheck` | Type check |
| `npm run zip` | Build the store packages |
| `node test/native-boot.mjs` | Boot test in Chromium (needs `npm i --no-save playwright-core` once) |

Source is TypeScript in `src/`, bundled by esbuild into `extension/dist/`.

## Licence

MIT. See [LICENSE](LICENSE).
