/*
 * AAA Action Safety Gate — the blueprint's guard_tool_call, for this repo.
 *
 * The Escalation Policy decides when a *business decision* (money, legal, low
 * confidence) is high-stakes enough to challenge. This gate is the complement:
 * it classifies a proposed *action* by reversibility and blast radius, so the
 * agent layer never quietly takes a destructive, externally-visible, or
 * spend-bearing step without a human in the loop.
 *
 *   assess(action) → { decision:'allow'|'needs_approval'|'deny', level, categories[], reasons[] }
 *   review(actions) → assess each; summarize how many need approval / are denied
 *
 * Pure and read-only — it never executes anything, it only judges. Inputs may be
 * a plain string (an agent's proposed next_action), or { tool, command, text }.
 *
 * Policy (conservative by design — a false "needs_approval" only costs a tap):
 *   deny           → looks catastrophic and never auto-runnable (rm -rf /, drop database)
 *   needs_approval → destructive / external / spend-bearing / irreversible
 *   allow          → everything else (local, reversible, internal)
 */
;(function (global) {
  'use strict';

  // Tool names that are inherently high-risk regardless of args.
  const HIGH_RISK_TOOLS = [
    'git_push', 'force_push', 'terraform_apply', 'k8s_delete', 'kubectl_delete',
    'drop_table', 'publish_release', 'deploy_production', 'send_email', 'send_sms',
    'send_slack', 'charge_card', 'issue_refund', 'delete_customer', 'delete_job',
    'create_cloud_resource', 'rotate_secret'
  ];

  // Category → regexes that mark an action's text/command as that kind of risk.
  const CATEGORY_PATTERNS = {
    destructive: [
      /\brm\s+-rf\b/i, /\bgit\s+push\s+--force\b/i, /\bgit\s+reset\s+--hard\b/i,
      /\bdrop\s+(table|database|schema)\b/i, /\btruncate\s+table\b/i,
      /\bdelete\s+from\b/i, /\bformat\b.*\bdisk\b/i, /\bdestroy\b/i, /\bpurge\b/i,
      /\bforce[- ]?push\b/i, /\bdelete[sd]?\b/i, /\bwipe\b/i, /\boverwrit/i
    ],
    external: [
      /\bsend\b.*\b(email|sms|text|message|slack)\b/i, /\bnotify\s+customer\b/i,
      /\bpublish\b/i, /\bpost\b.*\b(public|review|social)\b/i, /\bemail\s+the\s+customer\b/i,
      /\bcall\b.*\bcustomer\b/i, /\boutbound\b/i
    ],
    spend: [
      /\bcharge\b/i, /\brefund\b/i, /\bpayout\b/i, /\binvoice\b.*\bsend\b/i,
      /\bprovision\b/i, /\bcreate\b.*\b(instance|cluster|bucket|resource)\b/i,
      /\bspend\b/i, /\bpurchase\b/i, /\bbuy\b/i
    ],
    irreversible: [
      /\bfinaliz/i, /\bclose\s+(the\s+)?(job|quote|invoice)\b/i, /\bmigrat/i,
      /\brewrite\s+history\b/i, /\bforce\b/i
    ]
  };

  // The most dangerous shapes: deny outright (never auto-run, even with approval flow).
  const DENY_PATTERNS = [
    /\brm\s+-rf\s+\/(?:\s|$)/i,            // rm -rf /
    /\brm\s+-rf\s+\/\*/i,                   // rm -rf /*
    /\bdrop\s+database\b/i,
    /\b(:|\bfork)\s*\(\s*\)\s*\{\s*:\s*\|\s*:/ // fork bomb shape
  ];

  function textOf(action) {
    if (action == null) return '';
    if (typeof action === 'string') return action;
    return [action.command, action.text, action.description, action.action].filter(Boolean).join(' ');
  }
  function toolOf(action) {
    if (action && typeof action === 'object') return String(action.tool || action.name || '').toLowerCase();
    return '';
  }

  function categoriesFor(text) {
    const cats = [];
    for (const cat in CATEGORY_PATTERNS) {
      if (!Object.prototype.hasOwnProperty.call(CATEGORY_PATTERNS, cat)) continue;
      if (CATEGORY_PATTERNS[cat].some((re) => re.test(text))) cats.push(cat);
    }
    return cats;
  }

  const Gate = {
    HIGH_RISK_TOOLS: HIGH_RISK_TOOLS.slice(),

    /**
     * Judge a single proposed action.
     * @returns {{decision:string, level:string, categories:string[], reasons:string[]}}
     */
    assess(action) {
      const text = textOf(action);
      const tool = toolOf(action);
      const reasons = [];

      if (DENY_PATTERNS.some((re) => re.test(text))) {
        return { decision: 'deny', level: 'critical', categories: ['destructive'], reasons: ['matches a never-auto-run catastrophic pattern'] };
      }

      const categories = categoriesFor(text);
      if (tool && HIGH_RISK_TOOLS.indexOf(tool) !== -1) {
        reasons.push('high-risk tool "' + tool + '"');
        if (categories.indexOf('external') === -1 && /send_|notify/.test(tool)) categories.push('external');
        if (categories.indexOf('spend') === -1 && /charge|refund|payout|resource/.test(tool)) categories.push('spend');
        if (categories.indexOf('destructive') === -1 && /delete|drop|push|terraform|k8s|kubectl/.test(tool)) categories.push('destructive');
      }
      categories.forEach((c) => reasons.push('action looks ' + c));

      if (categories.length || reasons.length) {
        const level = categories.indexOf('destructive') !== -1 ? 'high' : 'medium';
        return { decision: 'needs_approval', level: level, categories: categories.length ? categories : ['unspecified'], reasons: reasons };
      }
      return { decision: 'allow', level: 'low', categories: [], reasons: ['local / reversible / internal'] };
    },

    /** Judge a list of actions and summarize. */
    review(actions) {
      const list = Array.isArray(actions) ? actions : (actions == null ? [] : [actions]);
      const results = list.map((a) => ({ action: typeof a === 'string' ? a : a, verdict: this.assess(a) }));
      const needsApproval = results.filter((r) => r.verdict.decision === 'needs_approval').length;
      const denied = results.filter((r) => r.verdict.decision === 'deny').length;
      return {
        total: results.length,
        allowed: results.length - needsApproval - denied,
        needsApproval: needsApproval,
        denied: denied,
        blocked: needsApproval + denied > 0,
        results: results
      };
    }
  };

  global.AAA_ACTION_GATE = Gate;
})(typeof window !== 'undefined' ? window : this);
