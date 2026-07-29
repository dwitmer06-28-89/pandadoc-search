// Tweak these to taste, then restart the app.

module.exports = {
  // Global hotkey that pops up the search bar.
  // Electron accelerator syntax: CommandOrControl, Alt, Shift, Control, Super.
  hotkey: 'Control+Shift+P',

  // Base URL for PandaDoc document search. The search term is appended
  // (URL-encoded) as the `search` param.
  baseUrl: 'https://app.pandadoc.com/a/#/documents-next',

  // Extra query params appended verbatim after the search term — carried over
  // from the Shortcut. Decodes to: {"status":"2"}
  extraParams: '&filters=%7B%22status%22%3A%222%22%7D',

  // How to open the results:
  //   'in-app'     -> one built-in window, reused for every search (default)
  //   'chrome-app' -> a chrome-less Chrome window (what your Shortcut was after)
  //   'browser'    -> your default browser, normal tab
  openMode: 'in-app',

  // in-app only. PandaDoc is a hash-routed SPA, so a new search is an in-page
  // navigation its router should handle on its own. Set true to force a full
  // reload after each search if results ever fail to refresh (slower).
  reloadOnSearch: false,

  // chrome-app only. Close a previously-opened PandaDoc search window before
  // opening the new one. Windows you've navigated away from (e.g. you clicked
  // into an actual document) are left alone.
  closePreviousWindow: true,

  // chrome-app mode only. Empty = use the default Chrome location for your OS.
  chromePath: '',
};
