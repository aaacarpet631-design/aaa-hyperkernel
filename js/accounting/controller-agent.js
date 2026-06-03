/*
 * AAA Controller Agent — the financial analyst in the money loop.
 *
 * This is the AI advisory for the books, wired in the ONE safe way: it READS
 * everything and RECOMMENDS, but it has no write path at all. There is no call
 * to AAA_DATA.put, no call to AAA_ACCOUNTING mutators, and no gateway.run() with
 * a mutate function anywhere in this module. By construction it cannot change a
 * single number in the books — it can only surface findings for a person to act
 * on. Every official accounting action stays human-gated and audited in the
 * Runtime Gateway; the Controller merely names the gateway action a human would
 * take (recommendation.gatewayAction) so the UI can route the human there.
 *
 * It reads the real spine:
 *   - AAA_ACCOUNTING        invoices / expenses / payments / summary / jobCosting
 *   - AAA_RECEIPT_INTAKE    the receipt review queue + posted-receipt linkage
 *   - AAA_EXPENSE_CLASSIFIER classification accuracy
 *   - AAA_DATA.listJobs()   job context for per-job costing
 *
 * Honest by construction: thresholds are explicit, every finding cites the real
 * numbers behind it, and when there isn't enough data to judge (e.g. no trailing
 * activity for a cash-flow runway) it says so instead of inventing a figure.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function acct() { return global.AAA_ACCOUNTING; }
  function intake() { return global.AAA_RECEIPT_INTAKE; }
  function classifier() { return global.AAA_EXPENSE_CLASSIFIER; }
  function data() { return global.AAA_DATA; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function round(n) { return Math.round(n * 100) / 100; }

  // Tunable thresholds. Overridable via AAA_CONFIG flags so the owner can set
  // their own floors without a code change. Defaults are conservative.
  function T() {
    const f = (k, d) => (cfg().flag ? cfg().flag(k, d) : d);
    return {
      marginFloorPct: num(f('ctrlMarginFloorPct', 25)),     // healthy company margin
      marginCriticalPct: num(f('ctrlMarginCriticalPct', 10)),
      arAgingDays: num(f('ctrlArAgingDays', 30)),           // unpaid invoice older than this
      largeExpense: num(f('ctrlLargeExpense', 1000)),       // single expense needing a receipt
      receiptBacklog: num(f('ctrlReceiptBacklog', 10)),     // queued receipts before we warn
      trailingDays: num(f('ctrlTrailingDays', 30))          // window for run-rate math
    };
  }

  const SEV = { INFO: 'info', WARNING: 'warning', CRITICAL: 'critical' };
  const SEV_WEIGHT = { info: 0, warning: 8, critical: 20 };

  let _seq = 0;
  function finding(area, severity, title, detail, metrics, recommendation, gatewayAction) {
    return {
      id: 'find_' + (++_seq), area: area, severity: severity, title: title,
      detail: detail, metrics: metrics || {}, recommendation: recommendation || null,
      // The gateway action a HUMAN must take to act on this. The Controller never
      // calls it; it only points at it. (Each is human-only + audited in the gateway.)
      gatewayAction: gatewayAction || null
    };
  }

  const Controller = {
    SEVERITY: SEV,

    /**
     * Read-only financial analysis. Returns structured health + findings.
     * Performs ZERO writes. Safe to call as often as the dashboard likes.
     */
    async analyze() {
      _seq = 0;
      const A = acct();
      if (!A) return { ok: false, error: 'NO_ACCOUNTING' };

      const [invoices, expenses, payments, summary] = await Promise.all([
        A.listInvoices(), A.listExpenses(), A.listPayments(), A.summary()
      ]);
      let jobs = [];
      try { jobs = await data().listJobs(); } catch (_) { jobs = []; }
      const receiptStats = intake() ? await intake().stats() : null;
      const receiptList = intake() ? await intake().list() : [];
      const accuracy = classifier() ? await classifier().accuracy() : null;
      const th = T();

      // Expenses that came from a reviewed receipt (documented for audit/tax).
      const receiptBacked = new Set(
        receiptList.filter((r) => r.status === 'posted' && r.expenseId).map((r) => r.expenseId)
      );

      const findings = [];
      const health = this._health(summary);

      // --- Risk: margin + profitability ---
      if (summary.profit < 0) {
        findings.push(finding('risk', SEV.CRITICAL, 'Operating at a loss',
          'Collected $' + summary.collected + ' against $' + summary.expensed + ' in expenses — net profit is negative.',
          { profit: summary.profit, collected: summary.collected, expensed: summary.expensed },
          'Review pricing floors and cut or defer non-essential spend; confirm all completed work is invoiced and collected.'));
      } else if (summary.marginPct != null && summary.marginPct < th.marginCriticalPct) {
        findings.push(finding('risk', SEV.CRITICAL, 'Margin critically low',
          'Net margin is ' + summary.marginPct + '%, below the ' + th.marginCriticalPct + '% critical floor.',
          { marginPct: summary.marginPct, floor: th.marginCriticalPct },
          'Raise pricing or reduce job costs; investigate the lowest-margin jobs below.'));
      } else if (summary.marginPct != null && summary.marginPct < th.marginFloorPct) {
        findings.push(finding('risk', SEV.WARNING, 'Margin below target',
          'Net margin is ' + summary.marginPct + '%, under the ' + th.marginFloorPct + '% target.',
          { marginPct: summary.marginPct, target: th.marginFloorPct },
          'Tighten estimates and material costs on upcoming jobs to restore margin.'));
      }

      // --- Risk: accounts receivable aging ---
      const aged = this._agedReceivables(invoices, payments, th.arAgingDays);
      if (aged.items.length) {
        findings.push(finding('risk', aged.total > summary.collected ? SEV.CRITICAL : SEV.WARNING,
          aged.items.length + ' invoice(s) overdue (> ' + th.arAgingDays + ' days)',
          '$' + round(aged.total) + ' billed and unpaid past ' + th.arAgingDays + ' days. The oldest is ' + aged.oldestDays + ' days out.',
          { count: aged.items.length, total: round(aged.total), oldestDays: aged.oldestDays },
          'Follow up to collect; when paid, a person records it.',
          'APPROVE_PAYMENT'));
      }

      // --- Cash flow ---
      const cashflow = this._cashflow(payments, expenses, summary, th);
      if (cashflow.warning) {
        findings.push(finding('cashflow', cashflow.severity, cashflow.warning.title, cashflow.warning.detail,
          { monthlyInflow: cashflow.monthlyInflow, monthlyOutflow: cashflow.monthlyOutflow, runwayMonths: cashflow.runwayMonths },
          cashflow.warning.recommendation));
      }

      // --- Job costing signals ---
      const jobCosting = await this._jobCosting(jobs, invoices, expenses, payments);
      jobCosting.forEach((j) => {
        if (j.flags.indexOf('LOSS') !== -1) {
          findings.push(finding('jobcost', SEV.CRITICAL, 'Job losing money: ' + j.name,
            'Costs ($' + j.cost + ') exceed collected revenue ($' + j.revenue + ') on this job.',
            { jobId: j.jobId, cost: j.cost, revenue: j.revenue, profit: j.profit },
            'Confirm the job is fully invoiced and the estimate covered actual material/labor.'));
        }
        if (j.flags.indexOf('UNBILLED') !== -1) {
          findings.push(finding('jobcost', SEV.WARNING, 'Unbilled costs: ' + j.name,
            '$' + j.cost + ' in costs are tagged to this job but nothing has been invoiced.',
            { jobId: j.jobId, cost: j.cost, billed: j.billed },
            'Create and send an invoice for the work done.',
            'FINALIZE_PRICE'));
        }
      });

      // --- Tax / categorization ---
      const tax = this._taxIssues(expenses, receiptBacked, th);
      tax.forEach((t) => findings.push(t));

      // --- Receipt pipeline (the intake spine) ---
      if (receiptStats) {
        if (receiptStats.queueDepth >= th.receiptBacklog) {
          findings.push(finding('receipts', SEV.WARNING, 'Receipt backlog',
            receiptStats.queueDepth + ' receipts are waiting for review (needs-review ' + receiptStats.needsReview + ', ready ' + receiptStats.ready + ', duplicates ' + receiptStats.duplicates + ').',
            { queueDepth: receiptStats.queueDepth, needsReview: receiptStats.needsReview },
            'Work the Receipts queue so expenses post to the books promptly.',
            'REVIEW_RECEIPTS'));
        }
        if (receiptStats.duplicates > 0) {
          findings.push(finding('receipts', SEV.INFO, receiptStats.duplicates + ' possible duplicate receipt(s)',
            'Flagged as already-seen (same vendor + date + total). They will not post without an explicit override.',
            { duplicates: receiptStats.duplicates },
            'Review and reject true duplicates so they do not double-count expenses.'));
        }
      }

      // Health score is reduced by the weight of open findings.
      const score = this._score(health, findings);

      return {
        ok: true, generatedAt: nowISO(), score: score,
        health: health, cashflow: cashflow, jobCosting: jobCosting,
        receipts: receiptStats ? {
          queueDepth: receiptStats.queueDepth, needsReview: receiptStats.needsReview,
          duplicates: receiptStats.duplicates, posted: receiptStats.posted,
          classifierAccuracyPct: accuracy ? accuracy.accuracyPct : null
        } : null,
        findings: findings,
        counts: bySeverity(findings)
      };
    },

    // ---- internals (all pure / read-only) -------------------------------
    _health(s) {
      const collectionRate = s.billed > 0 ? Math.round((s.collected / s.billed) * 100) : null;
      return {
        billed: s.billed, collected: s.collected, expensed: s.expensed,
        outstanding: s.outstanding, profit: s.profit, marginPct: s.marginPct,
        collectionRatePct: collectionRate
      };
    },

    _agedReceivables(invoices, payments, agingDays) {
      const now = nowMs();
      const cutoff = agingDays * 86400000;
      const paidByInvoice = {};
      payments.forEach((p) => { if (p.invoiceId) paidByInvoice[p.invoiceId] = (paidByInvoice[p.invoiceId] || 0) + num(p.amount); });
      const items = []; let total = 0; let oldestDays = 0;
      invoices.forEach((inv) => {
        if (inv.status === 'paid' || inv.status === 'void') return;
        const outstanding = round(num(inv.amount) - (paidByInvoice[inv.id] || 0));
        if (outstanding <= 0) return;
        const issued = Date.parse(inv.issuedAt || inv.createdAt || '');
        const ageMs = isFinite(issued) ? now - issued : 0;
        if (ageMs >= cutoff) {
          const days = Math.floor(ageMs / 86400000);
          items.push({ id: inv.id, outstanding: outstanding, days: days, customerName: inv.customerName });
          total += outstanding;
          if (days > oldestDays) oldestDays = days;
        }
      });
      return { items: items, total: total, oldestDays: oldestDays };
    },

    _cashflow(payments, expenses, summary, th) {
      const now = nowMs();
      const windowMs = th.trailingDays * 86400000;
      const inWindow = (d) => { const t = Date.parse(d || ''); return isFinite(t) && (now - t) <= windowMs && (now - t) >= 0; };
      const trailingInflow = round(payments.filter((p) => inWindow(p.receivedAt)).reduce((s, p) => s + num(p.amount), 0));
      const trailingOutflow = round(expenses.filter((e) => inWindow(e.incurredAt)).reduce((s, e) => s + num(e.amount), 0));
      // Project to a monthly run-rate from the trailing window.
      const factor = 30 / th.trailingDays;
      const monthlyInflow = round(trailingInflow * factor);
      const monthlyOutflow = round(trailingOutflow * factor);
      const netPosition = round(summary.collected - summary.expensed); // cash generated to date (proxy)
      const hasActivity = (trailingInflow > 0 || trailingOutflow > 0);
      let runwayMonths = null, warning = null, severity = SEV.INFO;
      if (!hasActivity) {
        // Honest: not enough recent activity to project cash flow.
        return { trailingInflow: trailingInflow, trailingOutflow: trailingOutflow, netPosition: netPosition, monthlyInflow: monthlyInflow, monthlyOutflow: monthlyOutflow, runwayMonths: null, warning: null, severity: SEV.INFO, dataSufficient: false };
      }
      const burn = round(monthlyOutflow - monthlyInflow); // positive = spending faster than collecting
      if (burn > 0) {
        runwayMonths = netPosition > 0 ? round(netPosition / burn) : 0;
        severity = runwayMonths != null && runwayMonths < 1 ? SEV.CRITICAL : SEV.WARNING;
        warning = {
          title: 'Spending faster than collecting',
          detail: 'Trailing ' + th.trailingDays + 'd run-rate: $' + monthlyOutflow + '/mo out vs $' + monthlyInflow + '/mo in (gap $' + burn + '/mo). Estimated runway ' + (runwayMonths != null ? runwayMonths + ' month(s)' : 'n/a') + ' at the current net position of $' + netPosition + '.',
          recommendation: 'Accelerate collections on overdue invoices and defer non-essential spend.'
        };
      }
      return { trailingInflow: trailingInflow, trailingOutflow: trailingOutflow, netPosition: netPosition, monthlyInflow: monthlyInflow, monthlyOutflow: monthlyOutflow, runwayMonths: runwayMonths, warning: warning, severity: severity, dataSufficient: true };
    },

    async _jobCosting(jobs, invoices, expenses, payments) {
      const A = acct();
      // Any job that has financial activity is worth costing.
      const activeIds = {};
      jobs.forEach((j) => { if (j && j.id) activeIds[j.id] = j.customerName || j.id; });
      invoices.forEach((i) => { if (i.jobId && !(i.jobId in activeIds)) activeIds[i.jobId] = i.customerName || i.jobId; });
      expenses.forEach((e) => { if (e.jobId && !(e.jobId in activeIds)) activeIds[e.jobId] = e.jobId; });
      const out = [];
      for (const jobId of Object.keys(activeIds)) {
        const jc = await A.jobCosting(jobId);
        const flags = [];
        if (jc.cost > 0 && jc.cost > jc.revenue && jc.billed > 0) flags.push('LOSS');
        if (jc.cost > 0 && jc.billed === 0) flags.push('UNBILLED');
        out.push({ jobId: jobId, name: activeIds[jobId], billed: jc.billed, revenue: jc.revenue, cost: jc.cost, profit: jc.profit, flags: flags });
      }
      // Sort worst-first (lowest profit) so the dashboard leads with problems.
      return out.sort((a, b) => a.profit - b.profit);
    },

    _taxIssues(expenses, receiptBacked, th) {
      const out = [];
      const uncategorized = expenses.filter((e) => !e.category || e.category === 'Uncategorized' || e.category === 'General');
      if (uncategorized.length) {
        const total = round(uncategorized.reduce((s, e) => s + num(e.amount), 0));
        out.push(finding('tax', SEV.WARNING, uncategorized.length + ' uncategorized expense(s)',
          '$' + total + ' is booked to a generic/uncategorized account, which weakens tax deductions and reporting.',
          { count: uncategorized.length, total: total },
          'Categorize these so deductions are accurate at tax time.',
          'MODIFY_ACCOUNTING'));
      }
      const undocumented = expenses.filter((e) => num(e.amount) >= th.largeExpense && !receiptBacked.has(e.id) && !e.receiptId);
      if (undocumented.length) {
        const total = round(undocumented.reduce((s, e) => s + num(e.amount), 0));
        out.push(finding('tax', SEV.WARNING, undocumented.length + ' large expense(s) without a receipt',
          '$' + total + ' in expenses over $' + th.largeExpense + ' have no attached receipt — an audit/substantiation risk.',
          { count: undocumented.length, total: total, threshold: th.largeExpense },
          'Attach a receipt (capture it in the Receipts screen) to document these.',
          'REVIEW_RECEIPTS'));
      }
      return out;
    },

    _score(health, findings) {
      let score = 100;
      findings.forEach((f) => { score -= (SEV_WEIGHT[f.severity] || 0); });
      // A healthy margin lifts the floor a little; a negative one caps it.
      if (health.profit < 0) score = Math.min(score, 40);
      return Math.max(0, Math.min(100, score));
    }
  };

  function bySeverity(findings) {
    return findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; }, { info: 0, warning: 0, critical: 0 });
  }

  global.AAA_CONTROLLER = Controller;
})(typeof window !== 'undefined' ? window : this);
