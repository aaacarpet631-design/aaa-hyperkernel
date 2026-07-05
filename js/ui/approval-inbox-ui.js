/*
 * AAA Approval Inbox UI — one screen where the OWNER unblocks the machine.
 *
 * Everything in this codebase that pauses for a human lands here:
 *   - Decision Envelopes with approval.status 'awaiting_approval' (agent,
 *     market, localized impact, confidence, WHY it paused, review verdicts),
 *   - Missions paused at approval gates (mission, phase, pending envelope).
 *
 * Actions are explicit and governed end-to-end:
 *   approve → RBAC OVERRIDE_AI_DECISION (owner-only by matrix) is checked
 *             HERE for honest UI, and checked AGAIN inside
 *             AAA_DECISION_ENVELOPE.approve (defense in depth) — which also
 *             refuses gate-denied envelopes and non-human approver identities.
 *   reject  → allowed for any role (a brake anyone can pull is safe).
 *   gate    → passing a mission gate calls AAA_MISSION_MANAGER.approvePhase,
 *             which re-verifies the envelope approval in the planning desk.
 *
 * Surfaces: open() presents the standard bottom sheet (command-center
 * pattern); mount(el) renders into a given element (tab pattern) or the
 * legacy #approval-inbox anchor. Rows carry real buttons wired through ONE
 * delegated listener → act(), so the testable dispatch path and the DOM
 * path are the same code. renderModel() stays pure/DOM-free; everything
 * rendered goes through esc(); every missing engine degrades honestly.
 */
