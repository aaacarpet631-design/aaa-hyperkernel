/*
 * nv-smoke — one live call to NVIDIA's hosted catalog through the repo's own
 * translation layer (functions/nemotron-translate.js), to confirm the wiring,
 * the key, and a chosen served model all work end to end.
 *
 * The key is read from the NVIDIA_API_KEY env var ONLY — never hardcode it here.
 * Run:
 *   NVIDIA_API_KEY=nvapi-… npm run nv:smoke
 *   NVIDIA_API_KEY=nvapi-… npm run nv:smoke -- --model meta/llama-3.1-8b-instruct
 *   NVIDIA_API_KEY=nvapi-… npm run nv:smoke -- --think "Walk through 17*23, then answer."
 *
 * Exits 0 on a successful reply, non-zero on any failure (missing key, HTTP
 * error, network/egress block) so it is safe to chain in CI or a deploy check.
 */
import nemo from '../functions/nemotron-translate.js';

// --- tiny arg parser: --model X, --think [prompt], --max N, trailing prompt ---
const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return undefined;
  const next = argv[i + 1];
  return (next === undefined || next.startsWith('--')) ? true : next;
}
const model = (typeof flag('model') === 'string' && flag('model')) || process.env.NEMOTRON_MODEL || 'google/gemma-2-27b-it';
const think = flag('think');
const maxTokens = Number(flag('max')) || (think ? 1024 : 32);
const prompt = (typeof think === 'string' && think)
  || argv.filter((a) => !a.startsWith('--')).join(' ')
  || 'Reply with exactly: OK';

const key = process.env.NVIDIA_API_KEY;
if (!key) {
  console.error('✗ NVIDIA_API_KEY is not set. Run: NVIDIA_API_KEY=nvapi-… npm run nv:smoke');
  process.exit(2);
}

// Build the request via the SAME code the deployed proxy uses.
const appBody = {
  model,
  max_tokens: maxTokens,
  messages: [{ role: 'user', content: prompt }],
  ...(think ? { chat_template_kwargs: { enable_thinking: true } } : {})
};
const payload = nemo.toRequest(appBody, { defaultModel: process.env.NEMOTRON_MODEL });

console.log('→ endpoint     ', nemo.NVIDIA_URL);
console.log('→ model (sent) ', payload.model, payload.model === model ? '' : '(resolved/fallback)');
console.log('→ prompt       ', JSON.stringify(prompt));
console.log('→ thinking     ', think ? 'on' : 'off');

try {
  const t0 = Date.now();
  const res = await fetch(nemo.NVIDIA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify(payload)
  });
  const ms = Date.now() - t0;
  const raw = await res.text();
  let data; try { data = JSON.parse(raw); } catch { data = null; }

  if (!res.ok || !data) {
    console.error(`✗ HTTP ${res.status} (${ms}ms):`, (raw || '').slice(0, 800));
    process.exit(1);
  }
  const out = nemo.fromResponse(data);
  console.log(`✓ HTTP ${res.status} (${ms}ms)`);
  console.log('  text   :', JSON.stringify(out.text));
  if (out.reasoning) console.log('  reason :', JSON.stringify(out.reasoning).slice(0, 300) + '…');
  console.log('  usage  :', JSON.stringify(out.usage));
  process.exit(out.ok && out.text ? 0 : 1);
} catch (err) {
  // e.g. this sandbox's egress allowlist blocks integrate.api.nvidia.com
  console.error('✗ request failed:', String((err && err.message) || err));
  process.exit(1);
}
