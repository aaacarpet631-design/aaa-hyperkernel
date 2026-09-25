/* The existing mobile chat, with a task composer and real action receipts. */
;(function (global) {
  'use strict';
  function el(tag, cls, text) { const node = document.createElement(tag); if (cls) node.className = cls; if (text) node.textContent = text; return node; }
  const agent = () => global.AAA_TASK_AGENT;
  const renderer = () => global.AAA_RICH_CARD_RENDERER;

  function mount(ui, root, opts) {
    const o = opts || {}, runs = new Map();
    const wrap = el('section', 'cc-root task-chat');
    const introduction = el('div', 'task-intro');
    introduction.append(el('h2', '', 'What would you like done?'), el('p', '', 'Analyze your business, work with files, run scenarios, or use your connected tools.'));
    const capabilities = el('details', 'task-capabilities'), capTitle = el('summary', '', 'Tools and skills'), capBody = el('div', 'task-cap-body', 'Checking availability…');
    capabilities.append(capTitle, capBody);
    const thread = el('div', 'cc-thread'); thread.setAttribute('aria-label', 'Conversation');
    const suggestions = el('div', 'task-suggestions');
    const replay = el('button', 'task-replay', 'Send queued messages'); replay.type = 'button'; replay.hidden = true;
    ['Find gaps in my open jobs', 'Summarize an attached file', 'Show what you remember'].forEach(text => {
      const button = el('button', '', text); button.type = 'button'; button.onclick = () => { input.value = text; input.focus(); }; suggestions.append(button);
    });
    const composer = el('form', 'task-composer');
    const input = el('textarea', 'cc-input'); input.rows = 3; input.maxLength = 16000; input.placeholder = 'Describe the result you want…'; input.setAttribute('aria-label', 'Your request');
    const options = el('div', 'task-options'), mode = el('select'); mode.setAttribute('aria-label', 'Chat mode');
    const modelSelect = el('select', 'task-model'); modelSelect.setAttribute('aria-label', 'AI model');
    const automatic = el('option', '', 'Automatic model'); automatic.value = ''; modelSelect.append(automatic);
    [['task', 'Task assistant'], ['briefing', 'Business briefings']].forEach(v => { const option = el('option', '', v[1]); option.value = v[0]; mode.append(option); });
    const shareLabel = el('label'), share = el('input'); share.type = 'checkbox'; share.checked = false; shareLabel.append(share, document.createTextNode(' Include business snapshot'));
    const fileLabel = el('label', 'task-attach', 'Attach text / data files');
    const fileInput = el('input'); fileInput.type = 'file'; fileInput.multiple = true; fileInput.accept = '.txt,.md,.csv,.json,.js,.py,.html,.css,.sql,.yaml'; fileLabel.append(fileInput);
    const attachments = el('div', 'task-attachments');
    fileInput.onchange = () => { attachments.textContent = Array.from(fileInput.files || []).map(f => f.name).join(', '); };
    const send = el('button', 'cc-send', 'Run task'); send.type = 'submit'; send.disabled = true;
    const pause = el('button', 'task-pause', 'Pause'); pause.type = 'button'; pause.hidden = true;
    const status = el('p', 'task-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    options.append(mode, modelSelect, shareLabel); composer.append(input, options, fileLabel, attachments, send, pause, status);
    wrap.append(introduction, capabilities, thread, replay, suggestions, composer); root.append(wrap);
    let busy = false, control = { stop: false };

    function setBusy(value) {
      busy = value; send.disabled = value; replay.disabled = value; pause.hidden = !value; input.disabled = value; mode.disabled = value; modelSelect.disabled = value; fileInput.disabled = value; share.disabled = value;
      wrap.querySelectorAll('[data-task-action]').forEach(b => { b.disabled = value; });
    }
    function paint(node, card) {
      node.innerHTML = renderer().html(card);
      if (card.run) runs.set(card.run.id, card.run);
      node.querySelectorAll('[data-task-action]').forEach(b => { b.disabled = busy; });
    }
    async function saveProgress(run, node) {
      paint(node, agent().card(run));
      status.textContent = run.status === 'running' ? 'Working… ' + (run.receipts || []).length + ' tool results received.' : '';
      const store = global.AAA_CHAT_MESSAGE_STORE;
      if (store) {
        const message = (await store.thread(o.threadId)).find(m => m.card && m.card.run && m.card.run.id === run.id);
        if (message) await store.update(message.id, { card: agent().card(run), text: run.text || ('Task ' + run.status) });
      }
    }
    async function loadCapabilities() {
      try {
        const cap = await agent().capabilities();
        capBody.textContent = '';
        capBody.append(el('p', '', cap.models.length ? 'AI provider configured. Files, calculations, simulations, business snapshots and saved lessons are available.' : 'AI provider setup is needed before tasks can run.'));
        modelSelect.replaceChildren(automatic);
        (cap.modelCatalog || cap.models.map(id => ({ id: id, label: id, configured: true }))).forEach(m => {
          const option = el('option', '', m.label + (m.configured ? '' : ' — needs ' + m.provider + ' key'));
          option.value = m.id; option.disabled = !m.configured; modelSelect.append(option);
        });
        const preferred = global.AAA_CONFIG && global.AAA_CONFIG.flag && global.AAA_CONFIG.flag('taskModel', '');
        if (cap.models.includes(preferred)) modelSelect.value = preferred;
        capBody.append(el('p', '', 'Open-weight choices: MiMo-V2.6-Pro (MIT), GLM-5.3 and Kimi K3 (custom licenses). Hosted API usage is billed by the provider.'));
        capBody.append(el('p', '', cap.skills.length + ' skills · ' + cap.memoryCount + ' saved lessons and simulation records'));
        capBody.append(el('p', '', 'Research: ' + (cap.researchConfigured ? 'configured' : 'not connected')));
        const connections = cap.connections.map(c => c.label + ': ' + (c.configured ? 'configured; checked when used' : 'credentials needed'));
        capBody.append(el('p', '', connections.length ? connections.join(' · ') : 'External tools: no connections configured.'));
      } catch (e) { capBody.textContent = e.message; }
    }
    mode.onchange = () => { send.textContent = mode.value === 'task' ? 'Run task' : 'Ask'; fileLabel.hidden = mode.value !== 'task'; shareLabel.hidden = mode.value !== 'task'; modelSelect.hidden = mode.value !== 'task'; };
    modelSelect.onchange = () => { if (global.AAA_CONFIG && global.AAA_CONFIG.set) global.AAA_CONFIG.set({ taskModel: modelSelect.value }); };
    pause.onclick = () => { control.stop = true; status.textContent = 'Pausing after the current action finishes…'; pause.disabled = true; };
    composer.onsubmit = async event => {
      event.preventDefault(); const text = input.value.trim();
      if (!text || busy) return;
      let files;
      try { files = mode.value === 'task' ? await agent().files(fileInput.files) : []; } catch (e) { status.textContent = e.message; return; }
      const user = el('div', 'cc-msg cc-user', text), answer = el('div', 'cc-msg cc-assistant');
      thread.append(user, answer); input.value = ''; control = { stop: false }; pause.disabled = false;
      setBusy(true); status.textContent = 'Starting…';
      try {
        const result = await ui.chatSend(text, Object.assign({}, o, { agentTask: mode.value === 'task', model: modelSelect.value, shareBusiness: share.checked, files: files, control: control, onProgress: run => saveProgress(run, answer) }));
        if (result.card) paint(answer, result.card);
        else answer.textContent = result.queued ? 'Queued offline. Use Send queued messages when online.' : result.error || 'No response.';
        if (result.queued) replay.hidden = false;
        fileInput.value = ''; attachments.textContent = '';
        status.textContent = control.stop ? 'Paused. Use Refresh / resume to continue.' : '';
      } catch (e) { status.textContent = e.message || 'Task failed.'; if (!answer.textContent) answer.textContent = status.textContent; }
      finally { setBusy(false); input.focus(); thread.scrollTop = thread.scrollHeight; }
    };
    input.onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); composer.requestSubmit(); } };
    thread.onclick = async event => {
      const button = event.target.closest('button'); if (!button) return;
      const cardNode = button.closest('[data-task-id]'); if (!cardNode) return;
      const run = runs.get(cardNode.dataset.taskId); if (!run) return;
      if (button.dataset.taskDownload != null) {
        const file = run.artifacts[Number(button.dataset.taskDownload)]; if (!file) return;
        const url = URL.createObjectURL(new Blob([file.content], { type: 'text/plain;charset=utf-8' }));
        const a = el('a'); a.href = url; a.download = file.filename; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); return;
      }
      if (busy || !button.dataset.taskAction) return;
      const action = button.dataset.taskAction, node = cardNode.closest('.cc-msg');
      control = { stop: false }; pause.disabled = false; setBusy(true); status.textContent = 'Checking task…';
      try {
        const stepOpts = { control: control, onProgress: r => saveProgress(r, node) };
        let result;
        if (action === 'approve' || action === 'reject') result = await agent().decide(run, action === 'approve', stepOpts);
        else if (action === 'cancel') result = await agent().cancel(run);
        else result = await agent().resume(run.id, stepOpts);
        await saveProgress(result, node);
      } catch (e) { status.textContent = e.message || 'Task failed.'; }
      finally { setBusy(false); }
    };
    async function loadThread() {
      thread.textContent = ''; runs.clear();
      const model = await ui.chatRenderModel(o);
      for (const message of model.messages) {
        const node = el('div', 'cc-msg cc-' + message.role);
        if (message.card) paint(node, message.card); else node.textContent = message.text;
        thread.append(node);
      }
      if (global.AAA_OFFLINE_CHAT_QUEUE) replay.hidden = !(await global.AAA_OFFLINE_CHAT_QUEUE.pending()).length;
    }
    replay.onclick = async () => {
      if (busy || !global.AAA_CHAT_CANVAS) return;
      setBusy(true); control = { stop: false }; pause.disabled = false;
      try {
        const result = await global.AAA_CHAT_CANVAS.replayQueue({ control: control });
        await loadThread();
        status.textContent = result.offline ? 'Still offline. Your messages are saved.' : result.error ? agent().errorText(result.error) + ' Remaining messages are queued.' : result.replayed + ' messages sent.';
      } catch (e) { status.textContent = e.message; }
      finally { setBusy(false); }
    };
    const ready = (async () => {
      try {
        await loadThread();
      } catch (_) { status.textContent = 'Previous messages could not be loaded.'; }
      send.disabled = false;
      await loadCapabilities();
    })();
    return { mounted: true, ready: ready };
  }
  global.AAA_TASK_CHAT_UI = { mount: mount };
})(typeof window !== 'undefined' ? window : this);
