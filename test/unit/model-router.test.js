/* Model router — task-aware Opus/Sonnet/Haiku selection + backward compat. */
'use strict';
const { makeRunner } = require('../helpers/harness');

module.exports = function run() {
  const t = makeRunner('model-router');
  const G = global; G.window = G;
  delete require.cache[require.resolve('../../js/agents/model-router.js')];
  require('../../js/agents/model-router.js');
  const R = G.AAA_MODEL_ROUTER;
  const M = R.MODELS;

  t.ok('exposed', !!R && typeof R.route === 'function');

  // --- route() by task kind -------------------------------------------------
  t.eq('planning -> Opus', R.route('planning').model, M.OPUS);
  t.eq('synthesis -> Opus', R.route('synthesis').model, M.OPUS);
  t.eq('migration -> Opus', R.route('migration').model, M.OPUS);
  t.eq('coding -> Sonnet', R.route('coding').model, M.SONNET);
  t.eq('refactor -> Sonnet', R.route('refactor').model, M.SONNET);
  t.eq('triage -> Haiku', R.route('triage').model, M.HAIKU);
  t.eq('classification -> Haiku', R.route('classification').model, M.HAIKU);
  t.eq('summarization -> Haiku', R.route('summarization').model, M.HAIKU);

  // --- normalization + unknown fallback -------------------------------------
  t.eq('messy kind normalized ("Security Review") -> Opus', R.route('Security Review').model, M.OPUS);
  t.eq('unknown kind -> default Sonnet', R.route('frobnicate').model, M.SONNET);
  t.eq('empty kind -> default Sonnet', R.route('').model, M.SONNET);

  // --- metadata: tier, effort, pricing --------------------------------------
  const opus = R.route('planning');
  t.eq('opus tier', opus.tier, 'premium');
  t.eq('opus effort xhigh', opus.effort, 'xhigh');
  t.eq('opus input price', opus.priceInPerMTok, 5);
  t.eq('haiku effort low', R.route('triage').effort, 'low');
  t.ok('reason is present', typeof opus.reason === 'string' && opus.reason.length > 0);

  // --- forAgent(): backward compatible (no kind => agent's model) -----------
  t.eq('forAgent no kind keeps Opus agent', R.forAgent(M.OPUS).model, M.OPUS);
  t.eq('forAgent no kind keeps Sonnet worker', R.forAgent(M.SONNET).model, M.SONNET);
  t.eq('forAgent unknown kind keeps agent model', R.forAgent(M.SONNET, 'frobnicate').model, M.SONNET);
  // ...but a named cheap kind downgrades even an Opus agent to save cost.
  t.eq('forAgent triage downgrades Opus -> Haiku', R.forAgent(M.OPUS, 'triage').model, M.HAIKU);
  // ...and a heavy kind upgrades a worker to Opus.
  t.eq('forAgent planning upgrades Sonnet -> Opus', R.forAgent(M.SONNET, 'planning').model, M.OPUS);
  // unknown agent model with no kind -> safe default
  t.eq('forAgent unknown model -> default', R.forAgent('mystery-model').model, M.SONNET);

  // --- helpers --------------------------------------------------------------
  t.ok('isKnownModel true for Sonnet', R.isKnownModel(M.SONNET) === true);
  t.ok('isKnownModel false for junk', R.isKnownModel('gpt') === false);
  t.eq('cheaper(Opus,Haiku) -> Haiku', R.cheaper(M.OPUS, M.HAIKU), M.HAIKU);
  t.eq('cheaper(Sonnet,Opus) -> Sonnet', R.cheaper(M.SONNET, M.OPUS), M.SONNET);

  return t.report();
};
