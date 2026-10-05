// The feedback window's behaviour. Plain script, no framework: the report is
// built with the shared core (window.FeedbackCore, from feedback-core.browser.js)
// and handed to main.js through window.feedbackBridge (preload.js) to post.
(function () {
  'use strict';
  const core = window.FeedbackCore;
  const bridge = window.feedbackBridge;
  const $ = (id) => document.getElementById(id);

  /** The core's hint promises "the screens you visited"; these apps record none, so say only what is true. */
  const DIAG_HINT = 'Sends a record of what the app was doing so a bug can be found. Without it, bugs may take longer to fix.';
  /** The inbox refuses a screenshot over 3 MB; the core's downscale keeps it far below. */
  const SHOT_MAX = 3 * 1024 * 1024;
  const THANKS_MS = 1200;

  const draft = core.emptyDraft('bug');
  let ctx = null;
  // Set before the first await of a send, so a second click or Cmd-Return cannot post twice.
  let sending = false;

  const fields = ['happened', 'expected', 'request', 'currentHandling'];
  const send = $('send');

  function showError(message) {
    $('error').textContent = message || '';
    $('error').hidden = !message;
  }

  function sync() {
    const bug = draft.kind === 'bug';
    $('bug-fields').hidden = !bug;
    $('feature-fields').hidden = bug;
    $('diag').hidden = !bug || !ctx || !ctx.hasLog;
    send.disabled = sending || !ctx || core.draftProblem(draft) !== null;
    $('shot-empty').hidden = !!draft.screenshot;
    $('shot-full').hidden = !draft.screenshot;
  }

  function segmented(group, onPick) {
    const buttons = Array.from(group.querySelectorAll('[role="radio"]'));
    const pick = (btn) => {
      for (const b of buttons) {
        b.setAttribute('aria-checked', String(b === btn));
        b.tabIndex = b === btn ? 0 : -1;
      }
      onPick(btn.dataset.value);
      sync();
    };
    buttons.forEach((b) => {
      b.tabIndex = b.getAttribute('aria-checked') === 'true' ? 0 : -1;
      b.addEventListener('click', () => pick(b));
      b.addEventListener('keydown', (e) => {
        const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const next = buttons[(buttons.indexOf(b) + step + buttons.length) % buttons.length];
        pick(next);
        next.focus();
      });
    });
  }

  segmented($('kind'), (v) => {
    draft.kind = v === 'feature' ? 'feature' : 'bug';
    showError('');
    const first = $(draft.kind === 'bug' ? 'happened' : 'request');
    requestAnimationFrame(() => first.focus());
  });
  segmented($('flag'), (v) => {
    draft.flag = v === 'red' || v === 'yellow' || v === 'blue' ? v : null;
  });

  for (const name of fields) {
    $(name).addEventListener('input', (e) => {
      draft[name] = e.target.value;
      sync();
    });
  }

  $('shot-add').addEventListener('click', () => $('shot-file').click());
  $('shot-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    showError('');
    try {
      const url = await core.screenshotFromFile(file);
      if (url.length > SHOT_MAX) throw new Error('That image is too large to send.');
      draft.screenshot = url;
      $('shot-img').src = url;
    } catch (err) {
      showError(err instanceof Error ? err.message : 'That image could not be read.');
    }
    sync();
  });
  $('shot-remove').addEventListener('click', () => {
    draft.screenshot = null;
    $('shot-img').removeAttribute('src');
    sync();
    $('shot-add').focus();
  });

  $('diag-label').textContent = core.DIAGNOSTICS_SETTING_LABEL;
  $('diag-hint').textContent = DIAG_HINT;
  $('diag-box').checked = core.diagnosticsEnabled();
  $('diag-box').addEventListener('change', (e) => core.setDiagnosticsEnabled(e.target.checked));
  // The checkbox above IS the notice here — these apps have no Settings screen
  // for it — so the core's one-time banner is marked shown and never drawn.
  core.markDiagnosticsNoticeSeen();

  $('cancel').addEventListener('click', () => bridge.close());

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sending) {
      e.preventDefault();
      bridge.close();
    } else if (e.key === 'Enter' && e.metaKey) {
      e.preventDefault();
      $('form').requestSubmit();
    }
  });

  // Nothing dropped on the window opens in it.
  for (const type of ['dragover', 'drop']) document.addEventListener(type, (e) => e.preventDefault());

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (sending || !ctx || core.draftProblem(draft) !== null) return;
    sending = true;
    showError('');
    sync();
    send.textContent = 'Sending…';
    try {
      const log = ctx.hasLog ? await bridge.log() : null;
      const row = core.buildFeedbackRow(draft, {
        id: ctx.id,
        app: ctx.app,
        senderName: ctx.senderName,
        senderEmail: '',
        log,
      });
      const res = await bridge.send(row);
      if (!res || !res.ok) throw new Error((res && res.error) || 'The report could not be sent.');
      $('form').hidden = true;
      $('sent').hidden = false;
      setTimeout(() => bridge.close(), THANKS_MS);
    } catch (err) {
      // Keep everything typed; say what went wrong; let them try again.
      showError(err instanceof Error ? err.message : String(err));
      sending = false;
      send.textContent = 'Send';
      sync();
    }
  });

  // The window fits its content as fields come and go.
  new ResizeObserver(() => bridge.resize(Math.ceil(document.body.getBoundingClientRect().height))).observe(document.body);

  bridge.context().then(
    (c) => {
      ctx = c;
      if (!ctx) return showError('The feedback window could not start. Close it and try again.');
      core.recordOpen(`feedback form (${ctx.source || 'menu'})`);
      $('notice').textContent = ctx.senderNotice;
      $('sender').textContent = `Sent as ${ctx.senderName}.`;
      sync();
    },
    () => showError('The feedback window could not start. Close it and try again.')
  );

  sync();
  $('happened').focus();
})();
