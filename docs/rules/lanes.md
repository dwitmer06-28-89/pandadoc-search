<!-- Full text for the "Desktop lanes" section of PandaDoc Search's rules.
     .claude/RULES-INDEX.md carries the one-line index and points here.
     Rule numbers are stable — cite them by number. -->

# PandaDoc Search — Desktop lanes

3. **A bundled test lane (prod, release) gets its own `userData` directory — a different
   `appId` is not enough — and only the `shipped` lane auto-updates.**
   Electron derives `userData` from the app NAME, not the bundle identifier: a lane built with
   `appId=…prod` still resolved to `~/Library/Application Support/pandadoc-search` and read and
   wrote the shipped app's `config.json` and `recents.json`. `lane.js` (`isolateLaneData`, added
   with the lanes in `bdd70f5`, 17 Aug 2026) moves it before the app is ready and before
   `requestSingleInstanceLock()`, which is keyed on it. Auto-update is gated on `LANE ===
   'shipped'`, never on `app.isPackaged`, which is true for every bundled lane — a test lane
   that updated itself would replace the build under test with the published release.
   Known, deliberate: the DEV lane (`npm run dev`) shares the shipped app's data and lock, so
   the installed app must be quit first (`test-dev` step 1).
   Reviewer grep: `grep -n "isPackaged\|getPath('userData')\|AUTO_UPDATE" main.js lane.js assess.js claude-config.js`
