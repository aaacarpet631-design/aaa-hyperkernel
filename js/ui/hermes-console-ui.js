/*
 * AAA Hermes Console — chat surface for the Hermes gateway.
 *
 * One text box that talks to the whole AI team through AAA_HERMES: type a
 * question, Hermes routes it to the right agent (or @mention one, @team for a
 * meeting) and the reply lands here. Renders the real per-channel transcript;
 * when AI is not configured it says so honestly instead of faking replies.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function hermes() { return global.AAA_HERMES; }

  const CHANNEL = 'app';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function bubble(entry) {
    const ui = U();
    const mine = entry.role === 'user';
    const who = mine ? 'You' : ('@' + (entry.agent || 'hermes') + (entry.confidence != null ? ' · ' + entry.confidence + '%' : ''));
    return ui.el('div', { attrs: { style:
      'margin:6px 0;padding:10px 12px;border-radius:12px;max-width:92%;' +
      (mine ? 'background:#1D4ED8;color:#fff;margin-left:auto' : 'background:#141418;border:1px solid #2A2A33;color:#F8FAFC')
    } }, [
      ui.el('div', { attrs: { style: 'font-size:11px;opacity:.7;margin-bottom:2px' }, text: who }),
      ui.el('div', { attrs: { style: 'white-space:pre-wrap;word-break:break-word;font-size:14px' }, html: esc(entry.text) })
    ]);
  }

  async function render(container) {
    const ui = U();
    const h = hermes();
    container.innerHTML = '';
    if (!ui || !h) return;

    const wrap = ui.el('div', { attrs: { style: 'border:1px solid #2A2A33;border-radius:14px;padding:12px;background:#0B0B0E' } });
    wrap.appendChild(ui.el('div', { attrs: { style: 'font-weight:700;margin-bottom:2px;color:#F8FAFC' }, text: 'Hermes — message your AI team' }));
    wrap.appendChild(ui.el('div', { attrs: { style: 'font-size:12px;color:#A1A1AA;margin-bottom:8px' },
      text: 'Routes to the right agent automatically. @sales, @operations… picks one; @team runs a meeting; /help for commands.' }));

    const feed = ui.el('div', { attrs: { style: 'max-height:300px;overflow:auto;display:flex;flex-direction:column;margin-bottom:8px' } });
    wrap.appendChild(feed);

    async function refresh() {
      feed.innerHTML = '';
      const msgs = await h.history(CHANNEL, 20);
      if (!msgs.length) {
        feed.appendChild(ui.el('div', { attrs: { style: 'color:#A1A1AA;font-size:13px;padding:6px' }, text: 'No messages yet — ask your team anything.' }));
      } else {
        msgs.forEach(function (m) { feed.appendChild(bubble(m)); });
      }
      feed.scrollTop = feed.scrollHeight;
    }

    const row = ui.el('div', { attrs: { style: 'display:flex;gap:8px' } });
    const input = ui.el('input', { className: 'aaa-input', attrs: { type: 'text', placeholder: h.isReady() ? 'Ask the team…' : 'AI not configured — /help still works', style: 'flex:1' } });
    const sendBtn = ui.button({ label: 'Send', onClick: submit });
    row.appendChild(input); row.appendChild(sendBtn);
    wrap.appendChild(row);
    const note = ui.el('div', { attrs: { style: 'font-size:11px;color:#A1A1AA;margin-top:6px;min-height:14px' } });
    wrap.appendChild(note);

    let busy = false;
    async function submit() {
      const text = input.value.trim();
      if (!text || busy) return;
      busy = true; sendBtn.disabled = true; note.textContent = 'Routing…';
      input.value = '';
      try {
        const res = await h.send({ channel: CHANNEL, text: text });
        if (res.ok === false) {
          note.textContent = res.error === 'AI_NOT_CONFIGURED'
            ? 'AI is not configured — connect the Claude proxy in Settings to talk to agents.'
            : 'Failed: ' + res.error;
        } else {
          note.textContent = res.routed ? ('Handled by @' + res.routed.agent + ' (' + res.routed.reason + ')') : '';
        }
      } catch (e) {
        note.textContent = 'Error: ' + (e && e.message ? e.message : e);
      }
      await refresh();
      busy = false; sendBtn.disabled = false;
    }
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });

    container.appendChild(wrap);
    await refresh();
  }

  global.AAA_HERMES_CONSOLE_UI = { render: render };
})(typeof window !== 'undefined' ? window : this);
