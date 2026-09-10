/* Searchable, permission-aware entry points into existing working features. */
;(function (global) {
  'use strict';
  const TOOLS = [
    ['quote', 'New quote', 'Price work and prepare a customer estimate.', 'Sell & follow up', 'VIEW_FINANCIALS', 'QUOTE_BUILDER_UI', 'estimate pricing'],
    ['quotes', 'Saved quotes & follow-ups', 'Review drafts, record wins and follow up on sent quotes.', 'Sell & follow up', 'VIEW_FINANCIALS', 'QUOTE_LIFECYCLE_UI', 'pipeline sales'],
    ['conversations', 'Customer conversations', 'Find messages and prepare replies for review.', 'Sell & follow up', 'EDIT_CUSTOMER', 'TRANSPORT_INBOX_UI', 'sms email inbox'],
    ['schedule', 'Schedule & dispatch', 'Plan job times, assign crews and check conflicts.', 'Plan & do the work', 'EDIT_JOB', 'SCHEDULE_UI', 'calendar appointment'],
    ['crew', 'Crew & tools', 'Find team members, assignments and equipment.', 'Plan & do the work', 'MANAGE_CREW', 'CREW_UI', 'employee equipment'],
    ['estimate', 'Field estimate', 'Turn measurements into an estimate for review.', 'Plan & do the work', 'CREATE_QUOTE', 'ESTIMATOR_UI', 'measure room'],
    ['approvals', 'Approvals', 'Review actions waiting for a person’s decision.', 'Run the business', 'VIEW_AUDIT_LOG', 'APPROVAL_INBOX_UI', 'review pending'],
    ['receipts', 'Receipts & expenses', 'Capture and review receipts before posting.', 'Run the business', 'VIEW_FINANCIALS', 'RECEIPT_INTAKE_UI', 'accounting costs scan'],
    ['delivery', 'Message delivery', 'Check actual delivery results and failures.', 'Run the business', 'EDIT_CUSTOMER', 'TRANSPORT_DASHBOARD_UI', 'sms email sent failed'],
    ['backup', 'Backups & recovery', 'Check saved copies, export or restore missing work.', 'Settings & recovery', 'MANAGE_SETTINGS', 'BACKUP_UI', 'restore export sync storage'],
    ['security', 'Security', 'Review access and security activity.', 'Settings & recovery', 'MANAGE_SETTINGS', 'SECURITY_UI', 'permissions access']
  ];
  function available(query) {
    const words = String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
    return TOOLS.filter((t) => global.AAA_RBAC && global.AAA_RBAC.can(t[4]) &&
      global['AAA_' + t[5]] && typeof global['AAA_' + t[5]].open === 'function' &&
      words.every(w => [t[1], t[2], t[3], t[6]].join(' ').toLowerCase().includes(w)));
  }
  function launch(id) {
    const tool = available().find(t => t[0] === id);
    if (!tool) return { ok: false, error: 'UNAVAILABLE' };
    return global['AAA_' + tool[5]].open();
  }
  function mount(root) {
    const U = global.AAA_UI;
    const wrap = U.el('section', { className: 'tools-home' });
    wrap.appendChild(U.el('h2', { text: 'What do you need to do?' }));
    const input = U.el('input', { className: 'aaa-input', attrs: { type: 'search', placeholder: 'Try quotes, schedule or receipts', 'aria-label': 'Find a tool' } });
    const count = U.el('p', { className: 'qb-help', attrs: { role: 'status' } });
    const list = U.el('div', { className: 'tools-list' });
    const error = U.el('p', { attrs: { role: 'alert' } });
    function render() {
      list.innerHTML = ''; const found = available(input.value);
      count.textContent = found.length ? found.length + ' tools available' : 'No matching tools. Try a different word.';
      for (const group of [...new Set(found.map(t => t[3]))]) {
        list.appendChild(U.el('h3', { text: group }));
        for (const tool of found.filter(t => t[3] === group)) {
          const row = U.el('button', { className: 'tools-row', attrs: { type: 'button' } }, [U.el('strong', { text: tool[1] }), U.el('span', { text: tool[2] })]);
          row.addEventListener('click', async () => { try { error.textContent = ''; await launch(tool[0]); } catch (_) { error.textContent = 'This tool could not open. Please retry.'; } });
          list.appendChild(row);
        }
      }
    }
    input.addEventListener('input', render);
    wrap.appendChild(input); wrap.appendChild(count); wrap.appendChild(list); wrap.appendChild(error); root.appendChild(wrap); render();
  }
  global.AAA_TOOLS_HOME = { available, launch, mount };
})(typeof window !== 'undefined' ? window : this);
