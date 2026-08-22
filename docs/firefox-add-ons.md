# Firefox Add-ons (AMO) submission

The listing text, category and privacy answers are the same as in
`chrome-web-store.md`. This file holds what differs.

Package the upload with `npm run zip`; `revertx-firefox.zip` carries
`manifest.json` at its root, plus `LICENSE` and `THIRD_PARTY_NOTICES.md`.
Run `npm run lint:firefox` first. AMO runs the same linter on upload.

## What differs from the Chrome package

Same bundles, popup and icons. The manifest adds one block, written by
`esbuild.mjs`:

| Key | Value | Why |
| --- | --- | --- |
| `gecko.id` | `{21f2b618-63c1-4d5f-a269-a3c07b6f120b}` | Signing and updates key on it. Never change it. |
| `gecko.strict_min_version` | `142.0` | MAIN-world content scripts need 128; `data_collection_permissions` is read from 140 (142 on Android). |
| `gecko.data_collection_permissions` | `{ required: ["none"] }` | Required for every new add-on. |

## Source upload

AMO asks for source when the upload is bundled. Upload the repository at
the tagged commit as a zip (`git archive`) and give the build steps:
`npm install`, `npm run build`; the upload is `extension-firefox/`.

## Signing for use outside AMO

An unsigned add-on loads only as a temporary add-on. For a signed build
that is not listed, choose **On your own** as the distribution; AMO signs
and returns the `.xpi`.

## Updating a published version

1. Raise `version` in `extension/manifest.json` and `package.json`. The
   Firefox manifest inherits it.
2. `npm run zip`, then `npm run lint:firefox`.
3. In the Developer Hub open the add-on, **Upload New Version**, choose
   `revertx-firefox.zip`, then the source zip when asked.
4. Update the listing if it changed, then submit.

## Version history

| Version | What happened |
| --- | --- |
| 2.0.1 | The first Firefox build. Same code as Chrome's 2.0.1. |
