import { authorizeOpenAI } from '../lib/openai-auth.mjs';
import { callOpenAI, readBody, json, errorResponse } from '../lib/openai.mjs';

export default async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true });
  if (req.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
  try {
    await authorizeOpenAI(req);
    return json(await callOpenAI(await readBody(req)));
  } catch (err) { return errorResponse(err); }
};

export const config = { path: '/api/openai' };
