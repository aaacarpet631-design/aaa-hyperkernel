/*
 * Receipt OCR function (Netlify, Claude-backed).
 *
 * Accepts a base64 receipt image (or a single PDF page rendered to an image)
 * and returns structured accounting data produced by Claude vision. Structured
 * outputs (output_config.format) guarantee the response matches RECEIPT_SCHEMA,
 * so the client never parses free text. The instruction block carries a
 * cache_control breakpoint so the stable prefix is cached across calls.
 *
 * This is intake only — it extracts what is on the paper. It does NOT classify
 * to a GL account (the deterministic AAA_EXPENSE_CLASSIFIER does that) and it
 * NEVER posts anything. A person approves before any expense is written.
 *
 * Requires ANTHROPIC_API_KEY in the Netlify site environment.
 */
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-4-8';

const SYSTEM_INSTRUCTIONS = `You are a meticulous bookkeeping OCR engine for AAA, a carpet and flooring company in Houston, Texas. You receive a single photo of a purchase receipt or invoice and transcribe it into structured accounting fields. You are an extractor, not a guesser.

Rules:
- Transcribe ONLY what is legibly visible. If a field is not present or not legible, return null for it. Never invent a vendor, amount, date, or line item.
- "vendor" is the merchant/business name as printed.
- "date" is the purchase date in ISO 8601 (YYYY-MM-DD) if you can read it, else null. "time" is HH:MM (24h) if printed, else null.
- "address" is the store address if printed, else null.
- Money fields ("subtotal", "tax", "total") are numbers in dollars (no currency symbol). If only the total is legible, return subtotal/tax as null.
- "lineItems" is an array of { description, quantity, sku, amount }; use null for any sub-field you cannot read. Omit the array entirely (return []) if no items are legible.
- "paymentMethod" e.g. "Visa ****1234", "Cash", "Amex" — else null.
- "invoiceNumber" / "receiptNumber" if printed, else null.
- "confidence" (0-100): how sure you are of the extraction given image quality. Lower it hard for blur, glare, cropping, or handwriting.
- "quality": "ok" if clearly legible; "blurry" if focus/glare hurts it; "partial" if the receipt is cut off or a multi-page receipt seems incomplete.
- Do not classify the expense or assign an account — that is done downstream. Just transcribe.`;

const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    vendor: { type: ['string', 'null'] },
    date: { type: ['string', 'null'], description: 'ISO 8601 YYYY-MM-DD or null.' },
    time: { type: ['string', 'null'], description: 'HH:MM 24h or null.' },
    address: { type: ['string', 'null'] },
    subtotal: { type: ['number', 'null'] },
    tax: { type: ['number', 'null'] },
    total: { type: ['number', 'null'] },
    paymentMethod: { type: ['string', 'null'] },
    invoiceNumber: { type: ['string', 'null'] },
    receiptNumber: { type: ['string', 'null'] },
    lineItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: ['string', 'null'] },
          quantity: { type: ['number', 'null'] },
          sku: { type: ['string', 'null'] },
          amount: { type: ['number', 'null'] }
        },
        required: ['description', 'quantity', 'sku', 'amount'],
        additionalProperties: false
      }
    },
    confidence: { type: 'integer', description: 'Extraction confidence 0-100.' },
    quality: { type: 'string', enum: ['ok', 'blurry', 'partial'] }
  },
  required: ['vendor', 'date', 'time', 'address', 'subtotal', 'tax', 'total', 'paymentMethod', 'invoiceNumber', 'receiptNumber', 'lineItems', 'confidence', 'quality'],
  additionalProperties: false
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export default async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ ok: false, error: 'MISSING_API_KEY', message: 'Set ANTHROPIC_API_KEY in the Netlify site environment.' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'INVALID_JSON' }, 400); }
  const image = body && body.image;
  const mediaType = (body && body.mediaType) || 'image/jpeg';
  if (!image || typeof image !== 'string') return json({ ok: false, error: 'NO_IMAGE' }, 400);

  const client = new Anthropic({ apiKey });
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: [{ type: 'text', text: SYSTEM_INSTRUCTIONS, cache_control: { type: 'ephemeral' } }],
      output_config: { format: { type: 'json_schema', schema: RECEIPT_SCHEMA } },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
            { type: 'text', text: 'Transcribe this receipt into the structured accounting fields. Use null for anything not legible.' }
          ]
        }
      ]
    });
    const textBlock = response.content.find((b) => b.type === 'text');
    const ocr = JSON.parse(textBlock ? textBlock.text : '{}');
    return json({ ok: true, ocr });
  } catch (err) {
    const status = err && typeof err.status === 'number' ? err.status : 500;
    console.error('Receipt OCR function error', err);
    return json({ ok: false, error: 'OCR_FAILED', message: String((err && err.message) || err) }, status >= 400 && status <= 599 ? status : 500);
  }
};

export const config = { path: '/api/receipt-ocr' };
