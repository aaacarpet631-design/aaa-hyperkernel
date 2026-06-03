/*
 * AAA Expense Classification Agent — deterministic, explainable, and learning.
 *
 * Turns a receipt's vendor (and optionally its line items) into an accounting
 * category with a confidence score and a plain-language reason. It is NOT an
 * LLM call: classification of a known vendor must be instant, offline-capable,
 * and identical every time, so this is a real rules engine seeded with the
 * vendors AAA actually buys from. An optional AI pass can be layered on later
 * for unknown vendors, but the floor is always deterministic.
 *
 * Learning: every human correction is recorded (vendor -> category) in the
 * 'expense_corrections' collection and consulted first on the next pass, so the
 * system measurably improves. We also track prediction accuracy over time.
 *
 * Honest by construction: an unknown vendor returns LOW confidence + the
 * 'Uncategorized' category + needsReview:true — it never guesses a category at
 * high confidence just to look decisive.
 */
;(function (global) {
  'use strict';

  const CORRECTIONS = 'expense_corrections';   // learned vendor -> category overrides
  const PREDICTIONS = 'expense_predictions';    // prediction/outcome log for accuracy

  function data() { return global.AAA_DATA; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }

  // Confidence bands (0-100). Kept as named constants so callers can reason
  // about thresholds (e.g. needsReview below REVIEW_THRESHOLD).
  const CONF = { LEARNED: 98, KNOWN_VENDOR: 92, KEYWORD: 70, WEAK: 45, UNKNOWN: 20 };
  const REVIEW_THRESHOLD = 75;   // below this, a human should confirm before posting

  /**
   * The chart-of-accounts categories this engine maps into. Deliberately small
   * and concrete for a flooring/service company; extend as the GL grows.
   */
  const CATEGORIES = [
    'Materials', 'Inventory', 'Fuel', 'Tools', 'Equipment', 'Office',
    'Advertising', 'Communications', 'Software', 'Subcontractors', 'Meals',
    'Insurance', 'Rent', 'Utilities', 'Banking', 'Uncategorized'
  ];

  // Known vendor patterns -> category. Order matters: first match wins. Each
  // pattern is matched case-insensitively against the normalized vendor name.
  // Seeded with the vendors a Houston carpet/flooring company actually uses.
  const VENDOR_RULES = [
    { re: /home depot|the home depot|lowe'?s|menards|builders? first|white cap/, cat: 'Materials' },
    { re: /floor ?& ?decor|floor and decor|shaw|mohawk|carpet|flooring|roberts|traxx|laticrete|mapei|bostik|stikatak/, cat: 'Inventory' },
    { re: /harbor freight|dewalt|milwaukee tool|crain|traxx tool|ace hardware/, cat: 'Tools' },
    { re: /\b(chevron|shell|exxon|valero|conoco|phillips 66|texaco|buc-?ee'?s|circle k|7-?eleven|quiktrip|qt|racetrac|gas|fuel|bp)\b/, cat: 'Fuel' },
    { re: /\b(u-?haul|home depot tool rental|sunbelt|united rentals|enterprise|rental)\b/, cat: 'Equipment' },
    { re: /staples|office depot|officemax|office max/, cat: 'Office' },
    { re: /google ads|adwords|facebook ads|meta platforms|yelp|angi|angie'?s list|thumbtack|nextdoor ads/, cat: 'Advertising' },
    { re: /twilio|ringcentral|verizon|at&?t|t-?mobile|comcast business voice/, cat: 'Communications' },
    { re: /openai|anthropic|github|google workspace|microsoft 365|adobe|quickbooks|intuit|jobber|housecall|servicetitan|netlify|vercel|aws|amazon web services/, cat: 'Software' },
    { re: /comcast|xfinity|centerpoint|reliant|txu|city of houston|water|electric|utility/, cat: 'Utilities' },
    { re: /state farm|geico|progressive|the hartford|nationwide|insurance|hiscox|next insurance/, cat: 'Insurance' },
    { re: /chick-?fil-?a|whataburger|mcdonald'?s|taco|subway|chipotle|restaurant|cafe|coffee|starbucks/, cat: 'Meals' },
    { re: /bank|wells fargo|chase|bank of america|merchant fee|stripe fee|square fee/, cat: 'Banking' }
  ];

  // Line-item keyword heuristics — used only when the vendor is unknown. Lower
  // confidence than a vendor match because item text is noisier.
  const KEYWORD_RULES = [
    { re: /\b(carpet|pad|seam tape|tack ?strip|transition|underlayment|grout|thinset|adhesive|trowel)\b/, cat: 'Materials' },
    { re: /\b(gallon|diesel|unleaded|regular|premium)\b.*\b(gas|fuel)\b|\bfuel\b/, cat: 'Fuel' },
    { re: /\b(drill|blade|knife|kicker|stretcher|stapler|tool)\b/, cat: 'Tools' },
    { re: /\b(paper|toner|ink|pens?|stapler|folders?)\b/, cat: 'Office' }
  ];

  /** Normalize a vendor string for matching (lowercase, collapse whitespace). */
  function normVendor(v) {
    return String(v == null ? '' : v).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  const Engine = {
    CATEGORIES: CATEGORIES.slice(),
    CONF: Object.assign({}, CONF),
    REVIEW_THRESHOLD: REVIEW_THRESHOLD,

    /**
     * Classify a receipt. Pure given the corrections store; no network.
     * @param {Object} receipt { vendor, lineItems?: Array<{description}>|string[] }
     * @returns {Promise<{category, confidence, reasoning, source, needsReview, candidates}>}
     */
    async classify(receipt) {
      const r = receipt || {};
      const vendor = normVendor(r.vendor);

      // 1) Learned correction for this exact vendor wins (this is the learning).
      if (vendor) {
        const learned = await this._learnedFor(vendor);
        if (learned) {
          return result(learned.category, CONF.LEARNED, source('learned'),
            'Previously corrected by a person for "' + r.vendor + '" → ' + learned.category + '.', []);
        }
      }

      // 2) Known vendor pattern.
      if (vendor) {
        for (const rule of VENDOR_RULES) {
          if (rule.re.test(vendor)) {
            return result(rule.cat, CONF.KNOWN_VENDOR, source('vendor-rule'),
              'Vendor "' + r.vendor + '" matches a known ' + rule.cat + ' supplier.', []);
          }
        }
      }

      // 3) Line-item keyword heuristic (unknown vendor).
      const itemText = itemsToText(r.lineItems);
      if (itemText) {
        for (const rule of KEYWORD_RULES) {
          if (rule.re.test(itemText)) {
            return result(rule.cat, CONF.KEYWORD, source('keyword'),
              'Vendor unknown, but line items look like ' + rule.cat + '.', []);
          }
        }
      }

      // 4) Unknown — be honest, ask for a human.
      return result('Uncategorized', vendor ? CONF.WEAK : CONF.UNKNOWN, source('none'),
        vendor ? 'No rule matched vendor "' + r.vendor + '". Needs a person to categorize.'
               : 'No vendor on the receipt. Needs a person to categorize.', CATEGORIES.slice(0, -1));
    },

    /**
     * Record a human correction so the next receipt from this vendor is right.
     * Also closes the loop on the prediction log for accuracy tracking.
     */
    async correct(input) {
      const i = input || {};
      const vendor = normVendor(i.vendor);
      if (!vendor || !i.category) return { ok: false, error: 'INVALID_INPUT' };
      if (CATEGORIES.indexOf(i.category) === -1) return { ok: false, error: 'UNKNOWN_CATEGORY' };
      const id = keyFor(vendor);
      const rec = {
        id: id, vendor: vendor, category: i.category, workspaceId: ws(),
        correctedBy: i.actor || null, updatedAt: nowISO(),
        count: ((await getOne(CORRECTIONS, id)) || {}).count + 1 || 1
      };
      await put(CORRECTIONS, rec);
      if (i.predictionId) await this._resolvePrediction(i.predictionId, i.category);
      return { ok: true, correction: rec };
    },

    /**
     * Log a prediction the moment it's made, so accuracy can be measured later
     * when a human approves (correct) or corrects it.
     */
    async logPrediction(input) {
      const i = input || {};
      const id = ids() ? ids().createId('pred') : 'pred_' + Date.now();
      const rec = {
        id: id, receiptId: i.receiptId || null, vendor: normVendor(i.vendor),
        predicted: i.predicted, confidence: i.confidence == null ? null : i.confidence,
        source: i.source || null, outcome: null, finalCategory: null,
        workspaceId: ws(), createdAt: nowISO()
      };
      await put(PREDICTIONS, rec);
      return rec;
    },

    /** Accuracy snapshot from the resolved prediction log. */
    async accuracy() {
      const preds = (await data().list(PREDICTIONS)).filter(mine);
      const resolved = preds.filter((p) => p.outcome === 'correct' || p.outcome === 'corrected');
      const correct = resolved.filter((p) => p.outcome === 'correct').length;
      return {
        predictions: preds.length,
        resolved: resolved.length,
        correct: correct,
        accuracyPct: resolved.length ? Math.round((correct / resolved.length) * 100) : null,
        learnedVendors: (await data().list(CORRECTIONS)).filter(mine).length
      };
    },

    // ---- internals ------------------------------------------------------
    async _learnedFor(vendor) {
      const rec = await getOne(CORRECTIONS, keyFor(vendor));
      return rec && rec.category ? rec : null;
    },
    async _resolvePrediction(predictionId, finalCategory) {
      const p = await getOne(PREDICTIONS, predictionId);
      if (!p) return;
      const outcome = p.predicted === finalCategory ? 'correct' : 'corrected';
      await put(PREDICTIONS, Object.assign({}, p, { outcome: outcome, finalCategory: finalCategory, resolvedAt: nowISO() }));
    }
  };

  function source(s) { return s; }
  function result(category, confidence, src, reasoning, candidates) {
    return {
      category: category, confidence: confidence, source: src, reasoning: reasoning,
      needsReview: confidence < REVIEW_THRESHOLD, candidates: candidates || []
    };
  }
  function itemsToText(items) {
    if (!items) return '';
    if (Array.isArray(items)) {
      return items.map((x) => (typeof x === 'string' ? x : (x && (x.description || x.name)) || '')).join(' ').toLowerCase();
    }
    return String(items).toLowerCase();
  }
  // A stable per-vendor key so corrections upsert rather than duplicate.
  function keyFor(vendor) { return 'corr_' + ws() + '_' + vendor.replace(/[^a-z0-9]+/g, '_').slice(0, 60); }

  async function getOne(c, id) { const r = await data().get(c, id); return mine(r) ? r : null; }
  async function put(c, rec) {
    await data().put(c, rec.id, rec);
    try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(c, rec.id, rec); } catch (_) {}
  }

  global.AAA_EXPENSE_CLASSIFIER = Engine;
})(typeof window !== 'undefined' ? window : this);
