/*
 * AAA Decision Card — the one-tap approval surface for a Decision Inbox card.
 *
 * Renders a governed recommendation into an AAA_UI bottom sheet: what fired
 * (trigger), the money (expected value), the confidence, an honest one-line
 * rationale, a MASKED recipient (name + last 4 digits only — the full phone
 * number never reaches the DOM), and two thumb-sized buttons: "Approve Send"
 * and "Reject". Approving calls AAA_DECISION_INBOX.dispatch — which is
 * DRY-RUN ONLY (see decision-inbox.js): no message is ever sent.
 *
 * CRITICAL LESSON (prior invisible-sheet bug): AAA_UI.sheet() returns
 * { overlay, body, close } and the CALLER must append s.overlay to
 * document.body or the sheet never appears. This module does that, and its
 * test asserts it. DOM-guarded; everything rendered through esc().
 */
;(function (global) {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]); }); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function fmtMoney(n) { return '$' + Math.round(num(n)).toLocaleString('en-US'); }

  /** "Follow-up due — Henderson" / "Open estimate idle — Henderson". */
  function triggerLine(card) {
    const ev = (card.trigger && card.trigger.event) || '';
    const name = (card.trigger && card.trigger.payload && card.trigger.payload.customerName) || 'Customer';
    const label = ev === 'quote.follow_up_due' ? 'Follow-up due' : 'Open estimate idle';
    return label + ' — ' + name;
  }

  /** Mask the recipient: name + last 4 digits ONLY. Never the full number. */
  function maskedRecipient(card) {
    const name = (card.trigger && card.trigger.payload && card.trigger.payload.customerName) || 'Customer';
    const digits = String((card.proposal && card.proposal.payload && card.proposal.payload.recipient) || '').replace(/\D/g, '');
    const last4 = digits.slice(-4);
    return 'SMS to ' + name + (last4 ? ' · ••• ' + last4 : '');
  }

  const CardUI = {
    /**
     * Open a Decision Card in a bottom sheet.
     * @param {Object} card a schema-v1.0 decision card (see decision-inbox.js)
     * @param {Object} [opts] { onApprove(result), onReject(), onClose() }
     * @returns {{opened:true, sheet}} | {{opened:false, reason}}
     */
    open(card, opts) {
      if (typeof document === 'undefined') return { opened: false, reason: 'no_dom' };
      const o = opts || {};
      const kit = global.AAA_UI;
      if (!kit || typeof kit.sheet !== 'function') return { opened: false, reason: 'no_ui_kit' };
      if (!card || !card.proposal || !card.proposal.metrics || !card.proposal.payload) return { opened: false, reason: 'no_card' };

      // `settled` stops the sheet's own close (X / backdrop / Escape) from
      // double-firing onReject after an explicit Approve/Reject was handled.
      let settled = false;
      const s = kit.sheet({
        title: 'Recommendation',
        onClose: function () {
          if (!settled) { settled = true; if (o.onReject) { try { o.onReject(); } catch (_) {} } }
          if (o.onClose) { try { o.onClose(); } catch (_) {} }
        }
      });

      const m = card.proposal.metrics;
      const wrap = document.createElement('div');
      wrap.className = 'dc-card';
      // AAA_UI.sheet already sets role="dialog"/aria-modal on its card.
      wrap.innerHTML =
        '<div class="dc-trigger">' + esc(triggerLine(card)) + '</div>' +
        '<div class="dc-ev">' + esc(fmtMoney(m.expectedValueUSD)) + '</div>' +
        '<div class="dc-ev-label">expected value if it closes</div>' +
        '<div class="dc-meta">' +
          '<span class="dc-conf-pill">' + esc(Math.round(num(m.confidenceScore) * 100)) + '% confidence</span>' +
        '</div>' +
        '<div class="dc-rationale">' + esc(m.rationale || '') + '</div>' +
        '<div class="dc-recipient">' + esc(maskedRecipient(card)) + '</div>';

      const approve = document.createElement('button');
      approve.type = 'button';
      approve.className = 'dc-btn dc-btn--approve';
      approve.textContent = 'Approve Send';
      const reject = document.createElement('button');
      reject.type = 'button';
      reject.className = 'dc-btn dc-btn--reject';
      reject.textContent = 'Reject';
      const status = document.createElement('div');
      status.className = 'dc-status';

      approve.onclick = async function () {
        if (approve.disabled) return;
        approve.disabled = true;
        approve.textContent = 'Sending…';
        let res;
        const inbox = global.AAA_DECISION_INBOX;
        if (inbox && typeof inbox.dispatch === 'function') {
          try { res = await inbox.dispatch(card, {}); } catch (e) { res = { ok: false, reason: String((e && e.message) || e) }; }
        } else {
          res = { ok: false, reason: 'NO_INBOX' };
        }
        if (o.onApprove) { try { o.onApprove(res); } catch (_) {} }
        if (res && res.ok) {
          status.className = 'dc-status dc-status--ok';
          status.textContent = '✓ Dry-run dispatched & logged (no message sent)';
          settled = true;
          s.close(); // sheet fade keeps the confirmation visible for a beat
        } else {
          // keep the sheet OPEN so the owner sees exactly why nothing happened
          status.className = 'dc-status dc-status--error';
          status.textContent = res && res.blocked
            ? 'Blocked by the safety gate — nothing was sent.'
            : 'Could not approve (' + esc((res && res.reason) || 'unknown') + ') — nothing was sent.';
          approve.disabled = false;
          approve.textContent = 'Approve Send';
        }
      };

      reject.onclick = function () {
        settled = true;
        s.close();
        if (o.onReject) { try { o.onReject(); } catch (_) {} }
      };

      const actions = document.createElement('div');
      actions.className = 'dc-actions';
      actions.appendChild(approve);
      actions.appendChild(reject);
      s.body.appendChild(wrap);
      s.body.appendChild(actions);
      s.body.appendChild(status);

      // THE LESSON: the caller must attach the overlay or the sheet is
      // invisible on a real phone while every Node suite stays green.
      document.body.appendChild(s.overlay);
      return { opened: true, sheet: s };
    }
  };

  global.AAA_DECISION_CARD = CardUI;
})(typeof window !== 'undefined' ? window : this);
