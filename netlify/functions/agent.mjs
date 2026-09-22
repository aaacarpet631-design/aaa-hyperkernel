import { appEnv, withAppAuth } from '../lib/app-auth.mjs';
import { json } from '../lib/openai.mjs';
import { handleAgent } from '../lib/agent-runtime.mjs';

export function createHandler({ store, env = appEnv(), authorize, budget, provider, execute } = {}) {
  return withAppAuth(async (req, { userId }) => {
    const body = await req.json();
    let activeStore = store;
    if (!activeStore) {
      const { getStore } = await import('@netlify/blobs');
      activeStore = getStore({ name: 'hyperkernel-agent', consistency: 'strong' });
    }
    return json(await handleAgent(body, { userId, store: activeStore, env, provider, execute }));
  }, { methods: ['POST'], ...(authorize ? { authorize } : {}), ...(budget ? { budget } : {}) });
}

export default createHandler();
export const config = { path: '/api/agent' };
