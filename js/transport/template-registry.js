/*
 * AAA Transport Template Registry — customer-facing message templates.
 *
 * Renders SMS/email bodies for each message type from safe variables. Templates
 * are CUSTOMER-FACING ONLY: they never expose internal cost, labor, margin, or
 * confidence/risk. Rendering is pure + null-tolerant (missing vars degrade to a
 * sensible default, never "undefined").
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function biz() { return (cfg().businessName) || 'AAA Carpet'; }
  function v(vars, key, dflt) { const x = vars && vars[key]; return (x == null || x === '') ? (dflt == null ? '' : dflt) : x; }

  // channel: 'sms' | 'email' | 'both'. render(vars) → { subject?, body }.
  const TEMPLATES = {
    // ---- Quote ----
    quote_ready: { channel: 'both', category: 'quote', label: 'Quote ready', subject: 'Your estimate from ' + '{{biz}}',
      render: (x) => ({ subject: 'Your estimate from ' + biz(), body: 'Hi ' + v(x, 'customerName', 'there') + ', your estimate from ' + biz() + ' is ready' + (x && x.quoteRange ? ' (' + x.quoteRange + ')' : '') + '.' + (x && x.quoteUrl ? ' View it here: ' + x.quoteUrl : '') + ' Reply with any questions!' }) },
    quote_reminder: { channel: 'sms', category: 'quote', label: 'Quote reminder',
      render: (x) => ({ body: 'Hi ' + v(x, 'customerName', 'there') + ', just a reminder your ' + biz() + ' estimate is ready when you are. Happy to answer any questions.' }) },
    quote_followup: { channel: 'both', category: 'quote', label: 'Quote follow-up', subject: 'Following up on your estimate',
      render: (x) => ({ subject: 'Following up on your estimate', body: 'Hi ' + v(x, 'customerName', 'there') + ', checking in on the estimate we sent. Would you like to get on the schedule? — ' + biz() }) },
    // ---- Job ----
    appointment_confirmation: { channel: 'both', category: 'job', label: 'Appointment confirmation', subject: 'Your appointment is confirmed',
      render: (x) => ({ subject: 'Appointment confirmed — ' + biz(), body: 'Hi ' + v(x, 'customerName', 'there') + ', your ' + biz() + ' appointment is confirmed for ' + v(x, 'apptDate', 'the scheduled date') + '. See you then!' }) },
    on_the_way: { channel: 'sms', category: 'job', label: 'On the way',
      render: (x) => ({ body: 'Hi ' + v(x, 'customerName', 'there') + ', your ' + biz() + ' technician ' + (x && x.techName ? '(' + x.techName + ') ' : '') + 'is on the way' + (x && x.eta ? ' — ETA ' + x.eta : '') + '.' }) },
    job_completion: { channel: 'both', category: 'job', label: 'Completion', subject: 'Your job is complete',
      render: (x) => ({ subject: 'Job complete — thank you!', body: 'Hi ' + v(x, 'customerName', 'there') + ', your ' + biz() + ' job is complete. Thank you for your business! Let us know if anything needs attention.' }) },
    // ---- Review ----
    review_request_24h: { channel: 'both', category: 'review', label: 'Review request (24h)', subject: 'How did we do?',
      render: (x) => ({ subject: 'How did we do?', body: 'Hi ' + v(x, 'customerName', 'there') + ', thank you for choosing ' + biz() + '! If you have a moment, we’d love a review' + (x && x.reviewUrl ? ': ' + x.reviewUrl : '.') }) },
    review_reminder_7d: { channel: 'sms', category: 'review', label: 'Review reminder (7d)',
      render: (x) => ({ body: 'Hi ' + v(x, 'customerName', 'there') + ', a quick reminder — a review really helps our small business. Thanks from ' + biz() + (x && x.reviewUrl ? '! ' + x.reviewUrl : '!') }) },
    // ---- Lead ----
    missed_call_textback: { channel: 'sms', category: 'lead', label: 'Missed-call text-back',
      render: (x) => ({ body: 'Hi, this is ' + biz() + ' — sorry we missed your call! How can we help with your carpet/flooring? Reply here and we’ll get right back to you.' }) },
    photo_quote_ack: { channel: 'sms', category: 'lead', label: 'Photo quote acknowledgement',
      render: (x) => ({ body: 'Thanks for the photos! ' + biz() + ' received them and will send your estimate shortly. — Reply with any details about the area.' }) }
  };

  const Registry = {
    /** All templates (for the UI picker). */
    list() { return Object.keys(TEMPLATES).map((id) => ({ id: id, channel: TEMPLATES[id].channel, category: TEMPLATES[id].category, label: TEMPLATES[id].label })); },
    has(id) { return !!TEMPLATES[id]; },
    channelOf(id) { return TEMPLATES[id] ? TEMPLATES[id].channel : null; },
    categoryOf(id) { return TEMPLATES[id] ? TEMPLATES[id].category : null; },
    /** Render a template → { subject?, body }. Pure; null-tolerant; never throws. */
    render(id, vars) {
      const tpl = TEMPLATES[id];
      if (!tpl) return { ok: false, error: 'UNKNOWN_TEMPLATE' };
      try {
        const out = tpl.render(vars || {});
        return { ok: true, channel: tpl.channel, category: tpl.category, subject: out.subject || null, body: String(out.body || '') };
      } catch (e) { return { ok: false, error: 'RENDER_FAILED', message: String((e && e.message) || e) }; }
    }
  };

  global.AAA_TEMPLATES = Registry;
})(typeof window !== 'undefined' ? window : this);
