// content.js — Channel Blocker for YouTube
// The whole extension in one file: channel blocking, keyword blocking, exceptions,
// strict mode, backups, the "Hide distractions" and "Minimalist" modes, and the control panel.
(() => {
  'use strict';

  if (window.__ycbLoaded) return;
  window.__ycbLoaded = true;

  const DAY = 24 * 60 * 60 * 1000;
  const EX_PREFIX = 'ex:';          // each exception is its own sync key (sync limit: 8 KB per key)
  const MAX_EXCEPTIONS = 450;       // sync allows up to 512 items, so keep some headroom
  const MAX_KEYWORDS = 100;         // the whole keyword list is one sync item, so it must stay under 8 KB
  const MAX_KEYWORD_LEN = 60;
  const BACKUP_FORMAT = 'ycb-backup';
  const MAX_BACKUP_BYTES = 1024 * 1024;
  const STRICT_MSG = "Strict mode is on: you can't add exceptions right now.";
  const STRICT_MODE_MSG = "Strict mode is on: you can't turn off blocking or switch to a less strict mode.";
  const STRICT_KEYWORD_MSG = "Strict mode is on: keywords can't be removed right now.";
  // In "Block all channels" mode, hide cards whose channel can't be read (safer than letting a blocked channel through)
  const HIDE_UNKNOWN_CARDS = true;

  // normal:  channel blocking is controlled by the "Block all channels" switch
  // focus:   "Hide distractions" – all Shorts are removed, and every channel not on the exception list is blocked
  // minimal: "Minimalist" – everything is hidden except YouTube search (youtube.com only)
  const MODES = ['normal', 'focus', 'minimal'];
  const MODE_LEVEL = { normal: 0, focus: 1, minimal: 2 }; // higher = stricter

  /* ========== YouTube selectors (if the markup changes, update them here) ========== */

  // Video and channel cards in feeds, search, recommendations and playlists
  const CARD_TAGS = [
    'ytd-rich-item-renderer', 'ytd-video-renderer', 'ytd-compact-video-renderer',
    'ytd-grid-video-renderer', 'ytd-playlist-video-renderer', 'ytd-playlist-renderer',
    'ytd-compact-playlist-renderer', 'ytd-compact-radio-renderer', 'ytd-reel-item-renderer',
    'ytd-reel-video-renderer', 'ytd-channel-renderer', 'ytd-grid-channel-renderer',
    'yt-lockup-view-model', 'ytm-video-with-context-renderer',
    'ytm-compact-video-renderer', 'ytm-rich-item-renderer'
  ].join(',');

  // Links that point to a channel
  const CHANNEL_LINK = [
    'a[href^="/@"]', 'a[href^="/channel/"]', 'a[href^="/c/"]', 'a[href^="/user/"]',
    'a[href*="youtube.com/@"]', 'a[href*="youtube.com/channel/"]'
  ].join(',');

  // Owner of the open video or Short
  const OWNER_LINK = [
    'ytd-video-owner-renderer a[href]', '#owner a[href]',
    'ytd-reel-video-renderer[is-active] a[href]', 'ytd-reel-player-overlay-renderer a[href]',
    'ytd-reel-player-header-renderer a[href]'
  ].join(',');

  // Title of a feed or search card, first match wins
  const CARD_TITLE = ['#video-title', 'a#video-title-link', 'h3 a', 'h3'];

  // Title of the open video on the watch page
  const WATCH_TITLE = 'h1.ytd-watch-metadata, ytd-watch-metadata h1, #title h1';

  // Every entry point to Shorts: hidden in "Hide distractions" and "Minimalist" modes
  const SHORTS_SELECTORS = [
    'ytd-reel-shelf-renderer',
    'ytd-rich-shelf-renderer[is-shorts]',
    'ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])',
    'ytd-reel-item-renderer',
    'ytd-reel-video-renderer',
    'ytm-shorts-lockup-view-model',
    'ytd-rich-item-renderer:has(a[href^="/shorts/"])',
    'ytd-video-renderer:has(a[href^="/shorts/"])',
    'ytd-compact-video-renderer:has(a[href^="/shorts/"])',
    'yt-lockup-view-model:has(a[href^="/shorts/"])',
    'ytd-guide-entry-renderer:has(a[href="/shorts"])',
    'ytd-mini-guide-entry-renderer[aria-label="Shorts"]',
    'yt-tab-shape[tab-title="Shorts" i]'
  ];

  // Extra elements hidden only in "Minimalist": sidebar, create/notification/account buttons
  const MINIMAL_SELECTORS = [
    'ytd-guide-renderer',
    'ytd-mini-guide-renderer',
    'ytd-masthead #end'
  ];

  /* ========== Interface styles (Shadow DOM, so they don't clash with the page) ========== */

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: Roboto, Arial, sans-serif; }
    [hidden] { display: none !important; }
    .fab { position: fixed; left: 12px; bottom: 12px; width: 40px; height: 40px; border-radius: 50%;
      border: 0; background: #c00; color: #fff; font-size: 18px; cursor: pointer; opacity: .7;
      z-index: 2147483647; box-shadow: 0 2px 8px rgba(0,0,0,.5); }
    .fab:hover { opacity: 1; }
    .panel { position: fixed; left: 12px; bottom: 62px; width: 330px; max-height: 70vh; overflow: auto;
      background: #212121; color: #eee; border-radius: 12px; padding: 14px; font-size: 13px;
      z-index: 2147483647; box-shadow: 0 8px 28px rgba(0,0,0,.6); }
    .head { display: flex; justify-content: space-between; align-items: center; font-size: 15px; margin-bottom: 8px; }
    .switch { display: flex; align-items: center; gap: 8px; font-size: 14px; margin: 6px 0; }
    .sep { border: 0; border-top: 1px solid #333; margin: 10px 0; }
    .strict { margin: 4px 0; }
    .strictOn { color: #ffd166; font-weight: 600; margin-bottom: 4px; }
    .row { display: flex; gap: 6px; margin: 8px 0 4px; align-items: center; }
    input[type=text], input[type=number] { min-width: 0; padding: 7px; border-radius: 6px; border: 1px solid #555;
      background: #111; color: #eee; }
    input[type=text] { flex: 1; }
    input[type=number] { width: 72px; flex: 0 0 72px; }
    button { padding: 7px 10px; border: 0; border-radius: 6px; background: #3ea6ff; color: #000;
      cursor: pointer; font-size: 13px; }
    button.ghost { background: #444; color: #eee; }
    button.danger { background: #b33; color: #fff; }
    button:disabled { opacity: .4; cursor: not-allowed; }
    .item { display: flex; justify-content: space-between; align-items: center; gap: 8px;
      padding: 6px 0; border-bottom: 1px solid #333; }
    .item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .muted { color: #aaa; font-size: 12px; margin: 4px 0; }
    .hint { color: #aaa; font-size: 12px; margin: -2px 0 6px 24px; }
    .overlay { position: fixed; inset: 0; z-index: 2147483640; background: #0f0f0f; color: #fff;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 14px; padding: 24px; text-align: center; }
    .overlay h1 { margin: 0; font-size: 24px; }
    .overlay p { margin: 0; color: #bbb; font-size: 15px; }
    .overlay .name { color: #fff; font-weight: 600; }
    .searchRow { display: flex; gap: 8px; width: min(420px, 90vw); }
    .topbar { position: fixed; top: 0; left: 0; right: 0; height: 56px; z-index: 2147483641;
      display: flex; align-items: center; justify-content: center; gap: 8px; padding: 0 16px;
      background: #0f0f0f; border-bottom: 1px solid #333; }
    .topbar input[type=text] { flex: 0 1 560px; height: 36px; }
    .topbar button { height: 36px; }
    .btns { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; margin-top: 8px; }
    .btns button { padding: 10px 16px; font-size: 14px; }
  `;

  // Page-level styles: blocked cards are hidden with [data-ycb-hidden];
  // Shorts and, in "Minimalist", the sidebar and header buttons are hidden with the html flags below.
  // Until the settings are read, cards stay hidden so a blocked channel can't flash on screen.
  const PAGE_CSS = [
    '[data-ycb-hidden] { display: none !important; }',
    `html:not([data-ycb-ready]) :is(${CARD_TAGS}) { display: none !important; }`,
    ...SHORTS_SELECTORS.map((s) => `html[data-ycb-hide-shorts] ${s} { display: none !important; }`),
    ...MINIMAL_SELECTORS.map((s) => `html[data-ycb-minimal] ${s} { display: none !important; }`)
  ].join('\n');

  /* ========== Utilities ========== */

  const esc = (s) => String(s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const decode = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } };
  const linkName = (a) => (a.textContent || '').replace(/\s+/g, ' ').trim();
  const unique = (arr) => [...new Set(arr.filter(Boolean))];
  const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  // Keyword from user input or a backup: trimmed, lowercase, length-limited; '' if unusable
  const cleanWord = (w) => (typeof w === 'string' ? w.trim().toLowerCase().slice(0, MAX_KEYWORD_LEN) : '');
  const isChannelPath = (p) => /^\/(@|channel\/|c\/|user\/)/.test(p);
  const isVideoPath = (p) => p === '/watch' || p.startsWith('/shorts/') || p.startsWith('/live/');
  const isShortsPath = (p) => p === '/shorts' || p.startsWith('/shorts/');
  const onSearchPage = () => location.pathname.startsWith('/results');
  const onMainSite = () => /^(www\.)?youtube\.com$/.test(location.hostname);
  const fmtDate = (ms) => new Date(ms).toLocaleDateString('en-US');
  const byAdded = (a, b) => (a.added || 0) - (b.added || 0);
  // Valid keys in an import: @handle, /c/name, /user/name or a channel ID
  const KEY_RE = /^(@[^\s/]{1,100}|\/(c|user)\/[^\s/]{1,100}|[^\s/@]{5,200})$/;

  // Channel key from a link: "@handle" (lowercase) or a channel ID like "UC…"
  function keysFromHref(href) {
    if (!href) return [];
    let u;
    try { u = new URL(href, 'https://www.youtube.com'); } catch (_) { return []; }
    if (!/(^|\.)youtube\.com$/.test(u.hostname)) return [];
    const [first, second] = u.pathname.split('/').filter(Boolean).map(decode);
    if (!first) return [];
    if (first.startsWith('@')) return [first.toLowerCase()];
    if (first === 'channel' && second) return [second];
    if ((first === 'c' || first === 'user') && second) return [`/${first}/${second.toLowerCase()}`];
    return [];
  }

  /* ========== Storage ========== */

  // Save errors must not be silent: show them in the panel
  const syncSet = (obj) => chrome.storage.sync.set(obj).catch((e) => {
    console.warn('[YCB] could not save:', e.message);
    if (panelEl) say('Could not save: ' + e.message);
  });
  const syncRemove = (key) => chrome.storage.sync.remove(key).catch((e) => {
    console.warn('[YCB] could not remove:', e.message);
  });

  /* ========== State and exceptions ========== */

  let state = { enabled: true, mode: 'normal', keywords: [], exceptions: [], strictUntil: 0, showFab: true }; // exceptions: [{ id, name, keys, added }]
  let allowed = new Set();
  let loaded = false;

  const strictActive = () => state.strictUntil > Date.now();
  const strictDaysLeft = () => Math.ceil((state.strictUntil - Date.now()) / DAY);
  // Minimalist works only on youtube.com; on other YouTube hosts it behaves like Normal
  const activeMode = () => (state.mode === 'minimal' && !onMainSite() ? 'normal' : state.mode);
  const minimalNow = () => activeMode() === 'minimal';
  // Both extra modes block all channels, whatever the "Block all channels" switch says
  const blockAll = () => state.enabled || activeMode() !== 'normal';

  function rebuildAllowed() {
    allowed = new Set(state.exceptions.flatMap((e) => e.keys));
  }
  const isAllowed = (keys) => keys.some((k) => allowed.has(k));

  // First keyword from the list that occurs in the text (case-insensitive), or null
  function findKeyword(text) {
    const t = String(text || '').toLowerCase();
    return state.keywords.find((w) => t.includes(w)) || null;
  }

  function saveSettings() {
    syncSet({ enabled: state.enabled, mode: state.mode, strictUntil: state.strictUntil, showFab: state.showFab });
  }

  // The whole keyword list is stored as one item
  function saveKeywords() {
    syncSet({ keywords: state.keywords });
  }

  // Save several exceptions in one operation
  function saveExceptions(list) {
    const obj = {};
    for (const ex of list) obj[EX_PREFIX + ex.id] = ex;
    if (Object.keys(obj).length) syncSet(obj);
  }

  // Add or extend an exception in memory, without saving
  function upsert(name, keys) {
    keys = unique(keys);
    if (!keys.length) return null;
    const found = state.exceptions.find((e) => e.keys.some((k) => keys.includes(k)));
    if (found) {
      found.keys = unique([...found.keys, ...keys]);
      found.name = found.name || name || keys[0];
      return found;
    }
    const ex = { id: newId(), name: name || keys[0], keys, added: Date.now() };
    state.exceptions.push(ex);
    return ex;
  }

  function addException(name, keys) {
    if (strictActive()) return false;
    if (state.exceptions.length >= MAX_EXCEPTIONS) { say('Exception limit reached.'); return false; }
    const ex = upsert(name, keys);
    if (!ex) return false;
    rebuildAllowed(); saveExceptions([ex]); refresh();
    return true;
  }

  // Removing an exception only makes blocking stricter, so it is allowed in strict mode
  function removeException(i) {
    const [ex] = state.exceptions.splice(i, 1);
    if (ex) syncRemove(EX_PREFIX + ex.id);
    rebuildAllowed(); refresh();
  }

  // Add the keys of an already allowed channel (for example, the channel ID from its page)
  function learn(keys) {
    const e = state.exceptions.find((x) => x.keys.some((k) => keys.includes(k)));
    if (!e) return;
    const merged = unique([...e.keys, ...keys]);
    if (merged.length !== e.keys.length) {
      e.keys = merged;
      rebuildAllowed();
      saveExceptions([e]);
    }
  }

  // Adding a keyword makes blocking stricter, so it is always allowed
  function submitKeyword() {
    const input = panelEl.querySelector('#kwAdd');
    const raw = input.value.trim();
    if (!raw) return say('Enter a word or phrase.');
    if (raw.length > MAX_KEYWORD_LEN) return say(`A keyword can be up to ${MAX_KEYWORD_LEN} characters.`);
    const w = cleanWord(raw);
    if (state.keywords.includes(w)) return say('This keyword is already in the list.');
    if (state.keywords.length >= MAX_KEYWORDS) return say('Keyword limit reached.');
    state.keywords = [...state.keywords, w];
    input.value = '';
    saveKeywords(); refresh();
    say('Keyword added.');
  }

  // Removing a keyword weakens blocking, so it is not allowed in strict mode
  function removeKeyword(i) {
    if (strictActive()) return say(STRICT_KEYWORD_MSG);
    state.keywords = state.keywords.filter((_, j) => j !== i);
    saveKeywords(); refresh();
  }

  function loadState() {
    chrome.storage.sync.get(null, (all) => {
      all = all || {};
      const exceptions = [];
      for (const [k, v] of Object.entries(all)) {
        if (k.startsWith(EX_PREFIX) && v) exceptions.push(v);
      }

      // Migration from the old version, which stored the whole list under one "exceptions" key
      if (Array.isArray(all.exceptions) && all.exceptions.length) {
        const have = new Set(exceptions.flatMap((e) => e.keys || []));
        const migrated = [];
        for (const old of all.exceptions) {
          if (!old || !Array.isArray(old.keys) || !old.keys.length) continue;
          if (old.keys.some((k) => have.has(k))) continue;
          const ex = { id: newId(), name: old.name || old.keys[0], keys: old.keys, added: Date.now() };
          exceptions.push(ex);
          migrated.push(ex);
          old.keys.forEach((k) => have.add(k));
        }
        saveExceptions(migrated);
        syncRemove('exceptions');
      }

      state = {
        enabled: all.enabled !== false,
        mode: MODES.includes(all.mode) ? all.mode : 'normal',
        keywords: Array.isArray(all.keywords) ? unique(all.keywords.map(cleanWord)).slice(0, MAX_KEYWORDS) : [],
        strictUntil: Number(all.strictUntil) || 0,
        showFab: all.showFab !== false,
        exceptions: exceptions.sort(byAdded)
      };
      rebuildAllowed();
      loaded = true;
      document.documentElement.setAttribute('data-ycb-ready', '');
      refresh();
    });
  }

  function onStorageChanged(changes, area) {
    if (area !== 'sync') return;
    for (const [k, ch] of Object.entries(changes)) {
      if (k.startsWith(EX_PREFIX)) {
        const id = k.slice(EX_PREFIX.length);
        state.exceptions = state.exceptions.filter((e) => e.id !== id);
        if (ch.newValue) state.exceptions.push(ch.newValue);
      } else if (k === 'enabled') {
        state.enabled = ch.newValue !== false;
      } else if (k === 'mode') {
        state.mode = MODES.includes(ch.newValue) ? ch.newValue : 'normal';
      } else if (k === 'keywords') {
        state.keywords = Array.isArray(ch.newValue) ? unique(ch.newValue.map(cleanWord)).slice(0, MAX_KEYWORDS) : [];
      } else if (k === 'strictUntil') {
        state.strictUntil = Number(ch.newValue) || 0;
      } else if (k === 'showFab') {
        state.showFab = ch.newValue !== false;
      }
    }
    state.exceptions.sort(byAdded);
    rebuildAllowed();
    if (loaded) refresh();
  }

  /* ========== Export and import ========== */

  function exportBackup() {
    const data = {
      format: BACKUP_FORMAT,
      version: 1,
      exported: new Date().toISOString(),
      settings: { enabled: state.enabled, mode: state.mode, showFab: state.showFab, strictUntil: state.strictUntil },
      keywords: state.keywords,
      exceptions: state.exceptions.map((e) => ({ name: e.name, keys: e.keys }))
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `youtube-channel-blocker-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    say(`Exported exceptions: ${data.exceptions.length}, keywords: ${data.keywords.length}.`);
  }

  // Import adds channels and keywords to the current lists and removes nothing
  async function importBackup(file) {
    if (!file) return;
    try {
      if (file.size > MAX_BACKUP_BYTES) return say('The file is too large to be a backup.');

      let data;
      try { data = JSON.parse(await file.text()); }
      catch (_) { return say("The file can't be read: it isn't JSON."); }
      if (!data || data.format !== BACKUP_FORMAT || !Array.isArray(data.exceptions)) {
        return say('This is not a backup file from this extension.');
      }

      // Settings: the strict period can only be extended, and blocking
      // can't be turned off or weakened while strict mode is active
      const s = data.settings || {};
      const importedUntil = Number(s.strictUntil);
      if (Number.isFinite(importedUntil) && importedUntil > state.strictUntil && importedUntil < 1e13) {
        state.strictUntil = importedUntil;
      }
      if (typeof s.showFab === 'boolean') state.showFab = s.showFab;
      if (typeof s.enabled === 'boolean' && !(strictActive() && !s.enabled)) state.enabled = s.enabled;
      if (MODES.includes(s.mode) && !(strictActive() && MODE_LEVEL[s.mode] < MODE_LEVEL[state.mode])) {
        state.mode = s.mode;
      }

      // Keywords: adding is always allowed, even in strict mode
      let kwAdded = 0;
      for (const raw of Array.isArray(data.keywords) ? data.keywords : []) {
        const w = cleanWord(raw);
        if (!w || state.keywords.includes(w) || state.keywords.length >= MAX_KEYWORDS) continue;
        state.keywords = [...state.keywords, w];
        kwAdded++;
      }

      const locked = strictActive();
      let added = 0, merged = 0, skipped = 0;
      const touched = new Map();

      if (locked) {
        skipped = data.exceptions.length;
      } else {
        for (const item of data.exceptions) {
          const keys = item && Array.isArray(item.keys)
            ? unique(item.keys
                .filter((k) => typeof k === 'string' && KEY_RE.test(k))
                .map((k) => (k.startsWith('@') ? k.toLowerCase() : k)))
            : [];
          if (!keys.length || state.exceptions.length >= MAX_EXCEPTIONS) { skipped++; continue; }
          const existed = state.exceptions.some((e) => e.keys.some((k) => keys.includes(k)));
          const ex = upsert(String(item.name || '').slice(0, 100), keys);
          if (!ex) { skipped++; continue; }
          if (existed) merged++; else added++;
          touched.set(ex.id, ex);
        }
      }

      rebuildAllowed();
      saveExceptions([...touched.values()]);
      if (kwAdded) saveKeywords();
      saveSettings();
      refresh();

      const parts = locked
        ? [`strict mode: channels not imported (${skipped})`]
        : [`added ${added}, updated ${merged}`].concat(skipped ? [`skipped ${skipped}`] : []);
      if (kwAdded) parts.push(`keywords added ${kwAdded}`);
      say('Import: ' + parts.join('; ') + '.');
    } catch (e) {
      say('Import failed: ' + e.message);
    }
  }

  /* ========== Channel and title detection ========== */

  // Channel from a feed card
  function cardChannel(root) {
    let keys = null, name = '';
    for (const a of root.querySelectorAll(CHANNEL_LINK)) {
      const k = keysFromHref(a.getAttribute('href'));
      if (!k.length) continue;
      keys = keys || k;
      name = name || linkName(a);
      if (name) break;
    }
    return keys ? { keys, name: name || keys[0] } : null;
  }

  // Title of a feed or search card
  function cardTitle(root) {
    for (const sel of CARD_TITLE) {
      const el = root.querySelector(sel);
      const t = el ? el.textContent.trim() : '';
      if (t) return t;
    }
    return '';
  }

  // Channel from the channel page
  function channelPageInfo() {
    const canon = document.querySelector('link[rel="canonical"]');
    const keys = unique([...keysFromHref(location.pathname), ...keysFromHref(canon && canon.href)]);
    const nameEl = document.querySelector('ytd-channel-name yt-formatted-string, #channel-name #text');
    const name = nameEl ? nameEl.textContent.trim() : '';
    return { keys, name: name || keys[0] || '' };
  }

  // Owner of the open video or Short
  function videoOwnerInfo() {
    for (const a of document.querySelectorAll(OWNER_LINK)) {
      const keys = keysFromHref(a.getAttribute('href'));
      if (keys.length) return { keys, name: linkName(a) || keys[0] };
    }
    return null;
  }

  // Title of the open video: from the page heading, else from the page's title meta tag
  function videoTitle() {
    const el = document.querySelector(WATCH_TITLE);
    const t = el ? el.textContent.trim() : '';
    if (t) return t;
    const meta = document.querySelector('meta[name="title"]');
    return meta ? String(meta.getAttribute('content') || '').trim() : '';
  }

  /* ========== Blocking ========== */

  // What the last check saw on this page: shown in the panel
  let stats = { cards: 0, hidden: 0, unknown: 0 };

  // Hide cards of blocked channels and cards whose title contains a keyword.
  // On the search page channel cards are left alone: the channel stays visible, but its videos can't be opened.
  function filterCards() {
    const path = location.pathname;
    const byChannel = blockAll() && !onSearchPage();
    const byWord = state.keywords.length > 0;
    // On channel and video pages the cards belong to the page's own channel, which checkPage has already judged
    const feedPage = !isChannelPath(path) && !isVideoPath(path);
    const s = { cards: 0, hidden: 0, unknown: 0 };

    for (const card of document.querySelectorAll(CARD_TAGS)) {
      s.cards++;
      let hide = false;
      if (byChannel) {
        const ch = cardChannel(card);
        if (ch) {
          hide = !isAllowed(ch.keys);
        } else if (feedPage) {
          // No readable channel: not rendered yet, or a layout we don't know.
          // Hiding it is safer than letting a blocked channel through.
          s.unknown++;
          hide = HIDE_UNKNOWN_CARDS;
        }
      }
      if (!hide && byWord) hide = !!findKeyword(cardTitle(card));
      if (hide) s.hidden++;
      card.toggleAttribute('data-ycb-hidden', hide);
    }
    stats = s;
  }

  // Page-wide flags used by the CSS rules in PAGE_CSS.
  // Attribute changes are not watched by the MutationObserver, so this does not cause extra work.
  function applyMode() {
    const root = document.documentElement;
    const mode = activeMode();
    root.toggleAttribute('data-ycb-hide-shorts', mode !== 'normal');
    root.toggleAttribute('data-ycb-minimal', mode === 'minimal');
  }

  let pendingKey = '', pendingSince = 0;

  // The page renders its channel and title a little late, so wait up to 6 s before judging.
  // Returns true while still waiting. The wait restarts only when the video changes.
  function pageWait(key) {
    if (pendingKey !== key) {
      pendingKey = key;
      pendingSince = Date.now();
      setTimeout(schedule, 6100); // check again when the wait runs out
    }
    return Date.now() - pendingSince < 6000;
  }

  // Check the open page
  function checkPage() {
    const path = location.pathname;

    // Hide distractions and Minimalist: Shorts pages are not available at all
    if (activeMode() !== 'normal' && isShortsPath(path)) { pendingKey = ''; return showOverlay({ shorts: true }); }

    // Minimalist: home, feeds and other pages are replaced by the search overlay.
    // Channel and video pages go through the normal checks below, so allowed channels still open.
    if (minimalNow() && !onSearchPage() && !isChannelPath(path) && !isVideoPath(path)) {
      pendingKey = '';
      return showOverlay({ minimal: true });
    }

    if (isChannelPath(path)) {
      pendingKey = '';
      return blockAll() ? gate(channelPageInfo()) : hideOverlay();
    }

    if (isVideoPath(path)) return checkVideoPage(path);

    pendingKey = '';
    hideOverlay();
  }

  // Video pages: the channel check (only when blocking is on), then the title against the keywords
  function checkVideoPage(path) {
    const key = path + location.search;

    if (blockAll()) {
      const owner = videoOwnerInfo();
      if (owner && !isAllowed(owner.keys)) { pendingKey = ''; return showOverlay({ blocked: true, ...owner }); }
      if (!owner) return showOverlay(pageWait(key) ? { pending: true } : { unknown: true });
      learn(owner.keys);
    }

    // Keywords apply to regular videos, including those from allowed channels.
    // Shorts pages are handled as a whole above, so their titles are not checked here.
    if (state.keywords.length && !isShortsPath(path)) {
      const title = videoTitle();
      if (!title) {
        // Title not rendered yet: wait briefly, then let the page through rather than block on a guess
        if (pageWait(key)) return showOverlay({ pending: true });
        return hideOverlay();
      }
      const word = findKeyword(title);
      if (word) { pendingKey = ''; return showOverlay({ keyword: true, title, word }); }
    }

    pendingKey = '';
    hideOverlay();
  }

  function gate(info) {
    if (!info.keys.length) return showOverlay({ unknown: true });
    if (isAllowed(info.keys)) { learn(info.keys); return hideOverlay(); }
    return showOverlay({ blocked: true, ...info });
  }

  /* ========== Overlay and panel ========== */

  let ui, fabEl, panelEl, overlayEl, topbarEl, topbarInput;
  let overlayKey = '', currentBlock = null;
  let topbarFor = null; // search string the top bar was last filled for

  function showOverlay(info) {
    pauseVideos();
    const base = info.minimal ? 'minimal'
      : info.shorts ? 'shorts'
      : info.keyword ? 'kw:' + info.title + '|' + info.word
      : info.blocked ? 'b:' + info.keys[0]
      : info.pending ? 'pending'
      : 'unknown';
    const key = base + (strictActive() ? ':strict' : '');
    if (key !== overlayKey) {
      overlayKey = key;
      currentBlock = info.blocked ? info : null;
      overlayEl.innerHTML = overlayHtml(info);
      if (info.minimal) overlayEl.querySelector('#q')?.focus();
    }
    overlayEl.hidden = false;
  }

  function hideOverlay() {
    overlayKey = '';
    currentBlock = null;
    overlayEl.hidden = true;
  }

  // Minimalist on the search and watch pages: our own search bar replaces YouTube's header search
  function updateTopbar() {
    const show = minimalNow() && (onSearchPage() || location.pathname === '/watch');
    topbarEl.hidden = !show;
    if (show && topbarFor !== location.search) {
      topbarFor = location.search;
      topbarInput.value = new URLSearchParams(location.search).get('search_query') || '';
    }
  }

  function pauseVideos() {
    document.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch (_) {} });
  }

  function overlayHtml(info) {
    const strict = strictActive();

    if (info.minimal) {
      return `<h1>Minimalist mode</h1>
        <p>Only YouTube search is available.</p>
        <div class="searchRow">
          <input type="text" id="q" placeholder="Search YouTube" autocomplete="off">
          <button data-act="search">Search</button>
        </div>
        <div class="btns"><button data-act="settings" class="ghost">Settings</button></div>`;
    }
    if (info.shorts) {
      return `<h1>Shorts are hidden</h1>
        <p>"Hide distractions" mode hides all Shorts.</p>
        <div class="btns">
          <button data-act="settings">Settings</button>
          <button data-act="back" class="ghost">Back</button>
        </div>`;
    }
    if (info.keyword) {
      return `<h1>Video blocked by keyword</h1>
        <p class="name">${esc(info.title)}</p>
        <p>Matched keyword: "${esc(info.word)}"</p>
        <div class="btns">
          <button data-act="settings">Settings</button>
          <button data-act="back" class="ghost">Back</button>
        </div>`;
    }
    if (info.pending) {
      return `<h1>Checking the video…</h1>
        <p>The video is hidden until it is checked.</p>
        <div class="btns"><button data-act="back" class="ghost">Back</button></div>`;
    }
    if (info.unknown) {
      const hint = strict
        ? 'Strict mode: exceptions are unavailable right now.'
        : 'If needed, add this channel to exceptions in the settings.';
      return `<h1>Channel not detected</h1>
        <p>The video is hidden. ${hint}</p>
        <div class="btns">
          <button data-act="settings">Settings</button>
          <button data-act="back" class="ghost">Back</button>
        </div>`;
    }
    const allowBtn = strict ? '' : '<button data-act="allow">Allow this channel</button>';
    const note = strict
      ? `<p>Strict mode until ${fmtDate(state.strictUntil)}: exceptions are unavailable.</p>`
      : '';
    return `<h1>🚫 Channel blocked</h1>
      <p class="name">${esc(info.name)}</p>
      <p>This channel is on the block list.</p>
      ${note}
      <div class="btns">
        ${allowBtn}
        <button data-act="settings" class="ghost">Settings</button>
        <button data-act="back" class="ghost">Back</button>
      </div>`;
  }

  function panelHtml() {
    return `
      <div class="head"><b>Channel Blocker</b><button id="close" class="ghost">✕</button></div>
      <b>Mode</b>
      <label class="switch"><input type="radio" name="mode" value="normal"> Normal</label>
      <label class="switch"><input type="radio" name="mode" value="focus"> Hide distractions</label>
      <p class="hint">Removes all Shorts and blocks every channel that isn't on the exception list.</p>
      <label class="switch"><input type="radio" name="mode" value="minimal"> Minimalist</label>
      <p class="hint">Hides everything except YouTube search. Works only on youtube.com.</p>
      <hr class="sep">
      <label class="switch"><input type="checkbox" id="enabled"> Block all channels</label>
      <label class="switch"><input type="checkbox" id="showFab"> Show the ⛔ button</label>
      <p class="muted">Open settings with Ctrl+Shift+K, even when the button is hidden.</p>
      <p id="stat" class="muted"></p>
      <hr class="sep">
      <div id="strict" class="strict"></div>
      <hr class="sep">
      <div id="addRow" class="row">
        <input type="text" id="add" placeholder="@channel or channel link">
        <button id="addBtn">Add</button>
      </div>
      <p id="msg" class="muted"></p>
      <div id="list"></div>
      <hr class="sep">
      <b>Block videos by keyword</b>
      <p class="muted">A video whose title contains one of these words is hidden in lists and blocked on its page. Case-insensitive. Works in every mode, including for allowed channels.</p>
      <div class="row">
        <input type="text" id="kwAdd" placeholder="Word or phrase">
        <button id="kwBtn">Add</button>
      </div>
      <div id="kwList"></div>
      <hr class="sep">
      <b>Backup</b>
      <p class="muted">Export saves exceptions, keywords and settings to a file. Import adds them to the current lists and removes nothing.</p>
      <div class="row">
        <button id="exportBtn" class="ghost">Export</button>
        <button id="importBtn" class="ghost">Import</button>
      </div>
      <input type="file" id="importFile" accept=".json,application/json" hidden>`;
  }

  function say(text) {
    if (panelEl) panelEl.querySelector('#msg').textContent = text;
  }

  // Diagnostics line in the panel: what the last check saw on this page
  function renderStat() {
    if (!panelEl) return;
    panelEl.querySelector('#stat').textContent =
      `On this page: ${stats.cards} cards, ${stats.hidden} hidden, ${stats.unknown} without a readable channel`;
  }

  function renderPanel() {
    renderStat();
    const strict = strictActive();

    const enabled = panelEl.querySelector('#enabled');
    enabled.checked = blockAll();
    enabled.disabled = activeMode() !== 'normal'; // the other modes always block channels
    panelEl.querySelector('#showFab').checked = state.showFab;
    panelEl.querySelector('#addRow').hidden = strict;
    panelEl.querySelectorAll('input[name=mode]').forEach((r) => { r.checked = r.value === state.mode; });

    panelEl.querySelector('#strict').innerHTML = strict
      ? `<div class="strictOn">🔒 Strict mode until ${fmtDate(state.strictUntil)} (${strictDaysLeft()} days left)</div>
         <p class="muted">You can't add exceptions, turn off blocking, or switch to a less strict mode. You can only extend the period.</p>
         <div class="row"><input type="number" id="days" min="1" max="3650" value="30"><span class="muted">days</span><button id="strictExtend">Extend</button></div>`
      : `<b>Strict mode</b>
         <p class="muted">For the chosen period, you won't be able to add exceptions, turn off blocking, or switch to a less strict mode.</p>
         <div class="row"><input type="number" id="days" min="1" max="3650" value="30"><span class="muted">days</span><button id="strictStart">Enable</button></div>`;

    const delTitle = strict
      ? 'Removal is allowed: it only makes blocking stricter'
      : 'Remove from exceptions';
    const list = panelEl.querySelector('#list');
    list.innerHTML = state.exceptions.length
      ? `<p class="muted">Exceptions (${state.exceptions.length}):</p>` +
        state.exceptions.map((e, i) =>
          `<div class="item"><span title="${esc(e.keys.join(', '))}">${esc(e.name)}</span>` +
          `<button class="danger" data-del="${i}" title="${esc(delTitle)}">✕</button></div>`).join('')
      : '<p class="muted">No exceptions yet.</p>';

    const kw = panelEl.querySelector('#kwList');
    kw.innerHTML = state.keywords.length
      ? state.keywords.map((w, i) =>
          `<div class="item"><span title="${esc(w)}">${esc(w)}</span>` +
          `<button class="danger" data-kw="${i}" ${strict ? 'disabled' : ''} ` +
          `title="${esc(strict ? STRICT_KEYWORD_MSG : 'Remove keyword')}">✕</button></div>`).join('')
      : '<p class="muted">No keywords yet.</p>';
  }

  function openPanel(open) {
    panelEl.hidden = !open;
    if (open) renderPanel();
  }

  // Parse input: @name, a channel link, or a channel ID like UC…
  function parseChannelInput(text) {
    let t = text.trim();
    if (!t) return null;
    if (/youtube\.com\//i.test(t) && !/^https?:\/\//i.test(t)) t = 'https://' + t;
    if (/^(https?:\/\/|\/)/i.test(t)) {
      const k = keysFromHref(t);
      return k.length ? k : null;
    }
    if (/^UC[\w-]{20,}$/.test(t)) return [t];
    const h = t.startsWith('@') ? t : '@' + t;
    return /^@[^\s/]+$/.test(h) ? [h.toLowerCase()] : null;
  }

  function submitInput() {
    if (strictActive()) return say(STRICT_MSG);
    const input = panelEl.querySelector('#add');
    const keys = parseChannelInput(input.value);
    if (!keys) return say('Not a channel. Example: @name or https://www.youtube.com/@name');
    if (!addException('', keys)) return;
    input.value = '';
    say('Added to exceptions.');
  }

  // Strict mode: the period is added to the current end, so it can only be extended
  function startStrict(raw) {
    const days = Math.floor(Number(raw));
    if (!(days >= 1 && days <= 3650)) return say('Enter a number of days from 1 to 3650.');
    state.strictUntil = Math.max(Date.now(), state.strictUntil) + days * DAY;
    saveSettings(); refresh();
    say(`Strict mode is active until ${fmtDate(state.strictUntil)}.`);
  }

  // Switching to a stricter mode is always allowed; switching to a less strict one is not during strict mode
  function setMode(next) {
    if (!MODES.includes(next) || next === state.mode) return renderPanel();
    if (strictActive() && MODE_LEVEL[next] < MODE_LEVEL[state.mode]) {
      say(STRICT_MODE_MSG);
      return renderPanel(); // puts the radio button back
    }
    state.mode = next;
    saveSettings(); refresh();
  }

  // Open the search typed into one of our search fields
  function runSearch(text) {
    const q = String(text || '').trim();
    if (q) location.href = '/results?search_query=' + encodeURIComponent(q);
  }

  function applyFab() {
    if (fabEl) fabEl.hidden = !state.showFab;
  }

  function buildUI() {
    const host = document.createElement('div');
    host.id = 'ycb-host';
    // Keys typed into our inputs must not trigger YouTube's keyboard shortcuts
    host.addEventListener('keydown', (e) => e.stopPropagation());
    ui = host.attachShadow({ mode: 'open' });
    ui.innerHTML = `
      <style>${CSS}</style>
      <button id="fab" class="fab" title="Channel Blocker (Ctrl+Shift+K)">⛔</button>
      <form id="topbar" class="topbar" hidden>
        <input type="text" id="qTop" placeholder="Search YouTube" autocomplete="off">
        <button type="submit">Search</button>
      </form>
      <div id="panel" class="panel" hidden>${panelHtml()}</div>
      <div id="overlay" class="overlay" hidden></div>`;

    fabEl = ui.getElementById('fab');
    panelEl = ui.getElementById('panel');
    overlayEl = ui.getElementById('overlay');
    topbarEl = ui.getElementById('topbar');
    topbarInput = ui.getElementById('qTop');

    fabEl.addEventListener('click', () => openPanel(panelEl.hidden));

    topbarEl.addEventListener('submit', (e) => {
      e.preventDefault();
      runSearch(topbarInput.value);
    });

    overlayEl.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'allow' && currentBlock) {
        addException(currentBlock.name, currentBlock.keys);
      } else if (act === 'search') {
        runSearch(overlayEl.querySelector('#q')?.value);
      } else if (act === 'settings') {
        openPanel(true);
      } else if (act === 'back') {
        if (history.length > 1) history.back();
        else location.href = 'https://www.youtube.com/';
      }
    });

    // Enter in the minimalist search box
    overlayEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.id === 'q') runSearch(e.target.value);
    });

    panelEl.addEventListener('click', (e) => {
      const t = e.target;
      if (t.id === 'close') openPanel(false);
      else if (t.id === 'addBtn') submitInput();
      else if (t.id === 'kwBtn') submitKeyword();
      else if (t.id === 'strictStart' || t.id === 'strictExtend') startStrict(panelEl.querySelector('#days').value);
      else if (t.id === 'exportBtn') exportBackup();
      else if (t.id === 'importBtn') panelEl.querySelector('#importFile').click();
      else if (t.dataset && t.dataset.del !== undefined) removeException(Number(t.dataset.del));
      else if (t.dataset && t.dataset.kw !== undefined) removeKeyword(Number(t.dataset.kw));
    });

    panelEl.addEventListener('change', (e) => {
      const t = e.target;
      if (t.name === 'mode') {
        setMode(t.value);
      } else if (t.id === 'enabled') {
        if (!t.checked && strictActive()) {
          t.checked = true;
          return say("Strict mode: you can't turn off blocking.");
        }
        state.enabled = t.checked;
        saveSettings(); refresh();
      } else if (t.id === 'showFab') {
        state.showFab = t.checked;
        saveSettings(); applyFab();
      } else if (t.id === 'importFile') {
        const file = t.files && t.files[0];
        t.value = ''; // so the same file can be picked again
        importBackup(file);
      }
    });

    panelEl.querySelector('#add').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitInput();
    });

    panelEl.querySelector('#kwAdd').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitKeyword();
    });

    document.documentElement.appendChild(host);
  }

  /* ========== Check loop ========== */

  let strictWas = null;

  function tick() {
    if (!loaded) return;
    applyMode();
    // When strict mode starts or expires, refresh the panel
    const s = strictActive();
    if (s !== strictWas) {
      strictWas = s;
      if (panelEl) renderPanel();
    }
    filterCards();
    if (panelEl && !panelEl.hidden) renderStat();
    updateTopbar();
    checkPage();
  }

  function refresh() {
    tick();
    if (panelEl) renderPanel();
    applyFab();
  }

  // Several DOM mutations in a row produce one check, not dozens
  let timer = 0;
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = 0; tick(); }, 300);
  }

  // Coming back to the tab (from the tray or another window, or after Chrome froze it) checks at once.
  // Timers in hidden tabs are throttled, so without this the page could stay unchecked for a while.
  function recheckNow() {
    if (!loaded) return;
    tick();
    setTimeout(tick, 1000); // the feed may still be rendering
    setTimeout(tick, 3000);
  }

  /* ========== Start ========== */

  function init() {
    const style = document.createElement('style');
    style.textContent = PAGE_CSS;
    (document.head || document.documentElement).appendChild(style);

    buildUI();

    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href'] // some cards are updated by changing a link, without adding nodes
    });
    window.addEventListener('yt-navigate-finish', schedule);
    window.addEventListener('popstate', schedule);

    document.addEventListener('visibilitychange', () => { if (!document.hidden) recheckNow(); });
    window.addEventListener('focus', recheckNow);
    window.addEventListener('pageshow', recheckNow);
    document.addEventListener('resume', recheckNow); // Chrome unfroze the tab

    // Don't keep the feed hidden for long if the settings never arrive
    setTimeout(() => document.documentElement.setAttribute('data-ycb-ready', ''), 3000);

    // Every 5 seconds: strict mode expiry and timeouts, without touching the DOM much
    setInterval(tick, 5000);

    // Ctrl+Shift+K opens settings even when the button is hidden (uses the key code, not the layout letter)
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyK') {
        e.preventDefault();
        if (loaded) openPanel(panelEl.hidden);
      }
    }, true);

    loadState();
    chrome.storage.onChanged.addListener(onStorageChanged);
  }

  init();
})();