;(function (global) {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]); }); }
  async function quiet(fn, d) { try { const r = await fn(); return r == null ? d : r; } catch (_) { return d; } }

  function env() { return global.AAA_DECISION_ENVELOPE; }
  function missions() { return global.AAA_MISSION_MANAGER; }
  function reviews() { return global.AAA_REVIEW_PROTOCOL; }
  function rbac() { return global.AAA_RBAC; }
  function uikit() { return global.AAA_UI; }

  function canApprove() {
    const r = rbac();
    return !r || !r.can ? true : !!r.can('OVERRIDE_AI_DECISION');
  }

  const InboxUI = {
    /**
     * Pure read model: everything paused, with enough context to decide.
     * { canApprove, envelopes:[…], gates:[…], counts:{envelopes, gates} }
     */
    renderModel: async function () {
      const model = { canApprove: canApprove(), envelopes: [], gates: [], counts: { envelopes: 0, gates: 0 } };

      const e = env();
      if (e && e.list) {
        const waiting = await quiet(function () { return e.list({ status: 'awaiting_approval' }); }, []);
        const rp = reviews();
        for (const rec of waiting) {
          const verdicts = rp && rp.list ? await quiet(function () { return rp.list({ artifactRef: rec.id }); }, []) : [];
          model.envelopes.push({
            envelopeId: rec.id, agent: rec.agent, country: rec.country,
            tenant: rec.workspaceId || 'default',
            recommendation: rec.decision.recommendation,
            confidence: rec.decision.confidence,
            impact: rec.impact && rec.impact.formatted ? rec.impact.formatted : null,
            pausedReasons: (rec.approval && rec.approval.reasons) || [],
            gateDecision: rec.gate && rec.gate.decision,
            reviews: verdicts.map(function (v) { return { decision: v.decision, severity: v.severity, defects: v.defects.length }; }),
            createdAt: rec.createdAt
          });
        }
        model.counts.envelopes = model.envelopes.length;
      }

      const mm = missions();
      if (mm && mm.list) {
        const paused = await quiet(function () { return mm.list({ status: 'awaiting_approval' }); }, []);
        for (const m of paused) {
          for (const p of (m.pendingApprovals || [])) {
            model.gates.push({
              missionId: m.id, mission: m.mission, tenant: m.workspaceId || 'default',
              phaseId: p.phaseId, envelopeId: p.envelopeId,
              risk: m.risk && m.risk.level, country: m.country,
              pausedSince: m.createdAt
            });
          }
        }
        model.counts.gates = model.gates.length;
      }
      return model;
    },

    /**
     * Owner approves an envelope. The UI check is a courtesy; the REAL guards
     * (RBAC, non-human approver, gate-deny) live in the envelope module.
     */
    approve: async function (envelopeId, opts) {
      if (!canApprove()) return { ok: false, error: 'FORBIDDEN', required: 'OVERRIDE_AI_DECISION' };
      const e = env();
      if (!e) return { ok: false, error: 'ENVELOPE_MODULE_MISSING' };
      return e.approve(envelopeId, { approver: (opts && opts.approver) || (rbac() && rbac().role ? 'owner:' + rbac().role() : 'owner') });
    },

    /** Reject with a reason — allowed for any role. */
    reject: async function (envelopeId, opts) {
      const e = env();
      if (!e) return { ok: false, error: 'ENVELOPE_MODULE_MISSING' };
      return e.reject(envelopeId, { approver: (opts && opts.approver) || 'owner', reason: (opts && opts.reason) || null });
    },

    /** Approve an envelope AND pass the mission gate it belongs to. */
    approveGate: async function (missionId, phaseId, envelopeId, opts) {
      if (!canApprove()) return { ok: false, error: 'FORBIDDEN', required: 'OVERRIDE_AI_DECISION' };
      const mm = missions();
      if (!mm) return { ok: false, error: 'MISSION_MANAGER_MISSING' };
      const ap = await this.approve(envelopeId, opts);
      if (!ap.ok && ap.error !== 'ALREADY_APPROVED') return ap;
      return mm.approvePhase(missionId, phaseId, envelopeId);
    },

    /**
     * One dispatch path for every surface (DOM clicks and tests alike).
     * act('approve'|'reject', {envelopeId}) / act('gate', {missionId, phaseId, envelopeId})
     */
    act: async function (action, refs) {
      const r = refs || {};
      if (action === 'approve') return this.approve(r.envelopeId);
      if (action === 'reject') return this.reject(r.envelopeId, { reason: r.reason || 'rejected from approval inbox' });
      if (action === 'gate') return this.approveGate(r.missionId, r.phaseId, r.envelopeId);
      return { ok: false, error: 'UNKNOWN_ACTION', action: action };
    },

    /** Static row markup (all dynamic values escaped). Buttons only when permitted. */
    envelopeRowHtml: function (row, opts) {
      const o = opts || {};
      const reviewsNote = (row.reviews || []).length
        ? (row.reviews || []).map(function (v) { return esc(v.decision) + (v.defects ? ' (' + v.defects + ' defects)' : ''); }).join(', ')
        : 'not yet reviewed';
      const btns =
        (o.canApprove ? '<button type="button" class="approval-btn approval-btn--approve" data-act="approve" data-envelope="' + esc(row.envelopeId) + '">Approve</button>' : '') +
        '<button type="button" class="approval-btn approval-btn--reject" data-act="reject" data-envelope="' + esc(row.envelopeId) + '">Reject</button>';
      return '<div class="approval-row" data-envelope="' + esc(row.envelopeId) + '">' +
        '<div class="approval-head"><strong>' + esc(row.agent) + '</strong>' +
        (row.country ? ' · ' + esc(row.country) : '') +
        (row.impact ? ' · ' + esc(row.impact) : '') +
        ' · conf ' + esc(row.confidence) + '</div>' +
        '<div class="approval-rec">' + esc(row.recommendation) + '</div>' +
        '<div class="approval-why">Paused: ' + esc((row.pausedReasons || []).join('; ') || 'awaiting review') + '</div>' +
        '<div class="approval-reviews">Reviews: ' + reviewsNote + '</div>' +
        '<div class="approval-actions">' + btns + '</div>' +
        '</div>';
    },

    gateRowHtml: function (g, opts) {
      const o = opts || {};
      const btn = o.canApprove
        ? '<button type="button" class="approval-btn approval-btn--approve" data-act="gate" data-mission="' + esc(g.missionId) + '" data-phase="' + esc(g.phaseId) + '" data-envelope="' + esc(g.envelopeId) + '">Approve gate</button>'
        : '';
      return '<div class="gate-row" data-mission="' + esc(g.missionId) + '" data-phase="' + esc(g.phaseId) + '">' +
        '<div class="approval-head"><strong>' + esc(g.mission) + '</strong> · phase ' + esc(g.phaseId) +
        (g.risk ? ' · risk ' + esc(g.risk) : '') + (g.country ? ' · ' + esc(g.country) : '') + '</div>' +
        '<div class="approval-actions">' + btn + '</div>' +
        '</div>';
    },

    /** Delegated click handler — thin DOM adapter over act(). */
    _onClick: async function (evTarget, host) {
      const btn = evTarget && evTarget.closest ? evTarget.closest('.approval-btn') : null;
      if (!btn || !btn.getAttribute) return null;
      const res = await this.act(btn.getAttribute('data-act'), {
        envelopeId: btn.getAttribute('data-envelope'),
        missionId: btn.getAttribute('data-mission'),
        phaseId: btn.getAttribute('data-phase')
      });
      if (host) {
        if (res && res.ok === false) {
          const note = (res.error === 'FORBIDDEN') ? 'Your role cannot approve (needs OVERRIDE_AI_DECISION).' : 'Action refused: ' + res.error;
          host.setAttribute && host.setAttribute('data-approval-note', note);
        }
        await this.mount(host); // re-render live state after any action
      }
      return res;
    },

    /**
     * Render into `el` (tab pattern), or the legacy #approval-inbox anchor.
     * Attaches ONE delegated listener per host (survives re-renders).
     */
    mount: async function (el) {
      if (typeof document === 'undefined' || !document.getElementById) return { ok: false, error: 'NO_DOM' };
      const host = el || document.getElementById('approval-inbox');
      if (!host) return { ok: false, error: 'NO_ANCHOR' };
      const model = await this.renderModel();
      const opts = { canApprove: model.canApprove };
      const self = this;
      const rows = model.envelopes.map(function (r) { return self.envelopeRowHtml(r, opts); }).join('');
      const gates = model.gates.map(function (g) { return self.gateRowHtml(g, opts); }).join('');
      const note = host.getAttribute && host.getAttribute('data-approval-note');
      host.innerHTML =
        '<div class="approval-inbox">' +
        '<h2 class="approval-title">Approvals (' + (model.counts.envelopes + model.counts.gates) + ')</h2>' +
        (model.canApprove ? '' : '<p class="approval-readonly">Read-only: your role cannot approve (needs OVERRIDE_AI_DECISION). You can still reject.</p>') +
        (note ? '<p class="approval-note">' + esc(note) + '</p>' : '') +
        (rows || gates ? rows + gates : '<p class="approval-empty">Nothing is waiting on you.</p>') +
        '</div>';
      if (host.removeAttribute) host.removeAttribute('data-approval-note');
      if (host.addEventListener && !host._approvalWired) {
        host._approvalWired = true;
        host.addEventListener('click', function (ev) { self._onClick(ev && ev.target, host); });
      }
      return { ok: true, counts: model.counts };
    },

    /** Command-center surface: the standard bottom sheet. */
    open: function () {
      const ui = uikit();
      if (typeof document === 'undefined' || !ui || !ui.sheet) return { ok: false, error: 'NO_DOM' };
      const s = ui.sheet({ title: 'Approvals', subtitle: 'Decisions paused for a human' });
      document.body.appendChild(s.overlay);
      this.mount(s.body);
      return { ok: true, close: s.close };
    }
  };

  global.AAA_APPROVAL_INBOX_UI = InboxUI;
})(typeof window !== 'undefined' ? window : this);
