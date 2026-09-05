/* Validate the app session with its configured identity provider before a
 * paid model call. The server allowlist is independent of browser role flags.
 * Firebase accounts:lookup: https://firebase.google.com/docs/reference/rest/auth
 */
import { OpenAIError } from './openai.mjs';

export async function authorizeOpenAI(req, { env = process.env, fetchImpl = fetch } = {}) {
  const allowed = String(env.OPENAI_ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const provider = env.OPENAI_AUTH_PROVIDER || 'firebase';
  if (!allowed.length || !['firebase', 'supabase'].includes(provider)) throw new OpenAIError('OPENAI_AUTH_NOT_CONFIGURED', 503);
  const match = /^Bearer (\S+)$/i.exec(req.headers.get('authorization') || '');
  if (!match) throw new OpenAIError('SIGN_IN_REQUIRED', 401);
  const token = match[1];
  let id;
  try {
    if (provider === 'firebase') {
      if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_WEB_API_KEY) throw new OpenAIError('OPENAI_AUTH_NOT_CONFIGURED', 503);
      // These claims are only a project/expiry precheck, never authentication.
      // The exact same token is then validated by Firebase, not by decoding it.
      let claims;
      try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
      catch { throw new OpenAIError('INVALID_SESSION', 401); }
      if (claims.aud !== env.FIREBASE_PROJECT_ID || claims.iss !== 'https://securetoken.google.com/' + env.FIREBASE_PROJECT_ID ||
          !claims.sub || !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000) throw new OpenAIError('INVALID_SESSION', 401);
      const res = await fetchImpl('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(env.FIREBASE_WEB_API_KEY), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: token }), signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) throw new OpenAIError(res.status >= 500 ? 'AUTH_UNAVAILABLE' : 'INVALID_SESSION', res.status >= 500 ? 503 : 401);
      const user = (await res.json()).users?.[0];
      if (!user || user.disabled || user.localId !== claims.sub) throw new OpenAIError('INVALID_SESSION', 401);
      id = user.localId;
    } else {
      if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_URL.startsWith('https://')) throw new OpenAIError('OPENAI_AUTH_NOT_CONFIGURED', 503);
      const res = await fetchImpl(env.SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/user', {
        headers: { authorization: 'Bearer ' + token, apikey: env.SUPABASE_ANON_KEY }, signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) throw new OpenAIError(res.status >= 500 ? 'AUTH_UNAVAILABLE' : 'INVALID_SESSION', res.status >= 500 ? 503 : 401);
      const user = await res.json();
      if (!user.id || user.is_anonymous) throw new OpenAIError('INVALID_SESSION', 401);
      id = user.id;
    }
  } catch (err) {
    if (err instanceof OpenAIError) throw err;
    throw new OpenAIError('AUTH_UNAVAILABLE', 503);
  }
  if (!allowed.includes(id)) throw new OpenAIError('OPENAI_ACCESS_DENIED', 403);
  return id;
}
