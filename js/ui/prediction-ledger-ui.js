/*
 * AAA Prediction Ledger — every prediction, scored against reality.
 *
 * The directive: "Every recommendation receives a prediction ID. Store the
 * prediction, confidence, rationale. When outcomes arrive, measure correctness
 * and re-score all contributors." The machinery already does this — agents log
 * decisions (with confidence + rationale), the Supervisor scores them against
 * real won/lost outcomes (Brier calibration). This view makes that ledger
 * legible: each prediction joined to its actual outcome, what we predicted vs.
 * what happened, who made the call, and whether it has resolved yet.
 *
 * Read-only over REAL shared memory (agent_decisions ⋈ outcomes). Nothing is
 * fabricated: unresolved predictions are shown as "pending", and with too
 * little data the summary says so. Confidence is treated as P(win), consistent
 * with how the Supervisor calibrates it.
 *
 * Opened from the Command Center. Uses the shared AAA_UI kit.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function data() { return global.AAA_DATA; }
  function reg() { return global.AAA_AGENTS; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtDate(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function pct(n) { return n == null ? '—' : Math.round(n * 100) + '%'; }
  function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
  function title(id) { const a = reg() && reg().get ? reg().get(id) : null; return (a && a.title) || id; }

  // Join decisions to their outcome and bucket by contributor.
  async function build() {
    const decisions = (await data().list('agent_decisions')).slice();
    const outcomes = await data().list('outcomes');
    const byJob = {}; const byId = {};
    outcomes.forEach((o) => { if (o.jobId) byJob[o.jobId] = o; byId[o.id] = o; });

    const rows = decisions.map((d) => {
      const o = (d.outcomeId && byId[d.outcomeId]) || (d.jobId && byJob[d.jobId]) || null;
      const resolved = !!(o && (o.result === 'won' || o.result === 'lost'));
      const won = resolved ? (o.result === 'won') : null;
      const predictedWin = d.confidence != null ? d.confidence >= 50 : null;
      const hit = resolved && predictedWin != null ? (predictedWin === won) : null;
      return {
        id: d.id, agent: d.agent || 'unknown', recommendation: d.decision || d.recommendation || '',
        confidence: d.confidence != null ? d.confidence : null,
        score: typeof d.score === 'number' ? d.score : null,   // Supervisor calibration
        createdAt: d.createdAt, jobId: d.jobId || null,
        via: d.via || null, resolved: resolved, won: won, hit: hit,
        finalAmount: o && typeof o.finalAmount === 'number' ? o.finalAmount : null,
        result: o ? o.result : null
      };
    }).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    const per = {};
    rows.forEach((r) => {
      const p = per[r.agent] || (per[r.agent] = { agent: r.agent, total: 0, resolved: 0, won: 0, hits: 0, confs: [], scores: [] });
      p.total++;
      if (r.confidence != null) p.confs.push(r.confidence);
      if (r.score != null) p.scores.push(r.score);
      if (r.resolved) { p.resolved++; if (r.won) p.won++; if (r.hit) p.hits++; }
    });
    const contributors = Object.keys(per).map((k) => {
      const p = per[k];
      return {
        agent: k, total: p.total, resolved: p.resolved,
        winRate: p.resolved ? p.won / p.resolved : null,
        hitRate: p.resolved ? p.hits / p.resolved : null,
        avgConfidence: p.confs.length ? mean(p.confs) : null,
        avgCalibration: p.scores.length ? mean(p.scores) : null
      };
    }).sort((a, b) => b.total - a.total);

    const resolvedRows = rows.filter((r) => r.resolved);
    return {
      rows: rows, contributors: contributors,
      summary: {
        total: rows.length, resolved: resolvedRows.length, pending: rows.length - resolvedRows.length,
        closeRate: resolvedRows.length ? resolvedRows.filter((r) => r.won).length / resolvedRows.length : null,
        hitRate: resolvedRows.length ? resolvedRows.filter((r) => r.hit).length / resolvedRows.length : null,
        avgCalibration: (() => { const s = rows.map((r) => r.score).filter((n) => n != null); return s.length ? mean(s) : null; })()
      }
    };
  }

  function st(t) { return U().el('h2', { className: 'aaa-section-title', text: t }); }
  function note(t) { return U().el('p', { className: 'aaa-empty', text: t }); }
  function kv(k, v, color) {
    return U().el('div', { className: 'vision-row' }, [
      U().el('span', { className: 'vision-row__k', text: k }),
      U().el('span', { className: 'vision-row__v', text: v, style: color ? { color: color } : null })
    ]);
  }

  // Status pill for a prediction row.
  function statusBadge(r) {
    const ui = U();
    if (!r.resolved) return ui.statusBadge('pending', '#A1A1AA');
    const won = r.won;
    const label = (won ? 'WON' : 'LOST') + (r.hit === true ? ' ✓' : r.hit === false ? ' ✗' : '');
    return ui.statusBadge(label, r.hit === true ? '#10B981' : r.hit === false ? '#EF4444' : (won ? '#10B981' : '#EF4444'));
  }

  async function renderInto(body, filterAgent) {
    const ui = U();
    body.innerHTML = '';
    body.appendChild(ui.spinner('Joining predictions to outcomes…'));
    const { rows, contributors, summary } = await build();
    body.innerHTML = '';

    if (!rows.length) {
      body.appendChild(note('No predictions yet. Agents log a prediction every time they make a call (with a confidence); once you record won/lost outcomes, this ledger scores them.'));
      return;
    }

    // ---- Summary ----
    body.appendChild(st('Prediction Ledger'));
    body.appendChild(kv('Predictions', String(summary.total)));
    body.appendChild(kv('Resolved', String(summary.resolved), summary.resolved ? '#10B981' : '#A1A1AA'));
    body.appendChild(kv('Pending', String(summary.pending), '#A1A1AA'));
    if (summary.resolved >= 3) {
      body.appendChild(kv('Close rate', pct(summary.closeRate)));
      body.appendChild(kv('Direction hit rate', pct(summary.hitRate)));
      body.appendChild(kv('Calibration (Brier)', pct(summary.avgCalibration)));
    } else {
      body.appendChild(note('Scored metrics unlock after 3+ resolved outcomes. So far: ' + summary.resolved + ' resolved.'));
    }

    // ---- By contributor ----
    body.appendChild(st('By contributor'));
    contributors.forEach((c) => {
      body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
        '<strong>' + esc(title(c.agent)) + '</strong>' +
        '<div class="aaa-list-sub">' + c.total + ' predictions · ' + c.resolved + ' resolved · win ' + pct(c.winRate) +
        ' · hit ' + pct(c.hitRate) + '</div>' +
        '<div class="aaa-list-sub">avg confidence ' + (c.avgConfidence != null ? Math.round(c.avgConfidence) + '%' : '—') +
        ' · calibration ' + pct(c.avgCalibration) + '</div>' }));
    });

    // ---- Filter ----
    body.appendChild(st('Ledger'));
    const sel = ui.el('select', { className: 'aaa-input' });
    sel.appendChild(ui.el('option', { text: 'All contributors (' + rows.length + ')', attrs: { value: '' } }));
    contributors.forEach((c) => {
      const opt = ui.el('option', { text: title(c.agent) + ' (' + c.total + ')', attrs: { value: c.agent } });
      if (c.agent === filterAgent) opt.setAttribute('selected', 'selected');
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => renderInto(body, sel.value || null));
    body.appendChild(ui.el('div', { className: 'aaa-form' }, [sel]));

    // ---- The ledger ----
    const list = filterAgent ? rows.filter((r) => r.agent === filterAgent) : rows;
    list.slice(0, 100).forEach((r) => {
      const row = ui.el('div', { className: 'aaa-list-row' });
      row.innerHTML = '<strong>' + esc(String(r.recommendation).slice(0, 120)) + (String(r.recommendation).length > 120 ? '…' : '') + '</strong>';
      row.appendChild(statusBadge(r));
      row.appendChild(ui.el('div', { className: 'aaa-list-sub', html:
        esc(title(r.agent)) + (r.via ? ' · ' + esc(r.via) : '') +
        ' · confidence ' + (r.confidence != null ? r.confidence + '%' : '—') +
        (r.score != null ? ' · calibration ' + pct(r.score) : '') +
        (r.finalAmount != null ? ' · $' + Math.round(r.finalAmount) : '') }));
      row.appendChild(ui.el('div', { className: 'aaa-list-sub', text: fmtDate(r.createdAt) }));
      body.appendChild(row);
    });
    if (list.length > 100) body.appendChild(note('Showing the 100 most recent of ' + list.length + ' predictions.'));
  }

  async function open() {
    const ui = U();
    const s = ui.sheet({ title: 'Prediction Ledger', subtitle: 'What we predicted vs. what happened' });
    document.body.appendChild(s.overlay);
    await renderInto(s.body, null);
  }

  global.AAA_PREDICTION_LEDGER_UI = { open: open, render: renderInto, build: build };
})(typeof window !== 'undefined' ? window : this);
