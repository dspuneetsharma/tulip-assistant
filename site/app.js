(function () {
  'use strict';
  // Assistant chat page. All text from the server is inserted with textContent / createTextNode only; no HTML is ever parsed from a response.
  var EMAIL = '{{email}}';
  var OWNER = '{{owner}}';
  var ASSISTANT = '{{assistant}}';
  var MAX_CHARS = 1000;
  var REQUEST_TIMEOUT_MS = 75000;
  var STORE_KEY = 'assistant-chat-v1';

  var chat = document.getElementById('chat');
  var form = document.getElementById('composer');
  var input = document.getElementById('composer-input');
  var sendBtn = document.getElementById('send');
  var newBtn = document.getElementById('new-chat');
  var statusEl = document.getElementById('status');
  var countEl = document.getElementById('count');
  var starters = document.getElementById('starters');
  var welcomeText = document.getElementById('welcome-text');

  var transcript = [];   // what the visitor sees: [{kind: 'user'|'bot'|'error', text}]
  var history = [];      // what the server returned last time; sent back with the next question (the server re-validates it)
  var busy = false;
  var lastFailed = null; // text of the message whose answer failed, for "Try again"
  var typingEl = null;

  function store() {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ transcript: transcript.filter(function (m) { return m.kind !== 'error'; }), history: history })); } catch (e) { /* storage may be unavailable */ }
  }
  function restore() {
    try {
      var d = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null');
      if (d && Array.isArray(d.transcript) && Array.isArray(d.history)) {
        d.transcript.forEach(function (m) { if (m && (m.kind === 'user' || m.kind === 'bot') && typeof m.text === 'string') { transcript.push({ kind: m.kind, text: m.text }); } });
        history = d.history;
      }
    } catch (e) { /* ignore */ }
  }

  // Text with the one known email address turned into a mailto link. Everything else stays plain text.
  function fillText(el, text) {
    var parts = String(text).split(EMAIL);
    parts.forEach(function (part, i) {
      if (i > 0) {
        var a = document.createElement('a');
        a.href = 'mailto:' + EMAIL; a.textContent = EMAIL;
        el.appendChild(a);
      }
      if (part) el.appendChild(document.createTextNode(part));
    });
  }

  function addMessage(kind, text, opts) {
    var wrap = document.createElement('div');
    wrap.className = 'msg ' + (kind === 'user' ? 'user' : 'bot') + (kind === 'error' ? ' error' : '');
    var who = document.createElement('div');
    who.className = 'who'; who.textContent = kind === 'user' ? 'You' : ASSISTANT;
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (kind === 'error') bubble.setAttribute('role', 'alert');
    fillText(bubble, text);
    wrap.appendChild(who); wrap.appendChild(bubble);
    if (opts && opts.retry) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'btn secondary retry'; b.textContent = 'Try again';
      b.addEventListener('click', function () { wrap.remove(); send(lastFailed, true); });
      bubble.appendChild(document.createElement('br')); bubble.appendChild(b);
    }
    chat.appendChild(wrap);
    scrollDown();
    return wrap;
  }

  function scrollDown() { chat.scrollTop = chat.scrollHeight; }
  function setStatus(t) { statusEl.textContent = t || ''; }

  function showTyping() {
    typingEl = document.createElement('div');
    typingEl.className = 'msg bot typing';
    var who = document.createElement('div'); who.className = 'who'; who.textContent = ASSISTANT;
    var bubble = document.createElement('div'); bubble.className = 'bubble';
    bubble.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < 3; i++) { var d = document.createElement('span'); d.className = 'dot'; bubble.appendChild(d); }
    typingEl.appendChild(who); typingEl.appendChild(bubble);
    chat.appendChild(typingEl); scrollDown();
    setStatus(ASSISTANT + ' is typing\u2026');
  }
  function hideTyping() { if (typingEl) { typingEl.remove(); typingEl = null; } setStatus(''); }

  function setBusy(b) {
    busy = b; sendBtn.disabled = b; input.disabled = b; newBtn.disabled = false;
    chat.setAttribute('aria-busy', b ? 'true' : 'false');
    if (!b) input.focus();
  }

  function resize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; }
  function updateCount() {
    var n = input.value.length;
    countEl.textContent = n > MAX_CHARS - 150 ? n + ' / ' + MAX_CHARS : '';
  }

  function friendly(status, data) {
    if (data && typeof data.message === 'string' && data.message) return data.message;
    return 'Something went wrong. Please try again, or email ' + OWNER + ' at ' + EMAIL + '.';
  }

  function send(text, isRetry) {
    if (busy || !text) return;
    if (!isRetry) { addMessage('user', text); transcript.push({ kind: 'user', text: text }); }
    starters.hidden = true;
    lastFailed = text;
    setBusy(true); showTyping();
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, REQUEST_TIMEOUT_MS);
    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, history: history }),
      signal: ctl.signal,
      credentials: 'omit'
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) { return { res: res, data: data }; });
    }).then(function (r) {
      hideTyping();
      if (r.res.ok && r.data && typeof r.data.reply === 'string') {
        addMessage('bot', r.data.reply);
        transcript.push({ kind: 'bot', text: r.data.reply });
        if (Array.isArray(r.data.history)) history = r.data.history;
        lastFailed = null; store();
      } else {
        if (r.res.status === 400) history = []; // the saved context was not accepted: carry on without it
        var retryable = r.res.status >= 500 || r.res.status === 0;
        addMessage('error', friendly(r.res.status, r.data), { retry: retryable });
      }
    }).catch(function (e) {
      hideTyping();
      var msg = e && e.name === 'AbortError'
        ? ASSISTANT + ' took too long to answer. Please try again, or email ' + OWNER + ' at ' + EMAIL + '.'
        : 'Could not reach ' + ASSISTANT + '. Please check your connection and try again.';
      addMessage('error', msg, { retry: true });
    }).then(function () { clearTimeout(timer); setBusy(false); });
  }

  function reset() {
    transcript = []; history = []; lastFailed = null;
    try { sessionStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
    Array.prototype.slice.call(chat.querySelectorAll('.msg')).forEach(function (n) { if (n.id !== 'welcome') n.remove(); });
    hideTyping(); starters.hidden = false; setBusy(false); input.value = ''; resize(); updateCount(); input.focus();
    setStatus('New chat started.');
    setTimeout(function () { if (statusEl.textContent === 'New chat started.') setStatus(''); }, 2500);
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = ''; resize(); updateCount();
    send(text, false);
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  input.addEventListener('input', function () { resize(); updateCount(); });
  newBtn.addEventListener('click', reset);
  starters.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.chip') : null;
    if (b && b.getAttribute('data-q')) send(b.getAttribute('data-q'), false);
  });

  // Start: restore the earlier conversation in this tab (if any), then pick up the approved welcome text from the server.
  restore();
  transcript.forEach(function (m) { addMessage(m.kind, m.text); });
  if (transcript.length) starters.hidden = true;
  fetch('/api/config', { credentials: 'omit' }).then(function (r) { return r.json(); }).then(function (c) {
    if (c && typeof c.welcome === 'string' && c.welcome) welcomeText.textContent = c.welcome;
    if (c && typeof c.maxMessageChars === 'number') { MAX_CHARS = c.maxMessageChars; input.maxLength = c.maxMessageChars; }
  }).catch(function () { /* the built-in welcome text stays */ });
  resize();
})();
