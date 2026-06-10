/*
 * AAA Decision Bundle — the "Approve All" sheet for a homogeneous bundle of
 * Decision Cards (Stage 2 compression of the Decision Inbox).
 *
 * Renders a bundle from AAA_DECISION_INBOX.listBundles() into an AAA_UI bottom
 * sheet: a hero line ("{count} actions · +$X potential · NN% avg confidence"),
 * a compact, scannable member list (customer · $EV · NN% — NO phone number,
 * full or masked, ever reaches this DOM), one big "Approve All (N)" primary
 * button and a Cancel ghost. Approve All calls
 * AAA_DECISION_INBOX.approveBundle, which dispatches EVERY member through the
 * existing dry-run governed dispatch(): gate → 'decision.approved' event →
 * audit record → dispatched:false. N approvals = N audit entries, ZERO
 * messages sent — this module has no transport path at all.
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

  /** Member facts for the scannable list — name + money + confidence ONLY. */
  function memberFacts(card) {
    const name = (card && card.trigger && card.trigger.payload && card.trigger.payload.customerName) || 'Customer';
    const m = (card && card.proposal && card.proposal.metrics) || {};
    return { name: name, ev: num(m.expectedValueUSD), pct: Math.round(num(m.confidenceScore) * 100) };
  }

  const BundleUI = {
    /**
     * Open a Decision Bundle in a bottom sheet.
     * @param {Object} bundle a listBundles() bundle ({ label, decisions, ... })
     * @param {Object} [opts] { onApprove(result), onReject(), onClose() }
     * @returns {{opened:true, sheet, approveAll}} | {{opened:false, reason}}
     *   `approveAll` is the Approve-All handler, exposed for tests.
     */
    open(bundle, opts) {
      if (typeof document === 'undefined') return { opened: false, reason: 'no_dom' };
      const o = opts || {};
      const kit = global.AAA_UI;
      if (!kit || typeof kit.sheet !== 'function') return { opened: false, reason: 'no_ui_kit' };
      if (!bundle || !Array.isArray(bundle.decisions) || bundle.decisions.length === 0) return { opened: false, reason: 'no_bundle' };

      // `settled` stops the sheet's own close (X / backdrop / Escape) from
      // double-firing onReject after an explicit Approve/Cancel was handled.
      let settled = false;
      const s = kit.sheet({
        title: bundle.label || 'Decision Bundle',
        onClose: function () {
          if (!settled) { settled = true; if (o.onReject) { try { o.onReject(); } catch (_) {} } }
          if (o.onClose) { try { o.onClose(); } catch (_) {} }
        }
      });

      const members = bundle.decisions;
      const count = members.length;
      const total = bundle.totalImpactUSD != null ? num(bundle.totalImpactUSD)
        : members.reduce(function (sum, c) { return sum + memberFacts(c).ev; }, 0);
      const avgPct = bundle.avgConfidencePct != null ? Math.round(num(bundle.avgConfidencePct))
        : Math.round(members.reduce(function (sum, c) { return sum + memberFacts(c).pct; }, 0) / count);

      const wrap = document.createElement('div');
      wrap.className = 'db-bundle';
      wrap.innerHTML =
        '<div class="db-hero">' +
          '<span class="db-hero__count">' + esc(count) + ' actions</span>' +
          '<span class="db-hero__sep"> · </span>' +
          '<span class="db-hero__total">+' + esc(fmtMoney(total)) + ' potential</span>' +
          '<span class="db-hero__sep"> · </span>' +
          '<span class="db-hero__conf">' + esc(avgPct) + '% avg confidence</span>' +
        '</div>' +
        '<div class="db-members">' + members.map(function (card) {
          const f = memberFacts(card);
          return '<div class="db-member">' +
            '<span class="db-member__who">' + esc(f.name) + '</span>' +
            '<span class="db-member__facts">' + esc(fmtMoney(f.ev)) + ' · ' + esc(f.pct) + '%</span>' +
            '</div>';
        }).join('') + '</div>';

      const approve = document.createElement('button');
      approve.type = 'button';
      approve.className = 'db-btn db-btn--approve';
      approve.textContent = 'Approve All (' + count + ')';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'db-btn db-btn--cancel';
      cancel.textContent = 'Cancel';
      const status = document.createElement('div');
      status.className = 'db-status';

      // Approve All — N dry-run governed approvals through approveBundle();
      // nothing is ever sent (dispatched:false on every member by design).
      async function approveAll() {
        if (approve.disabled) return;
        approve.disabled = true;
        approve.textContent = 'Approving…';
        let res;
        const inbox = global.AAA_DECISION_INBOX;
        if (inbox && typeof inbox.approveBundle === 'function') {
          try { res = await inbox.approveBundle(bundle, {}); } catch (e) { res = { ok: false, reason: String((e && e.message) || e) }; }
        } else {
          res = { ok: false, reason: 'NO_INBOX' };
        }
        if (o.onApprove) { try { o.onApprove(res); } catch (_) {} }
        if (res && res.ok) {
          status.className = 'db-status db-status--ok';
          status.textContent = '✓ ' + num(res.approved) + ' dry-run approvals logged · ' + num(res.blocked) + ' blocked · nothing sent';
          settled = true;
          s.close(); // sheet fade keeps the confirmation visible for a beat
        } else {
          // keep the sheet OPEN so the owner sees exactly why nothing happened
          status.className = 'db-status db-status--error';
          status.textContent = 'Could not approve (' + esc((res && res.reason) || 'unknown') + ') — nothing was sent.';
          approve.disabled = false;
          approve.textContent = 'Approve All (' + count + ')';
        }
      }
      approve.onclick = approveAll;

      cancel.onclick = function () {
        settled = true;
        s.close();
        if (o.onReject) { try { o.onReject(); } catch (_) {} }
      };

      const actions = document.createElement('div');
      actions.className = 'db-actions';
      actions.appendChild(approve);
      actions.appendChild(cancel);
      s.body.appendChild(wrap);
      s.body.appendChild(actions);
      s.body.appendChild(status);

      // THE LESSON: the caller must attach the overlay or the sheet is
      // invisible on a real phone while every Node suite stays green.
      document.body.appendChild(s.overlay);
      return { opened: true, sheet: s, approveAll: approveAll };
    }
  };

  global.AAA_DECISION_BUNDLE = BundleUI;
})(typeof window !== 'undefined' ? window : this);
