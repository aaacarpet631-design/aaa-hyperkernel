import { authorizeOpenAI } from '../lib/openai-auth.mjs';
import { callOpenAI, readBody, json } from '../lib/openai.mjs';
import { withAppAuth } from '../lib/app-auth.mjs';

export function createHandler({ budget } = {}) { return withAppAuth(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
  return json(await callOpenAI(await readBody(req)));
}, { authorize: authorizeOpenAI, budget, methods: ['POST'] }); }

export default createHandler();

export const config = { path: '/api/openai' };
