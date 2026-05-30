/*
 * AAA Job List UI — application shell
 *
 * This is the screen the operator lives in. It renders two views inside the
 * #app-root container — a list of jobs grouped by lifecycle state, and a
 * per-job detail view — and wires each job into the three On-Site Sidekick
 * HUDs (Voice, Vision, Closure).
 *
 * The Voice HUD's floating action button is mounted once on document.body so
 * it survives re-renders of #app-root; entering a job updates its active job
 * id. All reads come from local-first storage, so re-rendering always reflects
 * the latest persisted state (including changes made from inside a HUD).
 */
;(function (global) {
  'use strict';

  // Lifecycle states, in display order, with labels + accent colours.
  const STATES = [
    { key: 'IN_PROGRESS', label: 'In Progress', color: '#7f5af0' },
    { key: 'SCHEDULED', label: 'Scheduled', color: '#ffab00' },
    { key: 'QUOTE_OPEN', label: 'Quote Open', color: '#57c7ff' },
    { key: 'CLOSED', label: 'Closed', color: '#00ff9d' }
  ];
  const STATE_MAP = STATES.reduce((m, s) => ((m[s.key] = s), m), {});

  const UI = {
    containerId: 'app-root',
    view: { name: 'list', jobId: null },
    _hudPoll: null,

    async boot() {
      this.storage = global.AAA_LOCAL_FIRST_STORAGE;
      await this._seedIfEmpty();
      this._mountVoiceHud();
      // Re-render when returning to the app (e.g. after a HUD action or
      // switching back to the tab) so state changes show up immediately.
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

    async _getJob(id) {
      return this.storage.get('jobs', id);
    },

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
          entityId: id,
          entityType: 'job',
          operation: 'SET_STATE',
          payload: { currentState: nextState },
          timestamp: clock ? clock.nowISO() : new Date().toISOString(),
          syncStatus: 'PENDING'
        });
      }
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
            {
              cust: { name: 'Marina Bay Offices', address: '120 Harbour Dr, Suite 400', phone: '555-0142', gateCode: '#4821' },
              job: { scheduledDate: this._isoLocalIn(2), currentState: 'SCHEDULED', notes: 'Lobby + 3 conference rooms, commercial loop pile.' }
            },
            {
              cust: { name: 'The Henderson Residence', address: '88 Maple Court', phone: '555-0199', gateCode: '' },
              job: { currentState: 'QUOTE_OPEN', notes: 'Stair runner re-stretch, possible seam repair on landing.' }
            }
          ];
          for (const s of samples) {
            const customer = customerStore ? await customerStore.add(s.cust) : { id: null, name: s.cust.name, address: s.cust.address };
            const job = await flow.buildJobRecord({
              customerId: customer.id,
              customerName: customer.name,
              serviceAddress: customer.address,
              gateCode: customer.gateCode || null,
              scheduledDate: s.job.scheduledDate || null,
              notes: s.job.notes,
              currentState: s.job.currentState
            });
            await flow.saveJob(job);
          }
        }
        await this.storage.put('meta', 'seeded', true);
      } catch (err) {
        console.warn('Job list: seeding skipped', err);
      }
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
        '<p id="voice-transcript" class="voice-text"></p>' +
        '</div>' +
        '<button id="voice-fab" class="voice-fab" title="Voice log" aria-label="Voice log">🎤</button>';
      document.body.appendChild(hud);
      if (global.AAA_VOICE_HUD_UI && global.AAA_VOICE_HUD_UI.boot) {
        global.AAA_VOICE_HUD_UI.boot({ jobId: null });
      }
    },

    _setActiveVoiceJob(jobId) {
      const voice = global.AAA_VOICE_HUD_UI;
      if (voice && voice.updateJobId) voice.updateJobId(jobId);
    },

    // ---- rendering --------------------------------------------------------

    async render(containerId) {
      if (containerId) this.containerId = containerId;
      const root = document.getElementById(this.containerId);
      if (!root) return;
      if (this.view.name === 'detail' && this.view.jobId) {
        await this._renderDetail(root);
      } else {
        await this._renderList(root);
      }
    },

    async _renderList(root) {
      this._setActiveVoiceJob(null);
      const jobs = await this._allJobs();

      const header = this._header('AAA HyperKernel', null);
      const newBtn = document.createElement('button');
      newBtn.className = 'aaa-btn aaa-btn-primary aaa-new-job';
      newBtn.textContent = '+ New Job';
      newBtn.addEventListener('click', () => this._onNewJob());
      header.querySelector('.aaa-header-actions').appendChild(newBtn);

      const main = document.createElement('main');
      main.className = 'aaa-main';

      if (jobs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'aaa-empty-state';
        empty.innerHTML = '<p>No jobs yet.</p><p class="aaa-empty-sub">Tap “+ New Job” to get started.</p>';
        main.appendChild(empty);
      } else {
        STATES.forEach((s) => {
          const group = jobs.filter((j) => (j.currentState || 'QUOTE_OPEN') === s.key);
          if (group.length === 0) return;
          const section = document.createElement('section');
          section.className = 'aaa-group';
          const h = document.createElement('h2');
          h.className = 'aaa-group-title';
          h.innerHTML = `<span class="aaa-dot" style="background:${s.color}"></span>${s.label} <span class="aaa-count">${group.length}</span>`;
          section.appendChild(h);
          group.forEach((job) => section.appendChild(this._jobCard(job)));
          main.appendChild(section);
        });
      }

      root.innerHTML = '';
      root.appendChild(header);
      root.appendChild(main);
    },

    _jobCard(job) {
      const s = STATE_MAP[job.currentState] || STATE_MAP.QUOTE_OPEN;
      const card = document.createElement('button');
      card.className = 'aaa-card';
      card.type = 'button';
      const logs = Array.isArray(job.logs) ? job.logs.length : 0;
      const estimates = Array.isArray(job.estimates) ? job.estimates.length : 0;
      card.innerHTML =
        `<div class="aaa-card-top">` +
        `<span class="aaa-card-name">${esc(job.customerName || 'Unnamed job')}</span>` +
        `<span class="aaa-badge" style="color:${s.color};border-color:${s.color}">${s.label}</span>` +
        `</div>` +
        (job.serviceAddress ? `<div class="aaa-card-sub">${esc(job.serviceAddress)}</div>` : '') +
        `<div class="aaa-card-meta">` +
        (job.scheduledDate ? `<span>🗓 ${esc(formatDate(job.scheduledDate))}</span>` : '<span>No schedule</span>') +
        (logs ? `<span>📝 ${logs}</span>` : '') +
        (estimates ? `<span>📐 ${estimates}</span>` : '') +
        `</div>`;
      card.addEventListener('click', () => {
        this.view = { name: 'detail', jobId: job.id };
        this.render();
      });
      return card;
    },

    async _renderDetail(root) {
      const job = await this._getJob(this.view.jobId);
      if (!job) {
        this.view = { name: 'list', jobId: null };
        return this._renderList(root);
      }
      this._setActiveVoiceJob(job.id);
      const s = STATE_MAP[job.currentState] || STATE_MAP.QUOTE_OPEN;

      const header = this._header(job.customerName || 'Job', () => {
        this.view = { name: 'list', jobId: null };
        this.render();
      });

      const main = document.createElement('main');
      main.className = 'aaa-main';

      // Summary card
      const summary = document.createElement('section');
      summary.className = 'aaa-detail-summary';
      summary.innerHTML =
        `<span class="aaa-badge" style="color:${s.color};border-color:${s.color}">${s.label}</span>` +
        (job.serviceAddress ? `<p class="aaa-detail-line">📍 ${esc(job.serviceAddress)}</p>` : '') +
        (job.scheduledDate ? `<p class="aaa-detail-line">🗓 ${esc(formatDate(job.scheduledDate))}</p>` : '') +
        (job.gateCode ? `<p class="aaa-detail-line">🔑 Gate ${esc(job.gateCode)}</p>` : '') +
        (job.notes ? `<p class="aaa-detail-notes">${esc(job.notes)}</p>` : '');
      main.appendChild(summary);

      // Action buttons
      const actions = document.createElement('div');
      actions.className = 'aaa-detail-actions';

      if (job.currentState !== 'IN_PROGRESS' && job.currentState !== 'CLOSED') {
        actions.appendChild(this._actionBtn('▶ Start Job', 'aaa-btn-primary', async () => {
          await this._setJobState(job.id, 'IN_PROGRESS');
          this.render();
        }));
      }
      actions.appendChild(this._actionBtn('📐 Vision Estimate', 'aaa-btn-accent', () => {
        if (global.AAA_VISION_HUD_UI && global.AAA_VISION_HUD_UI.boot) {
          global.AAA_VISION_HUD_UI.boot({ jobId: job.id });
          this._reRenderWhenHudCloses('vision-hud');
        }
      }));
      if (job.currentState !== 'CLOSED') {
        actions.appendChild(this._actionBtn('✓ Close Job', 'aaa-btn-success', () => {
          if (global.AAA_CLOSURE_HUD_UI && global.AAA_CLOSURE_HUD_UI.boot) {
            global.AAA_CLOSURE_HUD_UI.boot({ jobId: job.id });
            this._reRenderWhenHudCloses('closure-hud');
          }
        }));
      } else {
        actions.appendChild(this._actionBtn('↺ Reopen', 'aaa-btn-ghost', async () => {
          await this._setJobState(job.id, 'IN_PROGRESS');
          this.render();
        }));
      }
      main.appendChild(actions);

      const hint = document.createElement('p');
      hint.className = 'aaa-voice-hint';
      hint.textContent = 'Tip: tap the 🎤 button to log a hands-free voice note.';
      main.appendChild(hint);

      // Estimates
      if (Array.isArray(job.estimates) && job.estimates.length) {
        main.appendChild(this._sectionTitle('Estimates'));
        job.estimates.forEach((e) => {
          const row = document.createElement('div');
          row.className = 'aaa-list-row';
          row.innerHTML =
            `<strong>${esc(e.type || 'Estimate')}</strong>` +
            (e.estimatedTimeMins ? ` · ${esc(String(e.estimatedTimeMins))} mins` : '') +
            (Array.isArray(e.materials) && e.materials.length ? `<div class="aaa-list-sub">${esc(e.materials.join(', '))}</div>` : '');
          main.appendChild(row);
        });
      }

      // Logs
      if (Array.isArray(job.logs) && job.logs.length) {
        main.appendChild(this._sectionTitle('Work Log'));
        job.logs
          .slice()
          .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
          .forEach((l) => {
            const row = document.createElement('div');
            row.className = 'aaa-list-row';
            row.innerHTML =
              `<div>${esc(l.text || '')}</div>` +
              `<div class="aaa-list-sub">${esc(formatDateTime(l.timestamp))}${l.type ? ' · ' + esc(l.type) : ''}</div>`;
            main.appendChild(row);
          });
      }

      root.innerHTML = '';
      root.appendChild(header);
      root.appendChild(main);
    },

    // ---- small builders ---------------------------------------------------

    _header(title, onBack) {
      const header = document.createElement('header');
      header.className = 'aaa-header';
      const left = document.createElement('div');
      left.className = 'aaa-header-left';
      if (onBack) {
        const back = document.createElement('button');
        back.className = 'aaa-back';
        back.setAttribute('aria-label', 'Back');
        back.textContent = '‹';
        back.addEventListener('click', onBack);
        left.appendChild(back);
      }
      const h1 = document.createElement('h1');
      h1.className = 'aaa-title';
      h1.textContent = title;
      left.appendChild(h1);
      header.appendChild(left);
      const actions = document.createElement('div');
      actions.className = 'aaa-header-actions';
      header.appendChild(actions);
      return header;
    },

    _actionBtn(label, variant, onClick) {
      const b = document.createElement('button');
      b.className = 'aaa-btn ' + variant;
      b.textContent = label;
      b.addEventListener('click', onClick);
      return b;
    },

    _sectionTitle(text) {
      const h = document.createElement('h2');
      h.className = 'aaa-section-title';
      h.textContent = text;
      return h;
    },

    async _onNewJob() {
      const flow = global.AAA_NEW_JOB_FLOW_UI;
      if (!flow || !flow.open) return;
      const job = await flow.open();
      if (job) {
        this.view = { name: 'detail', jobId: job.id };
      }
      this.render();
    },

    // Poll until a self-dismissing HUD overlay closes, then refresh once so
    // estimates/notes/closed-state added inside it appear in the detail view.
    _reRenderWhenHudCloses(hudId) {
      if (this._hudPoll) clearInterval(this._hudPoll);
      let ticks = 0;
      this._hudPoll = setInterval(() => {
        ticks++;
        const node = document.getElementById(hudId);
        // closure-hud toggles a 'hidden' class; vision-hud toggles 'visible'.
        let closed;
        if (!node) closed = true;
        else if (hudId === 'closure-hud') closed = node.classList.contains('hidden');
        else closed = !node.classList.contains('visible');
        if (closed || ticks > 600) {
          clearInterval(this._hudPoll);
          this._hudPoll = null;
          this.render();
        }
      }, 400);
    }
  };

  // --- formatting + escaping helpers ---
  function esc(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function formatDate(value) {
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
      ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  function formatDateTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  global.AAA_JOB_LIST_UI = UI;
})(typeof window !== 'undefined' ? window : this);
