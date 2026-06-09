/*
 * AAA Job List UI — application shell (dashboard + job detail).
 *
 * Renders the job list grouped by lifecycle state with at-a-glance summary
 * chips, and a per-job detail view wired into the Voice, Vision, and Closure
 * HUDs. All reads come from local-first storage, so re-rendering always shows
 * the latest persisted state. Uses the shared AAA_UI kit for buttons/badges.
 */
;(function (global) {
  'use strict';

  const STATES = [
    { key: 'IN_PROGRESS', label: 'In Progress', color: '#F59E0B' },
    { key: 'SCHEDULED', label: 'Scheduled', color: '#3B82F6' },
    { key: 'QUOTE_OPEN', label: 'Quote Open', color: '#94A3B8' },
    { key: 'CLOSED', label: 'Closed', color: '#10B981' }
  ];
  const STATE_MAP = STATES.reduce((m, s) => ((m[s.key] = s), m), {});
  const UI = () => global.AAA_UI;

  const APP = {
    containerId: 'app-root',
    tab: 'jobs',
    view: { name: 'list', jobId: null },
    _hudPoll: null,

    async boot() {
      this.storage = global.AAA_LOCAL_FIRST_STORAGE;
      await this._seedIfEmpty();
      this._mountVoiceHud();
      if (!this._focusBound) {
        global.addEventListener('focus', () => this.render());
        this._focusBound = true;
      }
      return true;
    },

    // ---- data helpers -----------------------------------------------------
    async _allJobs() {
      try {
        const jobs = await this.storage.getAll('jobs');
        return jobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      } catch (_) {
        return [];
      }
    },
    async _getJob(id) { return this.storage.get('jobs', id); },

    async _setJobState(id, nextState) {
      const job = await this._getJob(id);
      if (!job) return;
      job.currentState = nextState;
      await this.storage.put('jobs', id, job);
      const idFactory = global.AAA_ID_FACTORY;
      const clock = global.AAA_RUNTIME_CLOCK;
      if (this.storage.queueMutation) {
        await this.storage.queueMutation({
          mutationId: idFactory ? idFactory.createId('mut') : String(Date.now()),
          entityId: id, entityType: 'job', operation: 'SET_STATE',
          payload: { currentState: nextState },
          timestamp: clock ? clock.nowISO() : new Date().toISOString(),
          syncStatus: 'PENDING'
        });
      }
    },

    _summarize(jobs) {
      const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
      const todayMs = startOfDay.getTime();
      const now = Date.now();
      let inProgress = 0, closedToday = 0, needsAttention = 0;
      jobs.forEach((j) => {
        const state = j.currentState || 'QUOTE_OPEN';
        if (state === 'IN_PROGRESS') inProgress++;
        if (state === 'CLOSED' && j.closedAt && j.closedAt >= todayMs) closedToday++;
        if (state === 'QUOTE_OPEN') needsAttention++;
        else if (state === 'SCHEDULED' && j.scheduledDate) {
          const t = new Date(j.scheduledDate).getTime();
          if (isFinite(t) && t < now) needsAttention++; // overdue
        }
      });
      return { inProgress: inProgress, closedToday: closedToday, needsAttention: needsAttention };
    },

    async _seedIfEmpty() {
      try {
        const seeded = await this.storage.get('meta', 'seeded');
        if (seeded) return;
        const jobs = await this.storage.getAll('jobs');
        if (jobs.length === 0) {
          const customerStore = global.AAA_CUSTOMER_STORE;
          const flow = global.AAA_NEW_JOB_FLOW_UI;
          const samples = [
            { cust: { name: 'Marina Bay Offices', address: '120 Harbour Dr, Suite 400', phone: '555-0142', gateCode: '#4821' },
              job: { scheduledDate: this._isoLocalIn(2), currentState: 'SCHEDULED', notes: 'Lobby + 3 conference rooms, commercial loop pile.' } },
            { cust: { name: 'The Henderson Residence', address: '88 Maple Court', phone: '555-0199', gateCode: '' },
              job: { currentState: 'QUOTE_OPEN', notes: 'Stair runner re-stretch, possible seam repair on landing.' } }
          ];
          for (const s of samples) {
            const customer = customerStore ? await customerStore.add(s.cust) : { id: null, name: s.cust.name, address: s.cust.address };
            const job = await flow.buildJobRecord({
              customerId: customer.id, customerName: customer.name, serviceAddress: customer.address,
              gateCode: customer.gateCode || null, scheduledDate: s.job.scheduledDate || null,
              notes: s.job.notes, currentState: s.job.currentState
            });
            await flow.saveJob(job);
          }
        }
        await this.storage.put('meta', 'seeded', true);
      } catch (err) { console.warn('Job list: seeding skipped', err); }
    },
    _isoLocalIn(days) {
      const d = new Date(Date.now() + days * 86400000);
      d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
      return d.toISOString().slice(0, 16);
    },

    // ---- voice HUD mount --------------------------------------------------
    _mountVoiceHud() {
      if (document.getElementById('voice-hud')) return;
      const hud = document.createElement('div');
      hud.id = 'voice-hud';
      hud.innerHTML =
        '<div id="voice-overlay" class="voice-overlay">' +
        '<p id="voice-status" class="voice-status"></p>' +
        '<p id="voice-transcript" class="voice-text"></p></div>' +
        '<button id="voice-fab" class="voice-fab" title="Voice log" aria-label="Add voice note">🎤</button>';
      document.body.appendChild(hud);
      if (global.AAA_VOICE_HUD_UI && global.AAA_VOICE_HUD_UI.boot) global.AAA_VOICE_HUD_UI.boot({ jobId: null });
    },
    _setActiveVoiceJob(jobId) {
      const v = global.AAA_VOICE_HUD_UI;
      if (v && v.updateJobId) v.updateJobId(jobId);
    },

    // ---- bottom tab bar ---------------------------------------------------
    _mountTabBar() {
      if (document.getElementById('aaa-tabbar')) return;
      const ui = UI();
      const mk = (tab, icon, label) => ui.el('button', {
        className: 'aaa-tab', attrs: { type: 'button', 'data-tab': tab, 'aria-label': label },
        on: { click: () => this._switchTab(tab) }
      }, [ui.el('span', { className: 'aaa-tab__icon', text: icon }), ui.el('span', { text: label })]);
      const bar = ui.el('nav', { id: 'aaa-tabbar', className: 'aaa-tabbar' }, [
        mk('jobs', '🗂', 'Jobs'), mk('agents', '🧠', 'AI Agents'), mk('business', '📊', 'Business')
      ]);
      document.body.appendChild(bar);
    },
    _switchTab(tab) {
      this.tab = tab;
      if (tab === 'jobs') this.view = { name: 'list', jobId: null };
      this.render();
    },
    _highlightTab() {
      const bar = document.getElementById('aaa-tabbar');
      if (!bar) return;
      bar.querySelectorAll('.aaa-tab').forEach((b) => b.classList.toggle('is-active', b.getAttribute('data-tab') === this.tab));
    },

    // ---- rendering --------------------------------------------------------
    async render(containerId) {
      if (containerId) this.containerId = containerId;
      const root = document.getElementById(this.containerId);
      if (!root) return;
      this._mountTabBar();
      this._highlightTab();

      if (this.tab === 'agents') {
        this._setActiveVoiceJob(null);
        root.innerHTML = '';
        root.appendChild(this._header('<span class="aaa-title-mark">AAA</span> AI Team', null));
        const main = UI().el('main', { className: 'aaa-main' });
        root.appendChild(main);
        if (global.AAA_COMMAND_CENTER && global.AAA_COMMAND_CENTER.render) await global.AAA_COMMAND_CENTER.render(main);
        return;
      }
      if (this.tab === 'business') {
        this._setActiveVoiceJob(null);
        root.innerHTML = '';
        root.appendChild(this._header('<span class="aaa-title-mark">AAA</span> Business', null));
        const main = UI().el('main', { className: 'aaa-main' });
        root.appendChild(main);
        if (global.AAA_BUSINESS && global.AAA_BUSINESS.render) await global.AAA_BUSINESS.render(main);
        return;
      }
      // jobs tab
      if (this.view.name === 'detail' && this.view.jobId) await this._renderDetail(root);
      else await this._renderList(root);
    },

    async _renderList(root) {
      this._setActiveVoiceJob(null);
      const ui = UI();
      const jobs = await this._allJobs();

      const header = this._header('<span class="aaa-title-mark">AAA</span> HyperKernel', null, true);
      header.querySelector('.aaa-header-actions').appendChild(
        ui.button({ label: 'New Job', icon: '+', variant: 'primary', size: 'sm', onClick: () => this._onNewJob(), ariaLabel: 'Create a new job' })
      );

      const main = ui.el('main', { className: 'aaa-main' });

      // Summary chips
      const s = this._summarize(jobs);
      main.appendChild(ui.el('section', { className: 'aaa-summary' }, [
        this._chip(s.inProgress, 'In Progress', '#F59E0B'),
        this._chip(s.closedToday, 'Closed Today', '#10B981'),
        this._chip(s.needsAttention, 'Needs Attention', '#DC2626')
      ]));

      if (jobs.length === 0) {
        main.appendChild(ui.el('div', { className: 'aaa-empty-state' }, [
          ui.el('div', { className: 'aaa-empty-icon', text: '🧾' }),
          ui.el('p', { text: 'No jobs yet.' }),
          ui.el('p', { className: 'aaa-empty-sub', text: 'Tap “New Job” to get started.' })
        ]));
      } else {
        STATES.forEach((st) => {
          const group = jobs.filter((j) => (j.currentState || 'QUOTE_OPEN') === st.key);
          if (group.length === 0) return;
          const section = ui.el('section', { className: 'aaa-group' });
          section.appendChild(ui.el('h2', { className: 'aaa-group-title', html:
            '<span class="aaa-dot" style="background:' + st.color + '"></span>' + st.label +
            ' <span class="aaa-count">' + group.length + '</span>' }));
          group.forEach((job) => section.appendChild(this._jobCard(job)));
          main.appendChild(section);
        });
      }

      root.innerHTML = '';
      root.appendChild(header);
      root.appendChild(main);
    },

    _chip(value, label, color) {
      return UI().el('div', { className: 'aaa-chip' }, [
        UI().el('span', { className: 'aaa-chip__value', text: String(value), style: { color: value > 0 ? color : 'var(--muted)' } }),
        UI().el('span', { className: 'aaa-chip__label', text: label }),
        UI().el('div', { className: 'aaa-chip__bar', style: { background: color, opacity: value > 0 ? '0.9' : '0.25' } })
      ]);
    },

    _jobCard(job) {
      const ui = UI();
      const st = STATE_MAP[job.currentState] || STATE_MAP.QUOTE_OPEN;
      const logs = Array.isArray(job.logs) ? job.logs.length : 0;
      const estimates = Array.isArray(job.estimates) ? job.estimates.length : 0;

      const top = ui.el('div', { className: 'aaa-card-top' }, [
        ui.el('span', { className: 'aaa-card-name', text: job.customerName || 'Unnamed job' }),
        ui.statusBadge(st.label, st.color)
      ]);
      const meta = ui.el('div', { className: 'aaa-card-meta' }, [
        ui.el('span', { html: job.scheduledDate ? '🗓 ' + esc(formatDate(job.scheduledDate)) : '🗓 No schedule' }),
        logs ? ui.el('span', { html: '📝 ' + logs }) : null,
        estimates ? ui.el('span', { html: '📐 ' + estimates }) : null
      ]);
      const card = ui.el('button', { className: 'aaa-card', attrs: { type: 'button' }, on: {
        click: () => { this.view = { name: 'detail', jobId: job.id }; this.render(); }
      } }, [
        top,
        job.serviceAddress ? ui.el('div', { className: 'aaa-card-sub', text: job.serviceAddress }) : null,
        meta
      ]);
      return card;
    },

    async _renderDetail(root) {
      const ui = UI();
      const job = await this._getJob(this.view.jobId);
      if (!job) { this.view = { name: 'list', jobId: null }; return this._renderList(root); }
      this._setActiveVoiceJob(job.id);
      const st = STATE_MAP[job.currentState] || STATE_MAP.QUOTE_OPEN;

      const header = this._header(esc(job.customerName || 'Job'), () => { this.view = { name: 'list', jobId: null }; this.render(); });

      const main = ui.el('main', { className: 'aaa-main' });

      const summary = ui.el('section', { className: 'aaa-detail-summary' });
      summary.appendChild(ui.statusBadge(st.label, st.color));
      if (job.serviceAddress) summary.appendChild(ui.el('p', { className: 'aaa-detail-line', html: '📍 ' + esc(job.serviceAddress) }));
      if (job.scheduledDate) summary.appendChild(ui.el('p', { className: 'aaa-detail-line', html: '🗓 ' + esc(formatDate(job.scheduledDate)) }));
      if (job.gateCode) summary.appendChild(ui.el('p', { className: 'aaa-detail-line', html: '🔑 Gate ' + esc(job.gateCode) }));
      if (job.notes) summary.appendChild(ui.el('p', { className: 'aaa-detail-notes', text: job.notes }));
      main.appendChild(summary);

      const actions = ui.el('div', { className: 'aaa-detail-actions' });
      if (job.currentState !== 'IN_PROGRESS' && job.currentState !== 'CLOSED') {
        actions.appendChild(ui.button({ label: 'Start Job', icon: '▶', variant: 'primary', onClick: async () => { await this._setJobState(job.id, 'IN_PROGRESS'); this.render(); } }));
      }
      actions.appendChild(ui.button({ label: 'Vision Estimate', icon: '📷', variant: 'secondary', onClick: () => {
        if (global.AAA_VISION_HUD_UI && global.AAA_VISION_HUD_UI.boot) { global.AAA_VISION_HUD_UI.boot({ jobId: job.id }); this._reRenderWhenHudCloses('vision-hud'); }
      } }));
      actions.appendChild(ui.button({ label: 'Measure Room', icon: '📐', variant: 'secondary', onClick: () => {
        if (global.AAA_MEASUREMENT_HUD_UI && global.AAA_MEASUREMENT_HUD_UI.boot) { global.AAA_MEASUREMENT_HUD_UI.boot({ jobId: job.id, customerId: job.customerId }); this._reRenderWhenHudCloses('measurement-hud'); }
      } }));
      if (job.currentState !== 'CLOSED') {
        actions.appendChild(ui.button({ label: 'Close Job', icon: '✓', variant: 'secondary', onClick: () => {
          if (global.AAA_CLOSURE_HUD_UI && global.AAA_CLOSURE_HUD_UI.boot) { global.AAA_CLOSURE_HUD_UI.boot({ jobId: job.id }); this._reRenderWhenHudCloses('closure-hud'); }
        } }));
      } else {
        actions.appendChild(ui.button({ label: 'Reopen', icon: '↺', variant: 'ghost', onClick: async () => { await this._setJobState(job.id, 'IN_PROGRESS'); this.render(); } }));
      }
      main.appendChild(actions);

      // AI Team review (real Claude meeting through the proxy when configured).
      main.appendChild(ui.button({ label: 'Ask AI Team', icon: '🧠', variant: 'secondary', full: true, onClick: () => this._askAITeam(job) }));

      // Review request (closed jobs) — send from the tech's own phone.
      if (job.currentState === 'CLOSED' && global.AAA_REVIEW_REQUEST_ENGINE) {
        main.appendChild(ui.button({ label: 'Send Review Request', icon: '⭐', variant: 'secondary', full: true, onClick: () => this._sendReview(job) }));
      }

      // Sales outcome capture (won is captured automatically at closeout).
      if (job.currentState !== 'CLOSED') {
        main.appendChild(ui.el('div', { className: 'aaa-detail-actions' }, [
          ui.button({ label: 'Mark Lost', variant: 'ghost', size: 'sm', onClick: async () => { await this._recordOutcome(job.id, 'lost'); this.render(); } }),
          ui.button({ label: 'Callback', variant: 'ghost', size: 'sm', onClick: async () => { await this._recordOutcome(job.id, 'callback'); this.render(); } })
        ]));
      }

      main.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Tip: tap the 🎤 button to log a hands-free voice note.' }));

      if (Array.isArray(job.estimates) && job.estimates.length) {
        main.appendChild(ui.el('h2', { className: 'aaa-section-title', text: 'Estimates' }));
        job.estimates.forEach((e) => {
          main.appendChild(ui.el('div', { className: 'aaa-list-row', html:
            '<strong>' + esc(e.type || 'Estimate') + '</strong>' +
            (e.estimatedTimeMins ? ' · ' + esc(String(e.estimatedTimeMins)) + ' mins' : '') +
            (e.estimatedQuoteRange ? ' · ' + esc(e.estimatedQuoteRange) : '') +
            (Array.isArray(e.materials) && e.materials.length ? '<div class="aaa-list-sub">' + esc(e.materials.join(', ')) + '</div>' : '') }));
        });
      }

      if (Array.isArray(job.logs) && job.logs.length) {
        main.appendChild(ui.el('h2', { className: 'aaa-section-title', text: 'Work Log' }));
        job.logs.slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).forEach((l) => {
          main.appendChild(ui.el('div', { className: 'aaa-list-row', html:
            '<div>' + esc(l.text || '') + '</div>' +
            '<div class="aaa-list-sub">' + esc(formatDateTime(l.timestamp)) + (l.type ? ' · ' + esc(l.type) : '') + '</div>' }));
        });
      }

      root.innerHTML = '';
      root.appendChild(header);
      root.appendChild(main);
    },

    // ---- small builders ---------------------------------------------------
    _header(titleHtml, onBack) {
      const ui = UI();
      const left = ui.el('div', { className: 'aaa-header-left' });
      if (onBack) left.appendChild(ui.el('button', { className: 'aaa-back', attrs: { 'aria-label': 'Back', type: 'button' }, text: '‹', on: { click: onBack } }));
      left.appendChild(ui.el('h1', { className: 'aaa-title', html: titleHtml }));
      return ui.el('header', { className: 'aaa-header' }, [left, ui.el('div', { className: 'aaa-header-actions' })]);
    },

    async _sendReview(job) {
      const ui = UI();
      const engine = global.AAA_REVIEW_REQUEST_ENGINE;
      const s = ui.sheet({ title: 'Review Request', subtitle: (job.customerName || 'Customer') + ' — sent from your phone' });
      document.body.appendChild(s.overlay);
      s.body.appendChild(ui.spinner('Preparing message…'));
      const res = await engine.requestReview(job.id);
      s.body.innerHTML = '';
      if (!res || !res.ok) { s.body.appendChild(ui.el('p', { className: 'aaa-dialog__message', text: 'Could not prepare a review request.' })); return; }
      const rec = res.review;

      // Content-safety gate (fail-closed): an AI-drafted message that was
      // blocked (flagged unsafe) or queued (couldn't be verified) does NOT get
      // one-tap send. No direct override here — the human must open the
      // Governance review flow, where an Admin can override with justification.
      if (rec.status === 'blocked' || rec.status === 'queued') {
        s.body.appendChild(this._safetyBanner(rec));
        s.body.appendChild(ui.el('label', { className: 'aaa-field-label', text: 'Drafted message (held for review — not sent)' }));
        s.body.appendChild(ui.el('div', { className: 'aaa-input aaa-textarea', style: { whiteSpace: 'pre-wrap', opacity: '0.85' }, text: rec.message || '' }));
        const reviewBtn = ui.button({ label: '🛡 Review Safety Decision', variant: 'secondary', full: true, onClick: () => { s.close(); this._governanceReview(rec); } });
        s.body.appendChild(reviewBtn);
        return;
      }

      const msg = ui.el('textarea', { className: 'aaa-input aaa-textarea' });
      msg.value = rec.message || '';
      s.body.appendChild(ui.el('label', { className: 'aaa-field-label', text: 'Message (edit if you like)' }));
      s.body.appendChild(msg);
      // Unobtrusive governance measurement indicator on this agent-drafted output.
      if (rec.governanceDecisionId && global.AAA_GOV_BADGE) {
        const b = global.AAA_GOV_BADGE.badge(rec.governanceDecisionId);
        if (b) s.body.appendChild(b);
      }

      function links() { return engine.links(Object.assign({}, rec, { message: msg.value })); }
      const smsA = ui.el('a', { className: 'aaa-btn aaa-btn--primary aaa-btn--full', text: '✉ Send via SMS', attrs: { role: 'button' } });
      const mailA = ui.el('a', { className: 'aaa-btn aaa-btn--secondary aaa-btn--full', text: '✉ Send via Email', attrs: { role: 'button' } });
      const sync = () => { const l = links(); smsA.setAttribute('href', l.sms); mailA.setAttribute('href', l.email); };
      sync(); msg.addEventListener('input', sync);
      smsA.addEventListener('click', () => engine.markSent(rec.id, 'sms'));
      mailA.addEventListener('click', () => engine.markSent(rec.id, 'email'));
      const copyBtn = ui.button({ label: 'Copy message', variant: 'ghost', full: true, onClick: async () => {
        try { await (global.navigator.clipboard && global.navigator.clipboard.writeText(msg.value)); } catch (_) {}
        await engine.markSent(rec.id, 'copied');
      } });
      s.body.appendChild(smsA); s.body.appendChild(mailA); s.body.appendChild(copyBtn);
      if (!rec.phone) s.body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'No phone on file — add one to the customer for one-tap SMS.' }));
    },

    /** Admin banner explaining why an AI-drafted review message was held. */
    _safetyBanner(rec) {
      const ui = UI();
      const sf = rec.safety || {};
      const blocked = rec.status === 'blocked';
      const color = blocked ? 'var(--red)' : 'var(--warning)';
      const title = blocked
        ? '⛔ Blocked by content safety'
        : '⏳ Held for review — safety could not be verified';
      const reason = blocked
        ? ('Flagged unsafe' + (sf.categories && sf.categories.length ? ' (' + sf.categories.join(', ') + ')' : '') + '.')
        : ('Verdict: ' + (sf.verdict || 'unknown') + (sf.error ? ' — ' + sf.error : '') + '. Not auto-sent.');
      const when = sf.checkedAt ? new Date(sf.checkedAt).toLocaleString() : '';
      return ui.el('div', {
        attrs: { role: 'alert' },
        style: {
          border: '1px solid ' + color, borderLeft: '4px solid ' + color,
          background: 'rgba(0,0,0,0.03)', borderRadius: '8px',
          padding: '10px 12px', margin: '0 0 12px 0'
        }
      }, [
        ui.el('strong', { text: title, style: { color: color, display: 'block', marginBottom: '4px' } }),
        ui.el('p', { className: 'aaa-dialog__message', text: reason, style: { margin: '0 0 4px 0' } }),
        ui.el('p', { className: 'aaa-empty', text: 'Model: ' + (sf.model || 'content-safety') + (when ? ' · ' + when : '') + ' · ref ' + (sf.messageContextId || rec.id), style: { margin: '0', fontSize: '11px' } })
      ]);
    },

    /**
     * Governance review & override flow. Shows the full safety verdict and,
     * for an Admin (owner), a justified-override path that merely UNLOCKS the
     * Send button — the human must then explicitly send. Everything is audited
     * by AAA_GOVERNANCE_ENGINE; this UI only presents it.
     */
    async _governanceReview(rec) {
      const ui = UI();
      const gov = global.AAA_GOVERNANCE_ENGINE;
      const sf = rec.safety || {};
      const s = ui.sheet({ title: 'Review Safety Decision', subtitle: (rec.customerName || 'Customer') + ' · ' + (rec.status === 'blocked' ? 'Blocked' : 'Queued') });
      document.body.appendChild(s.overlay);
      s.body.appendChild(this._safetyBanner(rec));

      // Full decision detail: draft, verdict, categories, raw, model, time.
      const caseRec = (gov && gov.getCase && sf.governanceCaseId) ? await gov.getCase(sf.governanceCaseId) : null;
      const detail = (k, v) => ui.el('div', { className: 'aaa-list-sub', html: '<strong>' + k + ':</strong> ' + (v == null || v === '' ? '—' : String(v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))) });
      s.body.appendChild(ui.el('label', { className: 'aaa-field-label', text: 'Original draft' }));
      s.body.appendChild(ui.el('div', { className: 'aaa-input aaa-textarea', style: { whiteSpace: 'pre-wrap' }, text: rec.message || '' }));
      s.body.appendChild(detail('Verdict', sf.verdict));
      s.body.appendChild(detail('Categories', (sf.categories || []).join(', ')));
      s.body.appendChild(detail('Model', sf.model));
      s.body.appendChild(detail('Decision', sf.decision + (sf.error ? ' (' + sf.error + ')' : '')));
      s.body.appendChild(detail('Checked at', sf.checkedAt ? new Date(sf.checkedAt).toLocaleString() : ''));
      s.body.appendChild(detail('Message ref', sf.messageContextId || rec.id));
      s.body.appendChild(detail('Raw response', typeof sf.raw === 'string' ? sf.raw : JSON.stringify(sf.raw || {})));

      const sendHost = ui.el('div', {});
      const canOverride = !!(gov && gov.canOverride && gov.canOverride());

      // Already overridden? Go straight to the (still explicit) send controls.
      if (caseRec && caseRec.status === 'overridden') {
        s.body.appendChild(ui.el('p', { className: 'aaa-dialog__message', text: 'Override on record. Sending is unlocked but still manual.' }));
        this._renderSendControls(sendHost, rec, caseRec.id);
        s.body.appendChild(sendHost);
        return;
      }

      if (!canOverride) {
        s.body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'Only an Admin (Owner) can override this decision. It will remain held for review.' }));
        return;
      }
      if (!gov || !sf.governanceCaseId) {
        s.body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'Governance record unavailable — cannot override here.' }));
        return;
      }

      // Admin override: mandatory justification (min chars), then unlock send.
      s.body.appendChild(ui.el('label', { className: 'aaa-field-label', text: 'Override justification (required, min ' + gov.MIN_REASON + ' characters)' }));
      const reason = ui.el('textarea', { className: 'aaa-input aaa-textarea', attrs: { placeholder: 'Explain why this message is safe to send despite the flag…' } });
      s.body.appendChild(reason);
      const counter = ui.el('p', { className: 'aaa-empty', text: '0 / ' + gov.MIN_REASON });
      s.body.appendChild(counter);
      const overrideBtn = ui.button({ label: 'Override & unlock Send', variant: 'danger', full: true, disabled: true });
      const msg = ui.el('p', { className: 'aaa-dialog__message' });
      reason.addEventListener('input', () => {
        const n = reason.value.trim().length;
        counter.textContent = n + ' / ' + gov.MIN_REASON;
        overrideBtn.disabled = n < gov.MIN_REASON;
      });
      overrideBtn.addEventListener('click', async () => {
        overrideBtn.disabled = true; msg.textContent = 'Recording override…';
        const res = await gov.requestOverride(sf.governanceCaseId, { reason: reason.value });
        if (!res || !res.ok) { msg.textContent = res && res.error === 'JUSTIFICATION_REQUIRED' ? 'A longer justification is required.' : ('Override failed: ' + ((res && res.error) || 'unknown')); overrideBtn.disabled = false; return; }
        reason.disabled = true; overrideBtn.style.display = 'none';
        msg.textContent = '✅ Override recorded and audited. Sending is unlocked — you must still send manually.';
        if (res.alert) s.body.appendChild(ui.el('p', { className: 'aaa-empty', text: '⚠ ' + res.alert.message }));
        this._renderSendControls(sendHost, rec, sf.governanceCaseId);
      });
      s.body.appendChild(overrideBtn);
      s.body.appendChild(msg);
      s.body.appendChild(sendHost);
    },

    /** Device-native send buttons that record an explicit, audited Send. */
    _renderSendControls(host, rec, caseId) {
      const ui = UI();
      const engine = global.AAA_REVIEW_REQUEST_ENGINE;
      host.innerHTML = '';
      const links = engine.links(rec);
      const markSent = async (channel) => {
        await engine.markSent(rec.id, channel);
        try { if (global.AAA_GOVERNANCE_ENGINE && global.AAA_GOVERNANCE_ENGINE.recordSent) await global.AAA_GOVERNANCE_ENGINE.recordSent(caseId, { channel: channel }); } catch (_) {}
      };
      const smsA = ui.el('a', { className: 'aaa-btn aaa-btn--primary aaa-btn--full', text: '✉ Send via SMS', attrs: { role: 'button', href: links.sms } });
      const mailA = ui.el('a', { className: 'aaa-btn aaa-btn--secondary aaa-btn--full', text: '✉ Send via Email', attrs: { role: 'button', href: links.email } });
      smsA.addEventListener('click', () => markSent('sms'));
      mailA.addEventListener('click', () => markSent('email'));
      host.appendChild(smsA); host.appendChild(mailA);
    },

    async _recordOutcome(jobId, result) {
      if (!global.AAA_DATA || !global.AAA_DATA.recordOutcome) return;
      const outcome = await global.AAA_DATA.recordOutcome(jobId, result, { source: 'manual' });
      if (global.AAA_SUPERVISOR && global.AAA_SUPERVISOR.scoreOutcome) {
        try { await global.AAA_SUPERVISOR.scoreOutcome(outcome); } catch (_) {}
      }
    },

    async _askAITeam(job) {
      const ui = UI();
      const os = global.AAA_AGENT_OS;
      const s = ui.sheet({ title: 'AI Team Review', subtitle: (job.customerName || 'Job') + ' — CEO + sub-agents' });
      document.body.appendChild(s.overlay);

      if (!os || !os.isReady || !os.isReady()) {
        s.body.appendChild(ui.el('p', { className: 'aaa-dialog__message', text:
          'The AI team needs the server-side Claude proxy configured (Supabase URL + anon key + workspace id, and ANTHROPIC_API_KEY on the proxy). See SETUP.md, then try again.' }));
        return;
      }

      s.body.appendChild(ui.spinner('The team is reviewing this job…'));
      const context = {
        jobId: job.id, customerName: job.customerName, serviceAddress: job.serviceAddress,
        state: job.currentState, scheduledDate: job.scheduledDate, notes: job.notes,
        estimates: Array.isArray(job.estimates) ? job.estimates : [],
        logCount: Array.isArray(job.logs) ? job.logs.length : 0
      };
      const result = await os.runMeeting('How should we win this job profitably, and what should happen next?', context, ['sales', 'operations', 'accounting']);

      s.body.innerHTML = '';
      if (!result || !result.ok) {
        s.body.appendChild(ui.el('p', { className: 'aaa-dialog__message', text: 'AI meeting could not complete (' + ((result && result.error) || 'unknown') + ').' }));
        return;
      }
      const d = result.decision;
      const conf = d.confidence != null ? d.confidence + '%' : '—';
      s.body.appendChild(ui.el('div', { className: 'vision-row' }, [
        ui.el('span', { className: 'vision-row__k', text: 'CEO decision' }),
        ui.statusBadge('Confidence ' + conf, d.confidence >= 70 ? '#10B981' : d.confidence >= 40 ? '#F59E0B' : '#EF4444')
      ]));
      s.body.appendChild(ui.el('p', { className: 'aaa-dialog__message', html: '<strong>' + esc(d.recommendation) + '</strong>' }));
      if (d.rationale) s.body.appendChild(ui.el('p', { className: 'aaa-detail-notes', text: d.rationale }));
      if (Array.isArray(d.next_actions) && d.next_actions.length) {
        s.body.appendChild(ui.el('h2', { className: 'aaa-section-title', text: 'Next actions' }));
        d.next_actions.forEach((a) => s.body.appendChild(ui.el('div', { className: 'aaa-list-row', text: a })));
      }
      if (Array.isArray(result.opinions) && result.opinions.length) {
        s.body.appendChild(ui.el('h2', { className: 'aaa-section-title', text: 'Team input' }));
        result.opinions.forEach((o) => s.body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
          '<strong>' + esc(o.title) + '</strong> · ' + (o.confidence != null ? o.confidence + '%' : '—') +
          '<div class="aaa-list-sub">' + esc(o.recommendation || '') + '</div>' })));
      }
      this.render(); // reflect any new logged decisions
    },

    async _onNewJob() {
      const flow = global.AAA_NEW_JOB_FLOW_UI;
      if (!flow || !flow.open) return;
      const job = await flow.open();
      if (job) this.view = { name: 'detail', jobId: job.id };
      this.render();
    },

    _reRenderWhenHudCloses(hudId) {
      if (this._hudPoll) clearInterval(this._hudPoll);
      let ticks = 0;
      this._hudPoll = setInterval(() => {
        ticks++;
        const node = document.getElementById(hudId);
        let closed;
        if (!node) closed = true;
        else if (hudId === 'closure-hud') closed = node.classList.contains('hidden');
        else closed = !node.classList.contains('visible');
        if (closed || ticks > 600) { clearInterval(this._hudPoll); this._hudPoll = null; this.render(); }
      }, 400);
    }
  };

  function esc(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function formatDate(value) {
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ', ' +
      d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  function formatDateTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  global.AAA_JOB_LIST_UI = APP;
})(typeof window !== 'undefined' ? window : this);
