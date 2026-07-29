# PandaDoc Search

A menu-bar app for macOS. Hit a hotkey, type a customer or project name, press Enter —
PandaDoc document search opens in a single reusable window.

No Dock icon, no window to manage. Replaces a Shortcut that kept failing.

## Install

Download the latest `PandaDoc Search-<version>-universal.dmg` from
[Releases](https://github.com/dwitmer06-28-89/pandadoc-search/releases), open it, and
drag the app to Applications.

The app is signed and notarized by Apple, so it opens without any Gatekeeper warning.
It checks for updates on launch and every six hours, and offers to restart when one is
ready — so this is the only manual download you should ever need.

To have it always running, add it to **System Settings → General → Login Items**.

## Use

- **Control + Shift + P** — open the search bar
- **Enter** (or the ↑ button) — search
- **Escape**, or click outside the bar — dismiss
- Your last three searches appear as chips; click one to re-run it
- Menu-bar icon → **Check for Updates…**, **Edit Config…**, **Quit**

Clicking the chip for the search that's already on screen just brings the window
forward instead of reloading it. If you'd clicked through into a document, the window
is no longer on that search, so it does re-run it.

### First run

Results open in a window built into the app with its own browser session, separate
from Chrome, so **you sign in to PandaDoc once inside that window**. It stays signed
in from then on.

Email/password works. If your org uses Google SSO, Google sometimes refuses to sign in
from an embedded browser — either use email/password, or set `openMode` to
`"chrome-app"` (below) to open results in real Chrome instead.

## Configure

Menu-bar icon → **Edit Config…** opens your `config.json`, at
`~/Library/Application Support/pandadoc-search/config.json`. It's created on first
launch from the defaults in [config.js](config.js). Restart the app after editing.

| Key | Default | Meaning |
| --- | --- | --- |
| `hotkey` | `Control+Shift+P` | Global hotkey. [Electron accelerator syntax](https://www.electronjs.org/docs/latest/api/accelerator). |
| `baseUrl` | PandaDoc documents-next | Search page the term is appended to. |
| `extraParams` | `&filters=…` | Appended verbatim. Default decodes to `{"status":"2"}`. Empty string = no status filter. |
| `openMode` | `in-app` | `in-app`, `chrome-app` (chrome-less Chrome window), or `browser` (default browser). |
| `reloadOnSearch` | `false` | `in-app` only. Force a full page reload per search if results ever fail to refresh. |
| `closePreviousWindow` | `true` | `chrome-app` only. Closes the prior search window via AppleScript. |

To change the status filter: set the filter you want in PandaDoc, copy the encoded
`&filters=…` string out of the address bar, and paste it into `extraParams`.

## Why the original Shortcut broke

```
open -na "Google Chrome" --args --app="$1"
```

`open -na` only passes `--args` to a **new** Chrome process. Chrome is almost always
already running, so macOS handed the URL to the existing instance and dropped `--app`.
Calling the binary directly works while Chrome is running:

```
/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --app=<url>
```

That's what `openMode: "chrome-app"` does. The Shortcut also didn't URL-encode the
input, so any multi-word search built a malformed URL.

## Development

```bash
npm install
npm start
```

Auto-update is inert in development — `Check for Updates…` says so rather than failing.

## Releasing

Requires the `Developer ID Application` cert in your login keychain, plus Apple
credentials in your environment for notarization:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # appleid.apple.com
export APPLE_TEAM_ID="N7C6V6L995"
export GH_TOKEN="$(gh auth token)"
```

Then bump the version and publish:

```bash
npm version patch && npm run release && git push --follow-tags
```

`npm run release` builds a universal dmg + zip, signs, notarizes, and uploads them to
a GitHub Release along with `latest-mac.yml`. Installed copies find the update from
that file.

Both artifacts matter: the **dmg** is what people download by hand, the **zip** is what
electron-updater installs from. A release with only a dmg will not auto-update.

Build locally without publishing:

```bash
npm run build
```

## License

MIT
