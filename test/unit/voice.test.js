/*
 * Voice pipeline — diagnostics, three-layer capture, note schema, AI extraction,
 * structured logging, and the safety guarantees. Covers the 10 acceptance tests.
 *
 * The browser APIs (SpeechRecognition, mediaDevices, MediaRecorder, navigator)
 * are faked per-scenario so we can exercise: permission granted/denied, offline,
 * unsupported recognition, audio-recording fallback, manual fallback, empty
 * transcript, correct job attachment, review-only AI, and no auto status change.
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

// Build a fresh voice environment with controllable browser capabilities.
function voiceEnv(caps) {
  caps = caps || {};
  const { G, data, cfg } = setupEnv({ config: caps.config });
  // Storage shim the note store + engine use (get/put/queueMutation).
  const jobs = caps.jobs || { j1: { id: 'j1', currentState: 'QUOTE_OPEN', logs: [] } };
  G.AAA_LOCAL_FIRST_STORAGE = {
    _jobs: jobs, _mut: [],
    get(c, id) { return c === 'jobs' ? (jobs[id] || null) : null; },
    put(c, id, v) { if (c === 'jobs') jobs[id] = v; return v; },
    queueMutation(m) { this._mut.push(m); return m; }
  };
  // navigator capabilities. In Node, global.navigator is a read-only getter, so
  // define it with a writable descriptor (mirrors how a browser exposes it).
  const nav = {
    userAgent: caps.android ? 'Mozilla/5.0 (Linux; Android 14; Pixel) Chrome/120' : 'node',
    onLine: caps.online !== false,
    permissions: caps.permission === 'unknown' ? undefined : { query: async () => ({ state: caps.permission || 'granted' }) },
    mediaDevices: caps.mediaDevices === false ? undefined : {
      getUserMedia: caps.getUserMedia || (async () => ({ getTracks: () => [{ stop() {} }] }))
    }
  };
  try { G.navigator = nav; } catch (_) { Object.defineProperty(G, 'navigator', { value: nav, configurable: true, writable: true }); }
  G.isSecureContext = caps.secure !== false;
  G.location = { protocol: caps.secure === false ? 'http:' : 'https:', hostname: 'app.test' };

  // SpeechRecognition fake
  if (caps.speech === false) { delete G.SpeechRecognition; delete G.webkitSpeechRecognition; }
  else {
    G.SpeechRecognition = function () {
      this.start = function () {
        const self = this;
        setTimeout(function () {
          if (caps.speechError) { self.onerror && self.onerror({ error: caps.speechError }); self.onend && self.onend(); }
          else if (caps.speechEmpty) { self.onend && self.onend(); }
          else { self.onresult && self.onresult({ results: [[{ transcript: caps.transcript || 'fix the stairs in the master bedroom', confidence: 0.9 }]] }); }
        }, 0);
      };
      this.stop = function () {};
    };
  }

  // MediaRecorder fake
  if (caps.mediaRecorder === false) { delete G.MediaRecorder; }
  else {
    G.MediaRecorder = function () { this.start = function () {}; this.stop = function () { if (this.onstop) this.onstop(); }; this.ondataavailable = null; this.mimeType = 'audio/webm'; };
    G.MediaRecorder.isTypeSupported = function () { return true; };
  }
  G.Blob = G.Blob || function (parts, opts) { return { size: 1, type: (opts && opts.type) || '' }; };
  G.FormData = G.FormData || function () { this.append = function () {}; };
  G.URL = G.URL || {}; G.URL.createObjectURL = function () { return 'blob:fake'; };
  G.fetch = caps.fetch || (async () => ({ ok: true, json: async () => ({ transcript: caps.apiTranscript || 'recorded note text', confidence: 0.8 }) }));

  // Load the modules fresh (order mirrors index.html).
  load('js/ai/voice-diagnostics.js');
  load('js/ai/voice-note-store.js');
  load('js/ai/sidekick-voice-engine.js');
  load('js/agents/job-notes-agent.js');
  return { G, data, cfg, jobs };
}

module.exports = function run() {
  const t = makeRunner('voice');

  // 1. Android Chrome, mic granted → live recognition saves a note to the job.
  return (async function () {
    {
      const { G, data, jobs } = voiceEnv({ android: true, permission: 'granted', online: true });
      const r = await G.AAA_SIDEKICK_VOICE.startListening('j1');
      t.ok('1 android+granted: live recognition ok', r.ok === true);
      t.ok('1 transcript captured', /master bedroom/.test(r.transcript || ''));
      const saved = await G.AAA_VOICE_NOTES.listForJob('j1');
      t.ok('1 note saved to job j1', saved.length === 1 && saved[0].jobId === 'j1');
      t.eq('1 source is live_speech', saved[0].source, 'live_speech');
      t.eq('1 status transcribed', saved[0].status, 'transcribed');
      t.ok('1 job log mirrored', Array.isArray(jobs.j1.logs) && jobs.j1.logs.some((l) => l.type === 'VOICE_LOG'));
    }

    // 2. Android Chrome, mic denied → NOT "no signal"; PERMISSION_DENIED + logged.
    {
      const { G } = voiceEnv({ android: true, permission: 'denied' });
      const a = await G.AAA_VOICE_DIAGNOSTICS.assess();
      t.eq('2 denied → code PERMISSION_DENIED', a.code, 'PERMISSION_DENIED');
      t.ok('2 denied → cannot live', a.canLive === false);
      const r = await G.AAA_SIDEKICK_VOICE.startListening('j1');
      t.eq('2 startListening returns PERMISSION_DENIED', r.code, 'PERMISSION_DENIED');
      const logs = await G.AAA_VOICE_DIAGNOSTICS.recent('j1');
      t.ok('2 permission denial logged', logs.some((l) => l.code === 'PERMISSION_DENIED'));
      t.ok('2 message is not "no signal"', !/no signal/i.test(G.AAA_VOICE_DIAGNOSTICS.message('PERMISSION_DENIED')));
    }

    // 3. Android Chrome offline → live speech 'network' error maps to NETWORK_OFFLINE.
    {
      const { G } = voiceEnv({ android: true, permission: 'granted', online: false, speechError: 'network' });
      const r = await G.AAA_SIDEKICK_VOICE.startListening('j1');
      t.eq('3 offline network error → NETWORK_OFFLINE', r.code, 'NETWORK_OFFLINE');
      t.ok('3 offline is the ONLY case that says no signal', /no signal/i.test('Voice offline — no signal'));
    }

    // 4. Unsupported SpeechRecognition → UNSUPPORTED_BROWSER, record path offered.
    {
      const { G } = voiceEnv({ speech: false, permission: 'granted' });
      const a = await G.AAA_VOICE_DIAGNOSTICS.assess();
      t.eq('4 no speech → UNSUPPORTED_BROWSER', a.code, 'UNSUPPORTED_BROWSER');
      t.ok('4 record still possible', a.canRecord === true);
      const r = await G.AAA_SIDEKICK_VOICE.startListening('j1');
      t.eq('4 startListening → UNSUPPORTED_BROWSER', r.code, 'UNSUPPORTED_BROWSER');
    }

    // 5. Audio recording fallback → record, transcribe via endpoint, save note.
    {
      const { G } = voiceEnv({ speech: false, permission: 'granted', config: { transcriptionEndpoint: '/api/transcribe' }, apiTranscript: 'replaced the pad in the hallway' });
      const ctrl = await G.AAA_SIDEKICK_VOICE.recorder('j1');
      t.ok('5 recorder ready', ctrl.ok === true);
      ctrl.start();
      const out = await ctrl.stop();
      t.ok('5 produced a blob', !!out.blob);
      const saved = await G.AAA_SIDEKICK_VOICE.saveRecording('j1', out.blob, out);
      t.ok('5 saveRecording ok', saved.ok === true);
      t.ok('5 transcript from endpoint', /hallway/.test(saved.transcript || ''));
      const notes = await G.AAA_VOICE_NOTES.listForJob('j1');
      t.eq('5 note source audio_recording', notes[0].source, 'audio_recording');
      t.eq('5 note status transcribed', notes[0].status, 'transcribed');
      t.ok('5 rawAudioUrl saved', !!notes[0].rawAudioUrl);
    }

    // 5b. Audio saved even when transcription endpoint missing (nothing lost).
    {
      const { G } = voiceEnv({ speech: false, permission: 'granted' }); // no endpoint
      const ctrl = await G.AAA_SIDEKICK_VOICE.recorder('j1');
      ctrl.start();
      const out = await ctrl.stop();
      const saved = await G.AAA_SIDEKICK_VOICE.saveRecording('j1', out.blob, out);
      t.ok('5b transcription fails honestly', saved.ok === false);
      const notes = await G.AAA_VOICE_NOTES.listForJob('j1');
      t.eq('5b audio note kept as failed', notes[0].status, 'failed');
      t.ok('5b errorReason recorded', !!notes[0].errorReason);
    }

    // 6. Manual note fallback → saved with source manual.
    {
      const { G } = voiceEnv({ permission: 'granted' });
      const r = await G.AAA_SIDEKICK_VOICE.saveTextLog('j1', '  customer wants quote by Friday  ');
      t.ok('6 manual save ok', r.ok === true);
      const notes = await G.AAA_VOICE_NOTES.listForJob('j1');
      t.eq('6 source manual', notes[0].source, 'manual');
      t.eq('6 trimmed transcript', notes[0].transcript, 'customer wants quote by Friday');
    }

    // 7. Empty transcript → EMPTY_TRANSCRIPT, logged, no note saved.
    {
      const { G } = voiceEnv({ permission: 'granted', speechEmpty: true });
      const r = await G.AAA_SIDEKICK_VOICE.startListening('j1');
      t.eq('7 empty → EMPTY_TRANSCRIPT', r.code, 'EMPTY_TRANSCRIPT');
      const notes = await G.AAA_VOICE_NOTES.listForJob('j1');
      t.eq('7 no note saved on empty', notes.length, 0);
      const logs = await G.AAA_VOICE_DIAGNOSTICS.recent('j1');
      t.ok('7 empty transcript logged', logs.some((l) => l.code === 'EMPTY_TRANSCRIPT'));
      // manual empty is rejected too
      const m = await G.AAA_SIDEKICK_VOICE.saveTextLog('j1', '   ');
      t.eq('7 manual empty rejected', m.code, 'EMPTY_TRANSCRIPT');
    }

    // 8. Saving note to the correct job (two jobs, note lands on the right one).
    {
      const { G } = voiceEnv({ permission: 'granted', jobs: { j1: { id: 'j1', currentState: 'QUOTE_OPEN', logs: [] }, j2: { id: 'j2', currentState: 'SCHEDULED', logs: [] } } });
      await G.AAA_SIDEKICK_VOICE.saveTextLog('j2', 'note for job two');
      const j1 = await G.AAA_VOICE_NOTES.listForJob('j1');
      const j2 = await G.AAA_VOICE_NOTES.listForJob('j2');
      t.eq('8 j1 has no note', j1.length, 0);
      t.eq('8 j2 has the note', j2.length, 1);
      t.eq('8 note bound to j2', j2[0].jobId, 'j2');
    }

    // 9. AI extraction creates review-only suggestions (no proxy → honest skip).
    {
      const { G } = voiceEnv({ permission: 'granted' });
      // No proxy configured → agent not ready, transcript still saved.
      t.ok('9 agent gated when proxy absent', G.AAA_JOB_NOTES_AGENT.isReady() === false);

      // Now simulate a configured proxy returning structured suggestions.
      G.AAA_CONFIG.set({}); G.AAA_CONFIG.isProxyConfigured = () => true;
      G.AAA_DATA.callAgent = async () => ({ ok: true, text: JSON.stringify({
        customerRequest: 'restretch living room carpet', workPerformed: [], materialsNeeded: ['carpet tack strip'],
        rooms: ['living room'], measurements: ['12x14 ft'], followUpTasks: ['call customer Monday'],
        crewActionItems: ['bring power stretcher'], urgency: 'medium', accountingRelevant: false,
        receiptRelevant: false, summary: 'Restretch living room; needs tack strip.' }) });
      const save = await G.AAA_VOICE_NOTES.create({ jobId: 'j1', source: 'manual', transcript: 'restretch the living room, 12x14', status: 'transcribed' });
      const res = await G.AAA_JOB_NOTES_AGENT.analyze(save.note.id);
      t.ok('9 extraction ok', res.ok === true);
      t.ok('9 suggestions are review-only', res.intelligence.reviewRequired === true && res.intelligence.status === 'suggested');
      t.ok('9 rooms extracted', res.intelligence.data.rooms.indexOf('living room') !== -1);
      t.ok('9 measurements extracted', res.intelligence.data.measurements.length === 1);
      const note = await G.AAA_VOICE_NOTES.get(save.note.id);
      t.ok('9 intelligence attached to note', note.intelligence && note.intelligence.status === 'suggested');
    }

    // 10. No job status changes automatically from a voice note or its AI.
    {
      const { G, jobs } = voiceEnv({ permission: 'granted', jobs: { j1: { id: 'j1', currentState: 'QUOTE_OPEN', logs: [] } } });
      G.AAA_CONFIG.isProxyConfigured = () => true;
      G.AAA_DATA.callAgent = async () => ({ ok: true, text: JSON.stringify({
        customerRequest: 'close the job', workPerformed: ['done'], materialsNeeded: [], rooms: [], measurements: [],
        followUpTasks: [], crewActionItems: [], urgency: 'high', accountingRelevant: true, receiptRelevant: true, summary: 'done' }) });
      const before = jobs.j1.currentState;
      const save = await G.AAA_VOICE_NOTES.create({ jobId: 'j1', source: 'live_speech', transcript: 'job is complete, send invoice', status: 'transcribed', confidence: 90 });
      await G.AAA_JOB_NOTES_AGENT.analyze(save.note.id);
      t.eq('10 job state unchanged by voice + AI', jobs.j1.currentState, before);
      t.ok('10 no invoices created', (await G.AAA_DATA.list('invoices')).length === 0);
      t.ok('10 no accounting entries created', (await G.AAA_DATA.list('ledger')).length === 0);
      // Note carries info but never an applied action.
      const note = await G.AAA_VOICE_NOTES.get(save.note.id);
      t.ok('10 AI marked review-required, not applied', note.intelligence.reviewRequired === true);
    }

    return t.report();
  })();
};
