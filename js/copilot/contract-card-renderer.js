/*
 * AAA Contract Card Renderer — contract-v1 copilot responses as safe,
 * mobile-first HTML (mission Slice E).
 *
 * Pure: a validated ResponseEnvelope in, an HTML string out. Renders the six
 * contract card types plus the envelope's evidence chips, unknowns, approval
 * banner, and degraded notice. Everything user- or record-derived passes
 * through esc() — a hostile string in a packet can never become markup.
 * Renders only what the model contains: no invented rows, unknowns shown
 * honestly, and a draft card always carries its "draft only" banner.
 *
 * Attention lists render worst-first (urgent > warn > info, unknown severity
 * last, stable within a rank) under a derived "N item(s) - M urgent" summary
 * line. When approval.approvalPackage.actionType is present the approval
 * banner names the action and emits
 * <button class="cc-open-approvals" data-action-type="...">. The renderer
 * stays PURE — it attaches no handlers; the canvas/UI layer binds clicks by
 * the cc-open-approvals class.
 */
;(function (global) {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]); }); }
  function refChip(ref) { return ref ? '<span class="cc-ref">' + esc(ref.collection) + ':' + esc(ref.id) + '</span>' : ''; }

  const SEVERITY_ICON = { urgent: '🔴', warn: '🟡', info: 'ℹ️' };
  const SEVERITY_RANK = { urgent: 0, warn: 1, info: 2 }; // unknown severities sort last
  const RISK_LABEL = { underpriced: '⚠ Underpriced', at_risk: '⚠ At risk', healthy: '✅ Healthy', unknown: '❔ Unknown' };

  function attentionList(card) {
    const items = Array.isArray(card.items) ? card.items : [];
    // Worst first: urgent > warn > info > unknown; index tie-break keeps the
    // sort stable within a rank regardless of engine.
    const sorted = items.map(function (it, i) { return { it: it, i: i }; }).sort(function (a, b) {
      const ra = a.it && SEVERITY_RANK[a.it.severity] != null ? SEVERITY_RANK[a.it.severity] : 3;
      const rb = b.it && SEVERITY_RANK[b.it.severity] != null ? SEVERITY_RANK[b.it.severity] : 3;
      return ra !== rb ? ra - rb : a.i - b.i;
    }).map(function (x) { return x.it; });
    const urgent = items.filter(function (it) { return it && it.severity === 'urgent'; }).length;
    return '<p class="cc-attn-summary">' + items.length + ' item(s) - ' + urgent + ' urgent</p>' +
      '<ul class="cc-list">' + sorted.map(function (it) {
        const x = it || {};
        return '<li>' + (SEVERITY_ICON[x.severity] || '') + ' <strong>' + esc(x.label) + '</strong> — ' + esc(x.why) + ' ' + refChip(x.sourceRef) + '</li>';
      }).join('') + '</ul>';
  }
  function followupList(card) {
    return '<ul class="cc-list">' + (card.items || []).map(function (it) {
      return '<li>' + esc(it.reason) + (it.suggestedChannel ? ' <em>(' + esc(it.suggestedChannel) + ')</em>' : '') + ' ' + refChip(it.sourceRef) + '</li>';
    }).join('') + '</ul>';
  }
  function estimateRisk(card) {
    const factors = (card.factors || []).map(function (f) {
      return '<li>' + esc(f.note) + ' ' + refChip(f.sourceRef) + '</li>';
    }).join('');
    return '<p class="cc-risk cc-risk--' + esc(card.risk) + '">' + (RISK_LABEL[card.risk] || esc(card.risk)) + ' ' + refChip(card.quoteRef) + '</p>' +
      (factors ? '<ul class="cc-list">' + factors + '</ul>' : '');
  }
  function agentActivity(card) {
    return '<ul class="cc-list">' + (card.items || []).map(function (it) {
      return '<li><strong>' + esc(it.agent) + '</strong> — ' + esc(it.action) + (it.status ? ' <em>[' + esc(it.status) + ']</em>' : '') + ' ' + refChip(it.sourceRef) + '</li>';
    }).join('') + '</ul>';
  }
  function draftMessage(card) {
    return '<div class="cc-draft"><p class="cc-draft-banner">✋ Draft only — sending requires your approval (' + esc(card.approvalActionType) + ').</p>' +
      '<p class="cc-draft-channel">' + esc(card.channel) + ' → ' + refChip(card.customerRef) + '</p>' +
      '<pre class="cc-draft-body">' + esc(card.body) + '</pre></div>';
  }
  function textCard(card) { return '<p>' + esc(card.body) + '</p>'; }

  const RENDERERS = {
    attention_list: attentionList,
    followup_list: followupList,
    estimate_risk: estimateRisk,
    agent_activity: agentActivity,
    draft_message: draftMessage,
    text: textCard
  };

  const Renderer = {
    /** One card model → HTML ('' for an unknown/absent card, never a throw). */
    renderCard(card) {
      if (!card || !RENDERERS[card.cardType]) return '';
      return '<div class="cc-card cc-card--' + esc(card.cardType) + '">' + RENDERERS[card.cardType](card) + '</div>';
    },

    /** A full validated ResponseEnvelope → HTML. */
    render(response) {
      const r = response || {};
      const parts = [];
      parts.push('<p class="cc-answer">' + esc(r.answer) + '</p>');
      (Array.isArray(r.cards) ? r.cards : []).forEach(function (c) { parts.push(Renderer.renderCard(c)); });
      const unknowns = Array.isArray(r.unknowns) ? r.unknowns : [];
      if (unknowns.length) {
        parts.push('<ul class="cc-unknowns">' + unknowns.map(function (u) { return '<li>❔ ' + esc(u) + '</li>'; }).join('') + '</ul>');
      }
      const evidence = Array.isArray(r.evidence) ? r.evidence : [];
      if (evidence.length) {
        parts.push('<div class="cc-evidence">Evidence: ' + evidence.map(function (e) {
          return (e.sourceRefs || []).map(refChip).join(' ');
        }).join(' ') + '</div>');
      }
      if (r.approval && r.approval.required) {
        const pkg = r.approval.approvalPackage;
        const actionType = pkg && pkg.actionType ? String(pkg.actionType) : null;
        parts.push('<div class="cc-approval">🔒 ' + esc((r.approval.reasons || []).join(' ') || 'This needs your approval.') +
          (actionType
            ? ' <span class="cc-approval-action">' + esc(actionType) + '</span> <button class="cc-open-approvals" data-action-type="' + esc(actionType) + '">Review in Approval Inbox</button>'
            : '') +
          '</div>');
      }
      if (r.degraded) {
        parts.push('<div class="cc-degraded">⚠ Degraded: ' + esc(r.degraded.reason) + (r.degraded.fallback ? ' (fallback: ' + esc(r.degraded.fallback) + ')' : '') + '</div>');
      }
      if (r.confidence != null) parts.push('<div class="cc-confidence">Confidence: ' + esc(String(Math.round(r.confidence))) + '/100</div>');
      return '<div class="cc-response">' + parts.join('') + '</div>';
    }
  };

  global.AAA_CONTRACT_CARD_RENDERER = Renderer;
})(typeof window !== 'undefined' ? window : this);
