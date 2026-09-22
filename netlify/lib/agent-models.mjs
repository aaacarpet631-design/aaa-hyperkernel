/* Reviewed 2026-09-22 against Artificial Analysis and the providers' model
 * cards. Stable IDs, no unreviewed "latest" alias and no silent model fallback. */
export const MODEL_CATALOG = [
  { id: 'xiaomi/mimo-v2.6-pro', label: 'MiMo-V2.6-Pro', provider: 'openrouter', openness: 'Open weights · MIT', purpose: 'General tasks and analysis' },
  { id: 'z-ai/glm-5.3', label: 'GLM-5.3', provider: 'openrouter', openness: 'Open weights · GLM-5.3 license', purpose: 'Software and tool workflows' },
  { id: 'moonshotai/kimi-k3', label: 'Kimi K3', provider: 'openrouter', openness: 'Open weights · Kimi K3 license', purpose: 'Research and complex coding' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', provider: 'openai', openness: 'Proprietary' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'anthropic', openness: 'Proprietary' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic', openness: 'Proprietary' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'anthropic', openness: 'Proprietary' }
];
export const OPEN_MODELS = MODEL_CATALOG.filter(m => m.provider === 'openrouter').map(m => m.id);
const KEYS = { openrouter: 'OPENROUTER_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };
export const modelCatalog = env => MODEL_CATALOG.map(m => ({ ...m, configured: !!env[KEYS[m.provider]] }));
export const availableModels = env => modelCatalog(env).filter(m => m.configured).map(m => m.id);
