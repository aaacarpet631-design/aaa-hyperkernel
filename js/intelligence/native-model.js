/*
 * AAA Native Model — HyperKernel's own trained "brain", not a black box.
 *
 * The architecturally-honest analogue of shipping a model like Nemotron: a model
 * you TRAIN on AAA's own outcomes, SERIALIZE to a versioned artifact, and run
 * INFERENCE on — except it is small, deterministic, fully explainable, runs
 * offline in the browser with zero dependencies, and is GOVERNED (a freshly
 * trained model is a candidate until the owner activates it through the
 * Governance Registry — two keys, exactly like promoting a checkpoint).
 *
 * The model is a logistic-regression win-probability predictor fit by real
 * gradient descent (learned weights, not hardcoded rules) over features built
 * from a quote: standardized price + proposed margin, and target-encoded service
 * type / neighborhood / lead source (encodings learned from the data). Every
 * prediction decomposes into per-feature contributions, so it explains itself.
 *
 *   train()           fit a candidate model + honest holdout metrics (no gateway)
 *   promote(id)       file it as a Governance draft (owner activates → production)
 *   predict(quote)    win probability + reasons, from the ACTIVE governed model
 *
 * Deterministic (zero-initialized, fixed iterations — reproducible); null-tolerant.
 */
;(function (global) {
  'use strict';

  const VERSIONS = 'model_versions';
  const ART = 'model';
  const NAME = 'win_predictor';
  const FEATURES = ['bias', 'priceZ', 'marginZ', 'serviceWinRate', 'zipWinRate', 'leadWinRate'];

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function quotes() { return global.AAA_QUOTES; }
  function governance() { return global.AAA_GOVERNANCE; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
  function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
  function serviceKey(q) { const s = Array.isArray(q && q.serviceType) ? q.serviceType.filter(Boolean) : (q && q.serviceType ? [q.serviceType] : []); return s.length ? s.slice().sort().join(' + ') : 'unspecified'; }
  function round(n, d) { const p = Math.pow(10, d || 0); return Math.round(n * p) / p; }

  const Model = {
    VERSIONS: VERSIONS, ART: ART, NAME: NAME, FEATURES: FEATURES,

    /**
     * Train a candidate win-probability model from resolved quotes. Deterministic
     * gradient descent; reports train + holdout metrics honestly. Saves a candidate
     * (no production change). Returns { ok, version, metrics, weights }.
     */
    async train(opts) {
      const o = opts || {};
      const rows = (await resolvedQuotes()).filter((q) => q.customerTotal != null);
      const min = num(cfg().flag ? cfg().flag('modelMinSample', 12) : 12) || 12;
      if (rows.length < min) return { ok: false, error: 'INSUFFICIENT_DATA', need: min, have: rows.length };

      // Deterministic train/holdout split: every 4th record is held out.
      const train = [], test = [];
      rows.forEach((q, i) => (i % 4 === 0 ? test : train).push(q));

      // Encoders are fit on TRAIN ONLY (no leakage into the holdout metric).
      const enc = fitEncoders(train);
      const Xtr = train.map((q) => featurize(q, enc)), ytr = train.map((q) => (q.status === 'won' ? 1 : 0));
      const Xte = test.map((q) => featurize(q, enc)), yte = test.map((q) => (q.status === 'won' ? 1 : 0));

      const iters = num(cfg().flag ? cfg().flag('modelIters', 500) : 500) || 500;
      const lr = num(cfg().flag ? cfg().flag('modelLr', 0.3) : 0.3) || 0.3;
      const l2 = num(cfg().flag ? cfg().flag('modelL2', 0.001) : 0.001) || 0.001;
      const weights = fitLogistic(Xtr, ytr, iters, lr, l2);

      const metrics = {
        trainSample: train.length, holdoutSample: test.length,
        trainAccuracy: accuracy(Xtr, ytr, weights), trainLogLoss: round(logLoss(Xtr, ytr, weights), 4),
        holdoutAccuracy: test.length ? accuracy(Xte, yte, weights) : null, holdoutLogLoss: test.length ? round(logLoss(Xte, yte, weights), 4) : null,
        baseRate: round(enc.baseRate, 3)
      };
      const serialized = { features: FEATURES, weights: weights.map((w) => round(w, 6)), encoders: enc, trainedAt: nowISO(), hyperparams: { iters: iters, lr: lr, l2: l2 } };
      const rec = { id: newId('model'), workspaceId: ws(), name: NAME, status: 'candidate', model: serialized, metrics: metrics, governanceVersionId: null, createdBy: o.actor || null, createdAt: nowISO() };
      await put(VERSIONS, rec);
      return { ok: true, version: rec, metrics: metrics, weights: this.weightTable(serialized) };
    },

    /** Per-feature learned weights as human-readable odds multipliers. */
    weightTable(serialized) {
      if (!serialized || !serialized.weights) return [];
      return FEATURES.map((f, i) => ({ feature: f, weight: serialized.weights[i], oddsMultiplier: round(Math.exp(serialized.weights[i]), 3) })).filter((x) => x.feature !== 'bias');
    },

    async candidates() { return (await data().list(VERSIONS)).filter(mine).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); },
    async getVersion(id) { const r = await data().get(VERSIONS, id); return mine(r) ? r : null; },

    /**
     * Promote a candidate: file it as a Governance draft (artifactType 'model') and
     * propose it. The owner still ACTIVATES it in the Governance Registry — two
     * keys — so a new model never reaches production automatically. Audited there.
     */
    async promote(versionId, opts) {
      const o = opts || {};
      const v = await this.getVersion(versionId); if (!v) return { ok: false, error: 'NOT_FOUND' };
      if (!governance() || !governance().createDraft) return { ok: false, error: 'NO_GOVERNANCE' };
      const draft = await governance().createDraft(ART, NAME, v.model, { actor: o.actor || null, origin: o.origin, notes: 'Trained model candidate ' + versionId + ' (holdout acc ' + (v.metrics.holdoutAccuracy != null ? v.metrics.holdoutAccuracy + '%' : 'n/a') + ')' });
      if (!draft.ok) return draft;
      const prop = await governance().propose(draft.version.id, { actor: o.actor || null, origin: o.origin });
      if (!prop.ok) return prop;
      await put(VERSIONS, Object.assign({}, v, { status: 'promoted', governanceVersionId: draft.version.id }));
      return { ok: true, governanceVersionId: draft.version.id, note: 'Filed as a governance draft + proposed. Activate it in the Governance Registry to make it the live model.' };
    },

    /** The ACTIVE governed model (or null if none is live yet). */
    async activeModel() {
      try { if (governance() && governance().getActive) { const v = await governance().getActive(ART, NAME); if (v && v.content) return typeof v.content === 'string' ? JSON.parse(v.content) : v.content; } } catch (_) {}
      return null;
    },

    /**
     * Predict win probability for a quote, with an explanation. Uses the active
     * governed model; if none is live, optionally previews a candidate (clearly
     * flagged). Read-only — changes nothing.
     */
    async predict(quote, opts) {
      const o = opts || {};
      let serialized = await this.activeModel(); let source = 'active';
      if (!serialized && o.previewVersionId) { const v = await this.getVersion(o.previewVersionId); if (v) { serialized = v.model; source = 'candidate_preview'; } }
      if (!serialized && o.preview) { const cs = await this.candidates(); if (cs.length) { serialized = cs[0].model; source = 'candidate_preview'; } }
      if (!serialized) return { ok: false, error: 'NO_ACTIVE_MODEL', message: 'Train and activate a model first.' };

      const x = featurize(quote || {}, serialized.encoders);
      const contributions = serialized.weights.map((w, i) => ({ feature: FEATURES[i], value: round(x[i], 3), contribution: round(w * x[i], 3) }));
      const z = contributions.reduce((s, c) => s + c.contribution, 0);
      const p = sigmoid(z);
      const reasons = contributions.filter((c) => c.feature !== 'bias' && Math.abs(c.contribution) > 0.01)
        .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
        .slice(0, 4)
        .map((c) => ({ feature: c.feature, effect: c.contribution > 0 ? 'raises' : 'lowers', magnitude: Math.abs(c.contribution), text: explain(c.feature, c.contribution) }));
      return { ok: true, source: source, winProbability: round(p * 100, 1), confidence: round(Math.abs(p - 0.5) * 200, 0), contributions: contributions, reasons: reasons, trainedAt: serialized.trainedAt };
    },

    /** Evaluate a serialized model on the deterministic holdout (honesty check). */
    async evaluate(serialized) {
      if (!serialized) return { ok: false, error: 'NO_MODEL' };
      const rows = (await resolvedQuotes()).filter((q) => q.customerTotal != null);
      const test = rows.filter((q, i) => i % 4 === 0);
      const X = test.map((q) => featurize(q, serialized.encoders)), y = test.map((q) => (q.status === 'won' ? 1 : 0));
      return { ok: true, sample: test.length, accuracy: test.length ? accuracy(X, y, serialized.weights) : null, logLoss: test.length ? round(logLoss(X, y, serialized.weights), 4) : null };
    }
  };

  // ---- feature engineering (encoders learned from data) --------------------
  function fitEncoders(rows) {
    const prices = rows.map((q) => num(q.customerTotal)).filter((v) => v != null);
    const margins = rows.map((q) => num(q.marginPct)).filter((v) => v != null);
    const baseRate = rows.length ? rows.filter((q) => q.status === 'won').length / rows.length : 0.5;
    const targetEnc = (keyFn) => { const g = {}; rows.forEach((q) => { const k = keyFn(q); const e = g[k] || (g[k] = { n: 0, won: 0 }); e.n++; if (q.status === 'won') e.won++; }); const map = {}; Object.keys(g).forEach((k) => { map[k] = g[k].won / g[k].n; }); return map; };
    return {
      priceMean: meanOf(prices), priceStd: stdOf(prices) || 1,
      marginMean: meanOf(margins), marginStd: stdOf(margins) || 1,
      service: targetEnc(serviceKey), zip: targetEnc((q) => q.zip || 'unknown'), lead: targetEnc((q) => q.leadSource || 'unknown'),
      baseRate: baseRate
    };
  }
  function featurize(q, enc) {
    const price = num(q.customerTotal), margin = num(q.marginPct);
    const e = enc || {};
    const svc = (e.service && e.service[serviceKey(q)] != null) ? e.service[serviceKey(q)] : e.baseRate;
    const zip = (e.zip && e.zip[q.zip || 'unknown'] != null) ? e.zip[q.zip || 'unknown'] : e.baseRate;
    const lead = (e.lead && e.lead[q.leadSource || 'unknown'] != null) ? e.lead[q.leadSource || 'unknown'] : e.baseRate;
    return [
      1,
      price != null ? (price - e.priceMean) / e.priceStd : 0,
      margin != null ? (margin - e.marginMean) / e.marginStd : 0,
      (svc - (e.baseRate || 0.5)),
      (zip - (e.baseRate || 0.5)),
      (lead - (e.baseRate || 0.5))
    ];
  }

  // ---- logistic regression (deterministic batch gradient descent) ----------
  function fitLogistic(X, y, iters, lr, l2) {
    const n = X.length, d = X[0] ? X[0].length : FEATURES.length;
    let w = new Array(d).fill(0);
    if (!n) return w;
    for (let it = 0; it < iters; it++) {
      const grad = new Array(d).fill(0);
      for (let i = 0; i < n; i++) {
        const xi = X[i]; let z = 0; for (let j = 0; j < d; j++) z += w[j] * xi[j];
        const err = sigmoid(z) - y[i];
        for (let j = 0; j < d; j++) grad[j] += err * xi[j];
      }
      for (let j = 0; j < d; j++) { let g = grad[j] / n; if (j > 0) g += l2 * w[j]; w[j] -= lr * g; }
    }
    return w;
  }
  function predictProb(x, w) { let z = 0; for (let j = 0; j < w.length; j++) z += w[j] * x[j]; return sigmoid(z); }
  function accuracy(X, y, w) { if (!X.length) return null; let ok = 0; for (let i = 0; i < X.length; i++) if ((predictProb(X[i], w) >= 0.5 ? 1 : 0) === y[i]) ok++; return round((ok / X.length) * 100, 1); }
  function logLoss(X, y, w) { if (!X.length) return null; let s = 0; for (let i = 0; i < X.length; i++) { const p = Math.min(1 - 1e-9, Math.max(1e-9, predictProb(X[i], w))); s += -(y[i] * Math.log(p) + (1 - y[i]) * Math.log(1 - p)); } return s / X.length; }
  function meanOf(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
  function stdOf(a) { if (a.length < 2) return 0; const m = meanOf(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length); }
  function explain(feature, contribution) {
    const dir = contribution > 0 ? 'increases' : 'decreases';
    const map = { priceZ: 'Quote price (vs typical) ' + dir + ' win odds', marginZ: 'Proposed margin (vs typical) ' + dir + ' win odds', serviceWinRate: 'This service type historically ' + dir + ' win odds', zipWinRate: 'This neighborhood historically ' + dir + ' win odds', leadWinRate: 'This lead source historically ' + dir + ' win odds' };
    return map[feature] || (feature + ' ' + dir + ' win odds');
  }

  async function resolvedQuotes() { try { const list = quotes() && quotes().list ? await quotes().list() : (await data().list('quotes')); return list.filter((q) => mine(q) && (q.status === 'won' || q.status === 'lost')); } catch (_) { return []; } }
  async function put(c, rec) { await data().put(c, rec.id, rec); try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(c, rec.id, rec); } catch (_) {} }

  global.AAA_MODEL = Model;
})(typeof window !== 'undefined' ? window : this);
