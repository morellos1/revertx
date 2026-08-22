# Chrome Web Store submission

The answers the dashboard asks for. Paste them as-is unless the
extension's behaviour changes.

Package the upload with `npm run zip`. `revertx.zip` carries
`manifest.json` at its root, plus `LICENSE` and `THIRD_PARTY_NOTICES.md`.

## Updating a published version

1. Raise `version` in `extension/manifest.json` and `package.json`.
2. `npm run zip`.
3. In the Developer Dashboard open the item, **Package > Upload new
   package**, choose `revertx.zip`. Always the same item.
4. Check the **Privacy** tab against the justifications below.
5. Update the listing text and screenshots, then **Submit for review**.

The `description` is capped at 132 characters, the same as the listing
summary. Keep the two the same text.

A submission cannot be pulled back. A defect found after submitting is
worth a next version, not a rescue.

## Version history

| Version | What happened |
| --- | --- |
| 1.x | A userland grid and a framed Likes pane, no longer shipped. |
| 2.0.0 | Submitted 2026-08-21, superseded before publication. |
| 2.0.1 | X's own layouts. The first 2.x the store publishes. |

## Listing

**Name:** revertX

**Summary** (also the manifest's `description`):

> Restores what X removed: the Media tab's photo grid, the Likes tab on your
> profile, the photo grid in posts, and Copy link first.

**Category:** Functionality & UI

**Description:**

> revertX gives X back four things it took away.
>
> The Media tab opens the photo grid. X's Media tab opens on Videos; its
> Photos mode is a three-column grid of X's own. revertX opens the tab there:
> X's grid, X's viewer, Back landing on the grid. Videos stay one pick
> away in the tab's own dropdown.
>
> The Likes tab on your profile. X moved your likes to a separate History
> page but never deleted the profile route. revertX switches it back on
> before the page loads and puts the tab back in the strip, so your likes
> show under your own header, X's own timeline. Your own profile only.
> While this is on, X's History page is unavailable; Bookmarks stay.
>
> The photo grid inside posts (off by default). X turned the 2-4 image layout
> in posts into a horizontal slider. This switches the old 2x2 grid back on.
>
> Copy link first in the share menu. X put "Send via Chat" on top. This puts
> "Copy link" back where it was.
>
> revertX collects nothing, sends nothing, and has no analytics. It runs no
> background process, asks for one permission (storage, for your switches),
> and runs on x.com only. It is open source under the MIT licence.
>
> An independent project. Not affiliated with, endorsed by, or sponsored by
> X Corp.

Keep that last paragraph.

## Single purpose

> revertX modifies the interface of x.com to restore layouts and tabs the
> site removed (the Media tab's photo grid, the profile Likes tab, the
> photo grid inside posts) and one navigation convenience in the share
> menu.

## Permission justifications

| Field | Justification |
| --- | --- |
| `storage` | Two things, both local: the user's on/off preference for each of the four features, and a note of which of X's own feature flags the last page load found, so the popup can tell the user when X has removed a layout. No browsing history, no account data. |
| Host access | None requested. The content scripts are declared for `https://x.com/*` only. |
| Remote code | None. No script is fetched or evaluated at runtime. |

If asked how the layouts come back: X's pages boot from an inline
`window.__INITIAL_STATE__` that carries every feature flag. Two of those
flags switch off code X still ships. A content script in the page's world
at `document_start` sets those two to `false` before X reads them
(`src/content/interceptor.ts`, unminified in the package). The same script
steers the Media tab to X's own Photos mode by its URL. The user's switches
are mirrored into x.com's `localStorage` under one key so that script can
read them synchronously.

`twitter.com` is not declared: X answers it with a server-side 301 to
`x.com` on every path.

## Data use disclosure

Tick nothing in the data collection list, then certify all three
statements. A privacy policy URL is not required when nothing is
collected; if asked, point at the Privacy section of the README.

## Assets

| Asset | Size | File |
| --- | --- | --- |
| Store icon | 128x128 | `extension/icons/icon128.png` |
| Screenshots | 1280x800 | `assets/store/01` to `04` |
| Small promo tile | 440x280 | `assets/store/promo-tile-440x280.png` |
| Marquee promo tile | 1400x560 | `assets/store/promo-marquee-1400x560.png`, source in `assets/promo-marquee.svg` |

| Screenshot | Caption |
| --- | --- |
| `01-media-grid.png` | Media tab opens the photo grid |
| `02-likes-tab.png` | Likes tab back on your own profile |
| `03-post-grid.png` | Posts with 2, 3 or 4 images back in the old grid |
| `04-share-menu.png` | Copy link back on top |

Captions are rendered into the image; the store has no caption field.
Each one is a caption column beside a page-only capture of live x.com
(no browser chrome). The palette is the popup's own dark tokens. Re-shoot
a screenshot when the layout it shows moves, and check every image in
frame suits a general audience.
