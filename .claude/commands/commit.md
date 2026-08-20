---
description: Commit session edits immediately (no push)
---

Commit **only** the files you have edited or written during this conversation — nothing else, even if `git status` shows other changes.

## Steps

1. **Identify the session files.** Look back through this conversation for every `Edit`, `Write`, or `NotebookEdit` tool call you made and collect the absolute file paths. This is the authoritative list — do **not** infer it from `git status` or `git diff`, because the working tree may contain unrelated changes the user is intentionally leaving uncommitted.

   If the user passed an explicit list of files as arguments to `/commit`, use those instead.

2. **Verify and filter.** For each path, check that the file still exists and that `git status --porcelain -- <path>` shows it as modified, added, or untracked. Drop any paths that are clean (the edit may have been reverted) or that no longer exist. If the resulting list is empty, tell the user and stop — do not create an empty commit.

3. **Secret check.** Before staging, scan paths for likely secrets (`.env`, `credentials*`, `*.pem`, `*.key`, tokens in config). If any match, warn the user and ask before proceeding — do not commit them unless they explicitly confirm.

4. **Check recent commit style.** Run `git log -5 --oneline` to see how this repo writes commit messages (imperative mood, prefix conventions like `fix:` / `feat:`, capitalization, length). Match that style.

5. **Draft the commit message.** One line focused on the "why" of the change, not a file list. Keep the subject concise (under ~72 characters). If the session touched multiple unrelated things, write a subject for the dominant change and add a short body listing the others.

6. **Stage and commit.** Stage **only** the session files by name (`git add -- <file1> <file2> ...`) — never use `git add -A` or `git add .`. Then commit via HEREDOC:

   ```bash
   git commit -m "$(cat <<'EOF'
   <subject line>

   <optional body>

   Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
   EOF
   )"
   ```

7. **Confirm commit.** Run `git status` and `git log -1 --stat` to verify the commit landed. Then report per **Reporting** below — do NOT narrate the hash, the subject or the file list.

8. **Install the desktop app.** Last, build the packaged Electron app and install it to `~/Applications`:

   ```bash
   npm run install-desktop
   ```

   This is the **packaged** bundle, not the dev shell: `app.isPackaged === true`, so it runs with
   debug off — no DevTools, no dev menu, no dev-only logging — and serves its own bundled assets
   rather than a dev server. It is the copy the user actually works in, so a commit that isn't in it
   isn't really in their hands yet.

   Expect a couple of minutes; it is a full production build. The script stops the installed copy,
   replaces the bundle, relaunches it and confirms it stayed up. App data is untouched.

   If the build or the install fails, **say so plainly and report the error** — the commit already
   landed and is unaffected, and the previously installed app is left exactly as it was. Do not
   retry silently.

## Hard rules

- **Never push.** This command is local-only. Do not run `git push` even if the branch tracks a remote.
- **Never amend.** Always create a new commit.
- **Never use `git add -A` / `git add .` / `git add -u`.** Stage files individually by path.
- **Never skip hooks** (no `--no-verify`). If a hook fails, fix the underlying issue and create a new commit.
- **Never commit files that look like they hold secrets** — warn the user instead and ask before proceeding.
- **Never update git config** or run destructive git commands unless the user explicitly asks.
- **The install step never blocks the commit.** Commit first, install second. If the build fails, the commit still stands — report the failure rather than trying to undo anything.

## Reporting

Report **only** two things. Nothing else — no file tables, no commit hashes, no commit-message rationale, no repo tours, no restating the pre-commit checks, no push/branch status, no summary of what the commits contained, no offers of follow-up work.

1. **Session files that could NOT be committed.** A file you edited this session that a hook, a lock, a conflict, or another session's in-flight state kept out of the commit. Name the file and the one-line reason, so the user knows to come back after that other session finishes. Files you left alone because *you* never edited them are NOT this — those are the normal case and are never worth a word.
2. **Push back on the commit.** A real concern about what was just committed: a secret-shaped value, a dev-server address, a hook you had to work around, a change you think is wrong. One or two sentences.

If neither applies, your entire response is:

✅ Fully committed

That is the whole reply.
