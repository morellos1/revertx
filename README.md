# revertX

A Chrome and Firefox extension that gives X back four things it removed:

- **Media tab opens the photo grid** instead of Videos.
- **Likes tab on your own profile**, instead of the History page.
- **Photo grid in posts** (2x2) instead of the slider. Off by default.
- **Copy link first** in the share menu.

No servers, no analytics, no tracking. One permission (`storage`), x.com only.

> Not affiliated with X Corp.

## Install

**Easiest:** search for "revertX" on the Chrome Web Store or Firefox Add-ons
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

While the Likes tab is on, X's History page (`/i/history`) does not work.
Both share one X feature flag.

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

The flags are patched through an accessor on `window.__INITIAL_STATE__`.
The popup warns when X no longer ships a flag, and the switch does nothing.

## Develop

| Command | What it does |
| --- | --- |
| `npm run watch` | Rebuild on save |
| `npm run typecheck` | Type check |
| `npm run zip` | Build the store packages |
| `node test/native-boot.mjs` | Boot test in Chromium |

Source is TypeScript in `src/`, bundled by esbuild into `extension/dist/`.

## Licence

MIT. See [LICENSE](LICENSE).
