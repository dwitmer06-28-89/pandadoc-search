---
name: deploy-desktop
description: Publish a new PandaDoc Search desktop (Electron) release — bump the version, build the SHIPPED lane, sign, notarize and publish to this repo's GitHub Releases so installed copies auto-update, then tag and push. Use when asked to ship, release, deploy or publish the Mac app, or to cut a new version. For a local test build use test-release desktop (bundled, debug off) or test-prod desktop (bundled, debug on); for an instant look use test-dev desktop.
---

# Deploy the desktop app

Ships a signed, notarized, universal macOS build (dmg + zip + `latest-mac.yml`) to a
GitHub Release on **`dwitmer06-28-89/pandadoc-search`** — this repo; there is no
separate feed repo. Installed copies find it through electron-updater.

This is the README's "Releasing" sequence (`npm version patch && npm run release &&
git push --follow-tags`), split so a failed build never leaves a version bump or a
tag behind, and so it keeps Develop's deploy contract (release branch, allow-dirty,
a `v<version>` tag). There is no `scripts/deploy*.sh`; these steps ARE the deploy.

**Pushing the `v*` tag is itself a deploy step**: `.github/workflows/` builds the
Windows installer on that tag and uploads it to the same release. A branch push
builds nothing.

## Release-branch mode

When the prompt names a release branch (`release/<name>`, cut by Develop's scheduled
deploy), that branch stands in for `main` throughout:

- **Stay on it.** It is already checked out in Develop's worktree — never switch to
  `main` and never merge into it; Develop merges the branch back after the deploy.
- **Read the version from that branch's `package.json`.**
- **Push `HEAD:refs/heads/<branch>`** plus the tag in step 6 — never `main`.
- Release notes come from `git log <last v* tag reachable from HEAD>..HEAD`.

Otherwise the branch must be `main`; refuse anything else.

## 1. Confirm the tree is shippable

```bash
git branch --show-current && git status --porcelain && git log --oneline -8
git describe --tags --abbrev=0 --match 'v*'
```

- **This ships what is committed.** A dirty tree is refused — say in one line what is
  uncommitted — **unless the command carries `--allow-dirty`** (Develop adds it when
  "Allow deploying uncommitted work" is on). Then build the tree as it is, and name the
  uncommitted files that shipped in the tag message in step 6. Never commit them on
  Deron's behalf.
- If nothing has changed since the last `v*` tag, say so and stop.
- Note: `package.json` was bumped to 1.0.4 and 1.0.5 without tags, so the last tag can
  trail the version. Check what is actually published before picking a number:
  `gh release list --repo dwitmer06-28-89/pandadoc-search --limit 5`.

## 2. Pick the version

```bash
node -p "require('./package.json').version"
```

**Default to a patch bump** above the higher of `package.json` and the newest published
release. State it in one line; Deron can override with minor, major or an exact version.
Refuse a version that already has a release or a tag.

## 3. Preflight — before any build

Check presence only; never print a value.

```bash
for v in APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do [ -n "${!v:-}" ] || echo "missing $v"; done
gh auth status >/dev/null 2>&1 || echo "gh not signed in"
security find-identity -v -p codesigning | grep -c "Developer ID Application"
```

- Missing Apple variables or no Developer ID certificate: **stop and ask Deron**. Every
  one of these otherwise fails ten minutes into the build. Do not go looking for the
  values elsewhere.
- `GH_TOKEN` is set for the publish as `GH_TOKEN="$(gh auth token)"` on the command line.

## 4. Gate — there is no test suite, and that is the report

PandaDoc Search has no automated tests and no typecheck. Run
`bash /Users/deronwitmer/Documents/Code/ProjectGlobals/scripts/gate.sh --quick .` and
report what it says; never report "tests passed" when nothing ran.

## 5. Bump, build and publish

```bash
npm version X.Y.Z --no-git-tag-version
GH_TOKEN="$(gh auth token)" npm run release
```

`npm run release` is `electron-builder --mac --publish always` with **no lane stamped**,
which is the shipped lane — the only one that auto-updates. Never publish a build made
by `scripts/install-lane.sh` (prod/release): those are test lanes with their own appId.

Takes roughly 5–15 minutes, mostly Apple's notarization round trip with no progress
shown. Don't interrupt it.

**On failure**, roll the bump back (`git checkout -- package.json package-lock.json`),
report the error verbatim and stop. No commit, no tag.

Then verify the release:

```bash
gh release view vX.Y.Z --repo dwitmer06-28-89/pandadoc-search --json assets -q '.assets[].name'
```

It must list a `.dmg`, a `.zip` and `latest-mac.yml`. **A release without the `.zip`
silently freezes every existing install** — the zip is the only thing the updater can
apply. Treat a missing asset as a failed deploy.

## 6. Commit, tag, push

```bash
git add -- package.json package-lock.json
git commit -m "Bump version to X.Y.Z"
git tag -a "vX.Y.Z" -m "PandaDoc Search X.Y.Z"   # with --allow-dirty: name the uncommitted files that shipped
git push origin HEAD          # release-branch mode: git push origin HEAD:refs/heads/<branch>
git push origin "vX.Y.Z"
```

The commit hook pushes the branch on its own; push the tag explicitly. The tag push
starts the Windows build in GitHub Actions — check it with `gh run list --limit 3` and
report its state (it finishes after this skill does; a failure there leaves the Mac
release live and only the Windows installer missing).

## 7. Release notes

```bash
gh release edit vX.Y.Z --repo dwitmer06-28-89/pandadoc-search --notes "..."
```

Plain language, one line per change a user would notice; skip internal work.

## 8. Report

- the version and the release URL, and that the gate had no suite to run,
- that installed copies update automatically (or now, from **Check for Updates…**),
- that the commit and tag were pushed, and the Windows workflow's state.

## Things that go wrong

- **No Developer ID certificate** — an unsigned build installs and then never
  auto-updates. Signing is not optional.
- **Notarization fails** — the build is not shippable; don't work around it.
- **`npm run dev` or an installed copy running** does not block a build, but a test
  lane's data is separate from the shipped app's by design (`lane.js`).
