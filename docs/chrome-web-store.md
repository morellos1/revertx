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
| 2.1.0 | Adds the Mosaic view. Everything under "The Mosaic view" below applies from this version. |

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
> Mosaic, an extra Media tab view. Off unless you pick it from the
> tab's own dropdown. It shows the same photos at their real shapes
> instead of square crops, in rows that fill the width. It loads more
> photos as you scroll, the way the page itself does. X limits how much
> an account can load at once, so it stops loading early and says when
> loading continues; the popup notes this where you pick it.
>
> revertX collects nothing, sends nothing, and has no analytics. It runs no
> background process, asks for one permission (storage, for your switches),
> and runs on x.com only. It is open source under the MIT licence.
>
> An independent project. Not affiliated with, endorsed by, or sponsored by
> X Corp.

Keep that last paragraph. The summary and the first line stay as they
are: the four restores are still the point.

## Single purpose

> revertX modifies the interface of x.com to restore layouts and tabs the
> site removed (the Media tab's photo grid, the profile Likes tab, the
> photo grid inside posts) and one navigation convenience in the share
> menu. It also offers one alternative layout for the same media the tab
> already shows, a variable-height view in place of the square grid.

Both halves are the same purpose: how one site's own content is laid out.
The view adds no new surface, no new site and no new data.

## The Mosaic view (from 2.1.0)

The view is the first feature that makes a request, so it is the first
thing a reviewer will stop on. Answer plainly.

**What it is.** One optional choice in the Media tab's dropdown, beside
Videos and Photos, off unless the user picks it. It draws the same
photos the tab already shows, at their own aspect ratios instead of a
square crop, fitted into rows that fill the width.

**Where the photos come from.** Two sources, in this order:

1. The responses x.com's own page already fetched. A content script in the
   page's world wraps `fetch`/`XMLHttpRequest`, and hands the body of any
   photo-timeline response to the extension. This costs no request; it
   reads what the page asked for anyway.
2. When the reader scrolls past what those responses carried, one request
   for the next page, to the same x.com GraphQL endpoint the page itself
   calls, with the same session cookie, from x.com. Nothing is sent
   anywhere else, and nothing is stored beyond the tab's own memory.

**Why the request is safe to allow.** The template for it is a request the
page itself made, and it is refused unless its origin is x.com's own
`/i/api/graphql/` (`assertOwnApi`, `src/content/mosaic.ts`). Thumbnails
named by a response are refused unless they come from `twimg.com`
(`isMediaHost`). Both checks exist for the same reason: the response
reaches the extension over a DOM event that page script could also fire,
and the request carries the reader's session, so neither the address nor
the image host may be taken on trust.

**Rate limiting.** X's photo-timeline budget is 50 requests per 15 minutes
per account, shared with x.com's own timelines. While x.com's own page
is fetching the same timeline, the extension does not ask at all; it
reads those responses passively, so a scroll costs the same as on X's
own grid. When it does ask, it reads the rate headers on every
response, slows its own pages down once the budget runs low, and stops
requesting while 12 remain, telling the user when loading resumes, so
the site's own feeds keep the rest. If x.com answers 429 anyway, it
stops requesting until the window resets and holds off replaying for
10 minutes beyond that. Closing the view logs a receipt to the
console: requests spent, budget left, and why loading stopped.

Once the budget runs low, an "Image quota" pill (the count, a small
fill bar, the reset time) sits at the bottom of the photos view and
leaves with the window. If the budget is spent anyway, x.com's own
photos view fails for the rest of the window ("Something went wrong");
a one-line note under the profile's tab strip then names the time the
window resets, and is removed when it does. x.com can also withhold
photos without a 429 (empty pages while the budget headers stay
healthy); when that empties the view, the same note says "X sent no
photos · try again later". The pill and the note are the only DOM the
extension adds to the native photos view, and only in those states.
The extension's picture of the window (remaining, limit, reset time,
last 429) is mirrored into the tab's sessionStorage under one key, so
a reload while limited does not forget it; the entry expires with the
window and nothing leaves the page.

**Remote code.** Still none. Timeline responses are data: they are parsed
with `JSON.parse` and read for image URLs, dimensions and a paging cursor.
No response is evaluated, and no script is fetched.

**Data.** Still none collected. The requests go to x.com, in a page on
x.com, with the user's own session. Nothing reaches the developer or any
third party; there is no server to reach.

## Permission justifications

| Field | Justification |
| --- | --- |
| `storage` | Two things, both local: the user's preference for each feature (the Media tab's is a choice of three views), and a note of which of X's own feature flags the last page load found, so the popup can tell the user when X has removed a layout. No browsing history, no account data. |
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
| Screenshots | 1280x800 | `assets/store/01` to `05` |
| Small promo tile | 440x280 | `assets/store/promo-tile-440x280.png` |
| Marquee promo tile | 1400x560 | `assets/store/promo-marquee-1400x560.png`, source in `assets/promo-marquee.svg` |

| Screenshot | Caption |
| --- | --- |
| `01-media-grid.png` | Media tab opens the photo grid |
| `02-likes-tab.png` | Likes tab back on your own profile |
| `03-post-grid.png` | Posts with 2, 3 or 4 images back in the old grid |
| `04-share-menu.png` | Copy link back on top |
| `05-mosaic.png` | Mosaic shows every photo at its own shape |

Captions are rendered into the image; the store has no caption field.
Each one is a caption column beside a page-only capture of live x.com
(no browser chrome). The palette is the popup's own dark tokens. Re-shoot
a screenshot when the layout it shows moves, and check every image in
frame suits a general audience.
