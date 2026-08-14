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
- Menu-bar icon → **Assess Contract with Claude**, **Check for Updates…**,
  **Edit Config…**, **Quit**

Clicking the chip for the search that's already on screen just brings the window
forward instead of reloading it. If you'd clicked through into a document, the window
is no longer on that search, so it does re-run it.

### Once a results window is open

Four buttons float over its bottom-right corner:

- **Moon / sun** — toggle dark mode on the page you're looking at, no reload. The icon
  shows which mode is on. The choice is saved to `config.json`, so it sticks.
- **Violet sparkle** — assess the contract on screen with Claude. See below.
- **Sky list** — jump to a section of the document. See below.
- **Green magnifier** — open the search bar over the window.

Pressing **S** on the page does the same as the green magnifier, and **A** does the same
as the sparkle — unless a text field has the caret, in which case they just type the
letter.

The hotkey gets a first step while that window exists: one press brings the PandaDoc
window forward (it's usually the results you already wanted, just buried), and a second
press — now that it has focus — puts the search bar on top of it for a new search. The
green magnifier is the same thing without the first press.

### Jumping to a section

The sky list button appears on the same terms as the sparkle: only once a document has
finished rendering. Clicking it opens the document's outline above the buttons, and
clicking a heading scrolls there and flashes it for a moment so you can see where you
landed. Escape, a click on the document, or the button again closes it.

The headings are the document's own H1s. A document built in PandaDoc's editor often
doesn't declare heading levels at all, so if none are found the outline falls back to
the largest tier of type on the page — the same headings by eye, just not by tag.

Two shortcuts sit above a hairline at the top, when the document has them:

- **Scope** — matches "Scope of Work", "Scope of Services", or a bare "Scope", and
  deliberately doesn't match "Out of Scope".
- **Payment Schedule** — matches "Payment Schedule" or "Payment Terms" first, then
  falls back through "Payments", "Pricing", "Fees", "Investment", and "Costs".

Each shows the document's own wording rather than the generic name, with a small tag
saying which shortcut it is, so you jump to text you can actually see on the page. They
also stay in the list below in their real document position — the pair at the top is a
shortcut, not a substitute, so the outline underneath is still a faithful one.

### Assessing a contract with Claude

**A** over the document, the violet sparkle, or the menu-bar item opens a second pill
over the window. It reads whatever document is on screen and runs an assessment against
it.

The chips under the pill are the assessments — named instructions that ship with the
app: **Risk scan**, **Key terms**, **Renewal & exit**, **Payment terms**, **Obligations**.
Click one and the answer streams in below. Or type a question and press Enter; follow-up
questions keep the same document and the previous answers in context, so you can drill in
without re-explaining. **New** starts a fresh thread, **Copy** takes the answer as
markdown.

**Edit…** opens the assessment editor. Add, reword, or remove them — they're saved to
`assessments.json` in the app's data folder, so they survive updates. Saving an empty
list restores the shipped set. This is where to put the checks your own contracts need
rather than adapting to the defaults.

The thread resets when you navigate to a different document, and after ten minutes idle.

#### Signing in

Everyone who uses the app signs in with their own Claude account, and assessments come
out of **that account's subscription** rather than metered API credits. There's no shared
key, and the app never holds a credential of its own. The first time you open the panel
it walks you through two steps:

```sh
npm install -g @anthropic-ai/claude-code   # handles the login
claude auth login                          # opens a browser
```

Once Claude Code is installed, the panel's **Sign in…** button runs `claude auth login`
for you and waits for the browser round trip to finish. The credential lands in your
login keychain, where the Claude Agent SDK reads it — so nothing is stored by this app.
**Account** in the panel shows who's signed in, which plan, and can sign them out again.

Assessments run through the Agent SDK with **no tools enabled at all** — no shell, no
file access — because the document arrives in the prompt and attachments arrive as
content blocks. It reads contracts and nothing else. Any `ANTHROPIC_API_KEY` in the
environment is deliberately withheld from the subprocess, so a stray key can't silently
divert usage to metered API billing. If you sign in with `--console` instead, the panel
says so and warns that assessments will draw API credits rather than your plan.

Usage counts against your Claude plan's limits. If you hit one, the panel names which
limit and when it resets. The document text is sent to Anthropic to produce assessments.

#### How the document is read

Text is pulled straight from the page — PandaDoc renders an opened document in an
iframe, so every frame is asked and the longest answer wins. If there isn't enough
selectable text to assess (an unopened results list, or a viewer that draws to canvas),
it falls back to a screenshot of the visible area and says so in the answer's header, so
you know it only saw one page. Very long documents are cut off with a note rather than
silently truncated.

It's a contract reader, not a lawyer — it's told to quote the clause it's relying on and
to say when a term is absent rather than inferring one.

### Navigating

- **Cmd + [** / **Cmd + ]** — back / forward
- **Cmd + ←** / **Cmd + →** — the same, unless a text field has the caret, in which
  case they move to the start/end of the line as usual
- **Two-finger swipe** — back / forward, if your trackpad is set to it

These are handled by the app, not the page, so they work from inside an opened
document as well as the results list.

### Why that window's buttons are ours

macOS rounds its own windows to about 26pt; Chromium rounds its to 9pt (14pt from
Electron 41), so a native-framed window sits visibly squarer than Safari next to it.
Matching means drawing the shape ourselves — a transparent window with
`roundedCorners` off and the radius set on the views inside it — and macOS will not
render the real traffic lights on a transparent window, in any combination of
`titleBarStyle` / `transparent` / `setWindowButtonVisibility`.

So [shell.html](shell.html) draws its own close/minimise/zoom in the same geometry
and colours as the system's, greyed out when the window isn't in front, and drags
the window by hand rather than with `-webkit-app-region: drag`. What you lose is the
odd system extra: option-click behaviours and the green button's full-screen menu.

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
| `darkMode` | `true` | `in-app` only. Forces a dark PandaDoc via the [Dark Reader](https://darkreader.org/) engine. `false` = stock light UI. The moon/sun button in the results window flips this and writes it back here. |
| `darkModeOptions` | `{brightness:100, contrast:90, sepia:0}` | Dark Reader knobs. `brightness`/`contrast` are percentages (100 = unchanged); `sepia` and `grayscale` are 0–100. |
| `darkModeFrames` | `all` | `all` also darkens PandaDoc's own iframes (an opened document); `top` leaves them as they came. |
| `darkModeDebug` | `false` | Logs every frame dark mode touches to `dark-mode.log` beside `config.json`. |
| `closePreviousWindow` | `true` | `chrome-app` only. Closes the prior search window via AppleScript. |

The Dark Reader engine only runs in the top-level page. An opened document lives in
an `app.pandadoc.com/e/` iframe that never finishes loading with the engine inside
it, so that frame gets a plain inverting stylesheet instead — cruder colours, but
it touches none of the editor's own JavaScript. Third-party frames (PandaDoc embeds
ad trackers) are left alone entirely.

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
