/*
 * AAA Security Center — owner-only hardening control panel.
 *
 * Shows the hardening status (enforcement, step-up/MFA, session validity, audit-
 * chain integrity), lets the owner configure a step-up PIN / TOTP and toggle
 * enforcement, start/refresh a validated session, perform a step-up, verify the
 * tamper-evident audit chain, and review recent signed privileged approvals.
 * Gated on MANAGE_SETTINGS (owner). Everything routes through the audited,
 * gateway-backed AAA_SECURITY authority — nothing here weakens a control silently.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function sec() { return global.AAA_SECURITY; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function canAdmin() { const r = rbac(); return !r || r.can('MANAGE_SETTINGS'); }
  function actor() { return (rbac() && rbac().label && rbac().label()) || 'owner'; }

  function chip(value, label, color) {
    return U().el('div', { className: 'aaa-chip' }, [
      U().el('span', { className: 'aaa-chip__value', text: String(value), style: { color: color || 'var(--muted)' } }),
      U().el('span', { className: 'aaa-chip__label', text: label }),
      U().el('div', { className: 'aaa-chip__bar', style: { background: color || 'var(--muted)', opacity: '0.85' } })
    ]);
  }
  function title(t) { return U().el('h2', { className: 'aaa-section-title', text: t }); }
  function empty(t) { return U().el('p', { className: 'aaa-empty', text: t }); }
  const GOOD = '#10B981', WARN = '#F59E0B', BAD = '#EF4444';

  async function render(container) {
    const ui = U();
    container.innerHTML = '';
    if (rbac() && !canAdmin()) {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 The Security Center is owner-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label()) + '. Security hardening is restricted to the owner.</div>' }));
      return;
    }
    if (!sec()) { container.appendChild(empty('Security module unavailable.')); return; }

    container.appendChild(ui.spinner('Loading security status…'));
    let st, chain, approvals;
    try { st = await sec().status(); chain = await sec().verifyAuditChain(); approvals = await sec().approvals(8); }
    catch (err) { container.innerHTML = ''; container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load security</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' })); return; }
    container.innerHTML = '';

    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(st.enforce ? 'ON' : 'OFF', 'Enforcement', st.enforce ? GOOD : WARN),
      chip(st.stepUpEnabled ? 'ON' : 'OFF', 'Step-up MFA', st.stepUpEnabled ? GOOD : WARN),
      chip(st.sessionValid ? 'valid' : 'none', 'Session', st.sessionValid ? GOOD : WARN),
      chip(chain.ok ? '✓' : '⚠', 'Audit chain', chain.ok ? GOOD : BAD)
    ]));

    // Audit-chain integrity.
    container.appendChild(title('Audit chain integrity'));
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: chain.ok
      ? '<strong style="color:' + GOOD + '">✓ Intact — ' + chain.length + ' sealed entries</strong><div class="aaa-list-sub">Every audit entry is hash-chained to its predecessor; no tampering detected.</div>'
      : '<strong style="color:' + BAD + '">⚠ ' + chain.breaks.length + ' break(s) detected</strong><div class="aaa-list-sub">' + esc(chain.breaks.map((b) => 'seq ' + b.seq + ': ' + b.reason).slice(0, 5).join(' · ')) + '</div>' }));
    container.appendChild(ui.button({ label: 'Re-verify audit chain', icon: '🔎', variant: 'secondary', full: true, onClick: () => render(container) }));

    // Step-up configuration.
    container.appendChild(title('Step-up authentication (MFA)'));
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">PIN: ' + (st.pinConfigured ? 'configured' : 'not set') + ' · TOTP: ' + (st.totpEnabled ? 'on' : 'off') + ' · step-up currently ' + (st.stepUpValid ? '<span style="color:' + GOOD + '">valid</span>' : 'required') + '</div>' }));
    const cfgForm = ui.el('div', { className: 'aaa-form', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
    cfgForm.appendChild(ui.button({ label: st.pinConfigured ? 'Change PIN' : 'Set PIN', size: 'sm', variant: 'primary', onClick: async () => {
      const pin = await prompt(ui, 'Set a step-up PIN', 'Enter a PIN (4+ digits). Required before privileged actions.');
      if (!pin) return;
      const res = await sec().configure({ pin: pin, actor: actor() });
      if (!res.ok) await ui.confirm({ title: 'Not saved', message: res.message || res.error, confirmLabel: 'OK' });
      await render(container);
    } }));
    cfgForm.appendChild(ui.button({ label: 'Set TOTP secret', size: 'sm', variant: 'secondary', onClick: async () => {
      const secret = await prompt(ui, 'Authenticator (TOTP) secret', 'Paste the base32 secret from your authenticator app.');
      if (!secret) return;
      const res = await sec().configure({ totpSecret: secret, actor: actor() });
      if (!res.ok) await ui.confirm({ title: 'Not saved', message: res.message || res.error, confirmLabel: 'OK' });
      await render(container);
    } }));
    container.appendChild(cfgForm);

    // Enforcement toggle.
    container.appendChild(title('Enforcement'));
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">' + (st.enforce
      ? 'ON — privileged actions require a valid session + a fresh step-up.'
      : 'OFF — the app runs at baseline. Turn on after setting a step-up factor.') + '</div>' }));
    container.appendChild(ui.button({ label: st.enforce ? 'Turn enforcement OFF' : 'Turn enforcement ON', icon: '🛡', variant: st.enforce ? 'ghost' : 'primary', full: true, onClick: async () => {
      const res = await sec().setEnforce(!st.enforce, { actor: actor() });
      if (!res.ok) await ui.confirm({ title: 'Not changed', message: res.error === 'STEP_UP_NOT_CONFIGURED' ? 'Set a step-up PIN or TOTP first.' : (res.message || res.error), confirmLabel: 'OK' });
      await render(container);
    } }));

    // Session + step-up actions.
    container.appendChild(title('Session'));
    const sessForm = ui.el('div', { className: 'aaa-form', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
    sessForm.appendChild(ui.button({ label: 'Start / refresh session', size: 'sm', variant: 'secondary', onClick: async () => { await sec().startSession({ actor: actor() }); await render(container); } }));
    if (st.stepUpEnabled) sessForm.appendChild(ui.button({ label: 'Step-up now', size: 'sm', variant: 'primary', onClick: async () => {
      const pin = await prompt(ui, 'Step-up', 'Enter your PIN' + (st.totpEnabled ? ' (and TOTP if required)' : '') + '.');
      if (!pin) return;
      const res = await sec().verifyStepUp({ pin: pin });
      if (!res.ok) await ui.confirm({ title: 'Step-up failed', message: res.error, confirmLabel: 'OK' });
      await render(container);
    } }));
    container.appendChild(sessForm);

    // Recent signed approvals.
    container.appendChild(title('Recent signed approvals'));
    if (!approvals.length) container.appendChild(empty('No signed privileged approvals yet.'));
    approvals.forEach((a) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong>' + esc(a.action) + ' · seq ' + a.seq + '</strong><div class="aaa-list-sub">' + esc(a.at) + ' · sig ' + esc(String(a.approvalSig).slice(0, 16)) + '…</div>' })));

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Server authority: Firestore rules enforce role + collection access regardless of this client. This panel adds step-up MFA, signed sessions, approval signatures, and a tamper-evident audit chain on top.' }));
  }

  async function prompt(ui, titleText, message) {
    if (ui.prompt) return ui.prompt({ title: titleText, message: message });
    const ok = await ui.confirm({ title: titleText, message: message + ' (entry UI unavailable in this build)', confirmLabel: 'OK' });
    return ok ? '' : null;
  }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Security Center', subtitle: 'AAA Carpet — hardening, MFA, audit integrity' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_SECURITY_UI = { render: render, open: open };
})(typeof window !== 'undefined' ? window : this);
