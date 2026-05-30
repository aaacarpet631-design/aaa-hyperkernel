/*
 * Vision estimating function (Netlify, Claude-backed).
 *
 * Accepts a base64 carpet/flooring photo and returns a structured repair
 * estimate produced by Claude vision. Structured outputs (output_config.format)
 * guarantee the response matches ESTIMATE_SCHEMA, so the client can render it
 * without defensive parsing. The instruction block carries a cache_control
 * breakpoint so the stable prefix is cached across calls.
 *
 * Requires ANTHROPIC_API_KEY to be set in the Netlify site environment.
 */
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-4-8';

const SYSTEM_INSTRUCTIONS = `You are an expert carpet and flooring estimator for AAA, a professional carpet repair and cleaning company. A field technician sends you a single on-site photo of carpet or flooring. Produce a concise, realistic repair estimate the technician can act on immediately.

Rules:
- Base your assessment only on what is visible in the photo.
- "estimatedTimeMins" is hands-on technician labor minutes for the repair itself (not travel or drying time).
- "materials" lists the physical supplies the tech would load on the truck (e.g. "Seam tape", "Carpet patch", "Pet stain enzyme", "Stretching tools").
- If the image is unclear, dark, or not carpet/flooring, say so in "summary" and return conservative values.
- Keep "summary" to one or two plain-language sentences a customer could understand.`;

const ESTIMATE_SCHEMA = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      description: "Short label for the primary issue, e.g. 'Seam separation', 'Pet damage', 'Water stain', 'Burn / melt', 'Heavy soiling', 'Fraying edge'."
    },
    severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
    estimatedTimeMins: { type: 'integer', description: 'Technician labor minutes for the repair.' },
    materials: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string', description: 'One or two sentence plain-language assessment.' }
  },
  required: ['type', 'severity', 'estimatedTimeMins', 'materials', 'summary'],
  additionalProperties: false
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

export default async (req) => {
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({ ok: false, error: 'MISSING_API_KEY', message: 'Set ANTHROPIC_API_KEY in the Netlify site environment.' }, 500);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'INVALID_JSON' }, 400);
  }
  const image = body && body.image;
  const mediaType = (body && body.mediaType) || 'image/jpeg';
  if (!image || typeof image !== 'string') {
    return json({ ok: false, error: 'NO_IMAGE' }, 400);
  }

  const client = new Anthropic({ apiKey });
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: [
        { type: 'text', text: SYSTEM_INSTRUCTIONS, cache_control: { type: 'ephemeral' } }
      ],
      output_config: { format: { type: 'json_schema', schema: ESTIMATE_SCHEMA } },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
            { type: 'text', text: 'Analyze this carpet/flooring photo and return a repair estimate.' }
          ]
        }
      ]
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const analysis = JSON.parse(textBlock ? textBlock.text : '{}');
    return json({ ok: true, analysis });
  } catch (err) {
    const status = err && typeof err.status === 'number' ? err.status : 500;
    console.error('Vision function error', err);
    return json(
      { ok: false, error: 'ANALYSIS_FAILED', message: String((err && err.message) || err) },
      status >= 400 && status <= 599 ? status : 500
    );
  }
};

export const config = { path: '/api/vision' };
