/* Quote Builder v1: deterministic, offline-capable inputs → priced draft.
 * The existing measurement pricing engine owns service rules. Agents may
 * propose separate drafts; revisions, review and sharing remain human actions.
 */
;(function (global) {
  'use strict';
  const VERSION = 1;
  const WORKING = 'quote_builder_working';
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const engine = () => global.AAA_MEASUREMENT_QUOTE;
  const store = () => global.AAA_QUOTES;
  const ws = () => (global.AAA_CONFIG || {}).workspaceId || 'default';
  const money = (v) => '$' + Number(v).toFixed(2);
  const cents = (v) => Math.round((v + Number.EPSILON) * 100);
  const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);
  function fail(error, message) { return { ok: false, error: error, message: message || error }; }
  function number(v, label, max, optional) {
    if (optional && (v == null || v === '')) return 0;
    if (!['string', 'number'].includes(typeof v) || String(v).trim() === '') throw new Error(label + ' is required.');
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > (max || 1000000)) throw new Error(label + ' must be a valid, non-negative number.');
    return n;
  }
  function count(v, label, fallback) {
    const n = number(v == null ? fallback : v, label, 1000);
    if (n < 1 || !Number.isInteger(n)) throw new Error(label + ' must be a whole number of at least 1.');
    return n;
  }
  function snapshot(raw) {
    const r = {};
    Object.keys(engine().defaultRates()).concat(['shampoo_min_per_room']).forEach((key) => {
      r[key] = number(raw[key] == null && key === 'shampoo_min_per_room' ? 45 : raw[key], key);
    });
    if (r.waste_factor > 1 || r.range_spread > 1) throw new Error('Waste and range percentages must be between 0 and 100.');
    if (r.shampoo_min_per_room < engine().rules().SHAMPOO_HARD_FLOOR_PER_ROOM) throw new Error('The cleaning minimum must be at least $45 per room.');
    return r;
  }
  function fresh() {
    return { version: VERSION, customer: { name: '', phone: '', email: '', address: '' }, jobId: null,
      lines: [], rateSnapshot: clone(engine().currentRates()), note: '' };
  }

  function preview(input) {
    try {
      if (!input || input.version !== VERSION) return fail('UNSUPPORTED_VERSION', 'This quote format is not supported.');
      if (!engine()) return fail('NO_PRICING_ENGINE');
      const customer = input.customer || {};
      const normalized = { version: VERSION, customer: {}, jobId: text(input.jobId) || null,
        lines: [], rateSnapshot: snapshot(input.rateSnapshot || engine().currentRates()), note: text(input.note, 2000) };
      ['name', 'phone', 'email', 'address'].forEach((k) => { normalized.customer[k] = text(customer[k], k === 'address' ? 500 : 200); });
      if (customer.id) normalized.customer.id = text(customer.id);
      if (!normalized.customer.name) return fail('CUSTOMER_REQUIRED', 'Enter the customer name.');
      if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 100) return fail('LINES_REQUIRED', 'Add between 1 and 100 service lines.');
      const lines = [], sessions = [];
      const warnings = ['Check the rates below before approval. Your rate snapshot is kept with this quote.'];
      input.lines.forEach((raw, index) => {
        const label = 'Line ' + (index + 1);
        if (!raw || typeof raw !== 'object') throw new Error(label + ' is invalid.');
        const serviceId = raw.serviceId;
        const row = { serviceId: serviceId, description: text(raw.description, 200) };
        let priced;
        if (serviceId === 'manual') {
          if (!row.description) throw new Error(label + ': describe the work.');
          row.quantity = number(raw.quantity, label + ' quantity', 100000);
          row.unitPrice = number(raw.unitPrice, label + ' unit price');
          if (!row.quantity || !row.unitPrice) throw new Error(label + ': quantity and price must be greater than zero.');
          priced = { serviceId: 'manual', label: row.description, basis: row.quantity + ' × ' + money(row.unitPrice),
            subtotal: cents(row.quantity * row.unitPrice) / 100, _labor: 0, _material: 0, _ruleNotes: [], estimatedTimeMins: 0 };
          warnings.push('Manual line: verify the price and scope. Cost and margin are not established by a selling price.');
        } else {
          if (!Object.prototype.hasOwnProperty.call(engine().SERVICES, serviceId)) throw new Error(label + ': choose a valid service.');
          const svc = engine().SERVICES[serviceId];
          row.length = number(raw.length, label + ' length', 10000, true);
          row.width = number(raw.width, label + ' width', 10000, true);
          // Preserve explicitly entered/imported area separately from dimensions.
          // Clearing dimensions must not silently reuse their previous product.
          row.squareFeet = number(raw.squareFeet, label + ' area', 1000000, true);
          const area = row.length && row.width ? row.length * row.width : row.squareFeet;
          if (!!row.length !== !!row.width) throw new Error(label + ': enter both length and width.');
          row.linearFeet = number(raw.linearFeet, label + ' linear feet', 100000, true);
          row.stairsCount = number(raw.stairsCount, label + ' stair count', 1000, true);
          if (!Number.isInteger(row.stairsCount)) throw new Error(label + ': stairs must be a whole number.');
          row.rooms = count(raw.rooms, label + ' rooms', 1);
          row.units = count(raw.units, label + ' units', 1);
          if (svc.kind === 'area' && serviceId !== 'carpet_shampoo' && !area) throw new Error(label + ': enter the room dimensions or area.');
          if (svc.kind === 'linear' && !row.linearFeet) throw new Error(label + ': enter the repair length.');
          if (svc.kind === 'stairs' && !row.stairsCount) throw new Error(label + ': enter the stair count.');
          const rates = Object.assign({}, normalized.rateSnapshot);
          if (svc.material) {
            ['materialRate', 'padRate'].forEach((key) => {
              if (raw[key] != null) row[key] = number(raw[key], label + (key === 'materialRate' ? ' carpet price' : ' padding price'));
            });
            row.carpetName = text(raw.carpetName);
            row.padName = text(raw.padName);
            if (row.materialRate != null) rates.material_per_sqft = row.materialRate;
            if (row.padRate != null) rates.pad_per_sqft = row.padRate;
          }
          const units = svc.kind === 'flat' ? row.units : serviceId === 'carpet_shampoo' ? row.rooms : 1;
          const measures = Array.from({ length: units }, (_, n) => ({ roomName: row.description || svc.label,
            squareFeet: area / units, linearFeet: row.linearFeet / units,
            stairsCount: n === 0 ? row.stairsCount : 0, source: 'manual' }));
          sessions.push(...measures);
          priced = engine().priceService(serviceId, measures, { rates: rates, applyMinimum: false });
          priced.label = svc.label + (row.description ? ' — ' + row.description : '') + (row.carpetName ? ' · ' + row.carpetName : '') + (row.padName ? ' · ' + row.padName : '');
          if (serviceId === 'carpet_shampoo' && !area) priced.basis = row.rooms + ' room' + (row.rooms === 1 ? '' : 's');
        }
        if (!Number.isFinite(priced.subtotal) || priced.subtotal < 0) throw new Error(label + ': invalid calculated amount.');
        priced.subtotal = cents(priced.subtotal) / 100;
        lines.push(priced);
        normalized.lines.push(row);
      });
      let totalCents = lines.reduce((n, line) => n + cents(line.subtotal), 0);
      const minimum = cents(normalized.rateSnapshot.min_job);
      if (totalCents < minimum) {
        lines.push({ serviceId: 'minimum', label: 'Minimum service charge adjustment', basis: '', subtotal: (minimum - totalCents) / 100, _labor: 0, _material: 0, _ruleNotes: ['One trip minimum per quote'], estimatedTimeMins: 0 });
        totalCents = minimum;
      }
      if (!Number.isSafeInteger(totalCents) || totalCents <= 0 || totalCents > 1000000000) throw new Error('The total must be greater than zero and no more than $10,000,000.');
      const quote = { lines: lines, total: totalCents / 100, totalRange: null, needsReview: true,
        _laborTotal: lines.reduce((n, l) => n + cents(l._labor), 0) / 100,
        _materialTotal: lines.reduce((n, l) => n + cents(l._material), 0) / 100 };
      const receipt = engine().toReceipt(quote, { customerName: normalized.customer.name,
        note: normalized.note || 'Estimate — final price confirmed on site.' });
      return { ok: true, input: normalized, sessions: sessions, warnings: Array.from(new Set(warnings)),
        estimate: { ok: true, quote: quote, receipt: receipt, services: normalized.lines.map((l) => l.serviceId),
          reasoning: 'Calculated from the saved measurements and rate snapshot. Human approval required.', needsHumanApproval: true } };
    } catch (e) { return fail('INVALID_INPUT', e.message); }
  }

  async function save(input, opts) {
    const o = opts || {};
    const result = preview(input);
    if (!result.ok) return result;
    const payload = { estimate: result.estimate, customer: result.input.customer, jobId: result.input.jobId,
      sessions: result.sessions, builderInput: result.input, actor: o.actor, origin: o.origin };
    try {
      if (!store() || !global.AAA_RUNTIME_GATEWAY) return fail('NO_QUOTE_STORE');
      if (o.id) return await store().reviseDraft(o.id, payload, o);
      const res = await global.AAA_RUNTIME_GATEWAY.run({ action: 'CREATE_QUOTE_DRAFT', origin: o.origin === 'ai' ? 'ai' : 'human', actor: o.actor,
        detail: { schemaVersion: VERSION }, mutate: () => store().createDraft(payload) });
      return res.ok ? { ok: true, quote: res.result, auditId: res.auditId } : res;
    } catch (e) { return fail('SAVE_FAILED', e.message); }
  }

  async function propose(input, opts) {
    // Model output is data, never an instruction to execute another tool.
    if (!input || !Array.isArray(input.lines)) return fail('INVALID_INPUT');
    if (input.lines.some((l) => !l || l.serviceId === 'manual' || l.materialRate != null || l.padRate != null || l.unitPrice != null)) return fail('AI_PRICE_OVERRIDE_NOT_ALLOWED');
    return save(Object.assign({}, input, { rateSnapshot: engine().currentRates() }), { origin: 'ai', actor: text(opts && opts.actor) || 'estimator' });
  }

  function receiptText(q) {
    const r = store().customerView(q);
    return [r.businessName, 'ESTIMATE · ' + q.id, 'Customer: ' + r.customerName, '',
      ...r.items.map((it) => it.description + '  ' + money(it.amount)), '', 'TOTAL ' + money(r.total), '', r.note].join('\n');
  }

  async function prepareShare(id, opts) {
    const o = opts || {};
    if (o.origin === 'ai') return fail('AI_NOT_PERMITTED');
    if (!global.AAA_RBAC || !global.AAA_RBAC.can('APPROVE_QUOTE')) return fail('FORBIDDEN');
    const q = await store().get(id);
    if (!q) return fail('NOT_FOUND');
    if (o.expectedRevision !== (q.revision || 1)) return fail('REVISION_CONFLICT', 'This quote changed. Reopen it before sharing.');
    if (!['reviewed', 'sent', 'follow_up_due'].includes(q.status) || !q.review || !q.review.reviewedAt) return fail('NEEDS_REVIEW');
    const content = receiptText(q), subject = 'AAA Carpet estimate for ' + q.customerName;
    const contact = q.customerContact || {};
    const phone = String(contact.phone || '').replace(/[\s().-]/g, '');
    const email = String(contact.email || '');
    return { ok: true, quoteId: id, status: q.status, revision: q.revision || 1, text: content, subject: subject,
      smsUrl: /^\+?\d{7,15}$/.test(phone) ? 'sms:' + phone + '?body=' + encodeURIComponent(content) : null,
      emailUrl: /^[^\s@,;?&#]+@[^\s@,;?&#]+\.[^\s@,;?&#]+$/.test(email) ? 'mailto:' + encodeURIComponent(email) + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(content) : null };
  }

  function workingKey() {
    return global.AAA_ID_FACTORY ? global.AAA_ID_FACTORY.createId('quote_form') : 'form_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  }
  async function saveWorking(value) {
    const local = global.AAA_LOCAL_FIRST_STORAGE;
    if (!local) throw new Error('Device storage unavailable.');
    const workspaceId = ws();
    const current = await local.get(WORKING, workspaceId);
    // Preserve the single-slot form written by earlier versions on first use.
    if (current && current.value && !current.activeKey) {
      const legacy = { workspaceId: workspaceId, workingKey: 'legacy', value: clone(current.value), updatedAt: new Date().toISOString() };
      await local.put(WORKING, workspaceId + ':legacy', legacy, { requirePersistent: true });
    }
    const key = value.workingKey || 'legacy';
    const record = { workspaceId: workspaceId, workingKey: key, value: clone(value), updatedAt: new Date().toISOString() };
    await local.put(WORKING, workspaceId + ':' + key, record, { requirePersistent: true });
    await local.put(WORKING, workspaceId, { workspaceId: workspaceId, activeKey: key, value: clone(value) }, { requirePersistent: true });
    return key;
  }
  async function loadWorking(key) {
    const local = global.AAA_LOCAL_FIRST_STORAGE;
    const rec = local && await local.get(WORKING, key ? ws() + ':' + key : ws());
    return rec && rec.workspaceId === ws() ? Object.assign(clone(rec.value), { workingKey: rec.workingKey || rec.activeKey || 'legacy' }) : null;
  }
  async function listWorking() {
    const local = global.AAA_LOCAL_FIRST_STORAGE;
    if (!local) return [];
    const records = await local.getAll(WORKING);
    return records.filter((r) => r && r.workspaceId === ws() && r.workingKey && r.value && r.value.dirty !== false && r.value.input &&
      (r.value.input.customer && Object.values(r.value.input.customer).some(Boolean) || r.value.input.lines && r.value.input.lines.length || r.value.input.note))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map((r) => ({ key: r.workingKey, input: clone(r.value.input), updatedAt: r.updatedAt }));
  }
  async function scopedMeasurements(context) {
    const c = context || {}, measurements = global.AAA_MEASUREMENT_STORE;
    let rooms = [];
    if (c.fieldSessionId) {
      const capture = global.AAA_FIELD_CAPTURE_SESSION;
      if (!capture) throw new Error('Capture session unavailable. Reopen measurement capture.');
      rooms = await capture.rooms(c.fieldSessionId);
    } else if (c.jobId) rooms = await measurements.listSessions({ jobId: c.jobId });
    else {
      for (const id of c.sessionIds || []) { const room = await measurements.getSession(id); if (room) rooms.push(room); }
    }
    return rooms.filter((r) => r && !r.deleted && (r.workspaceId == null || r.workspaceId === ws()));
  }
  function fromMeasurements(sessions, services, context) {
    const input = fresh(), c = context || {};
    input.jobId = c.jobId || null;
    input.customer = Object.assign(input.customer, c.customer || {});
    const selected = (services || ['carpet_install']).slice();
    if ((sessions || []).some((s) => s.stairsCount > 0) && !selected.includes('stairs')) selected.push('stairs');
    selected.forEach((serviceId) => {
      const svc = engine().SERVICES[serviceId];
      const relevant = (sessions || []).filter((s) => s && svc && (svc.kind === 'stairs' ? s.stairsCount > 0 : svc.kind === 'linear' ? s.linearFeet > 0 : svc.kind === 'area' ? s.squareFeet > 0 : true));
      if (!relevant.length) input.lines.push({ serviceId: serviceId, description: '' });
      relevant.forEach((s) => input.lines.push({ serviceId: serviceId, description: s.roomName || '', squareFeet: s.squareFeet || 0,
        linearFeet: s.linearFeet || 0, stairsCount: s.stairsCount || 0, rooms: 1, units: 1 }));
    });
    return input;
  }
  global.AAA_QUOTE_BUILDER = { VERSION: VERSION, fresh: fresh, preview: preview, save: save, propose: propose,
    prepareShare: prepareShare, receiptText: receiptText, workingKey: workingKey, saveWorking: saveWorking, loadWorking: loadWorking, listWorking: listWorking, fromMeasurements: fromMeasurements, scopedMeasurements: scopedMeasurements };
})(typeof window !== 'undefined' ? window : this);
