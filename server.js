// Claim Assist — backend
//
// Serves the static frontend (public/) and proxies the two AI calls the
// frontend needs to Anthropic's API. The key reason this exists as a
// server at all, rather than calling the API straight from the browser:
// an API key embedded in client-side JS is visible to anyone who opens
// dev tools, so it has to live server-side.
//
// Endpoints:
//   POST /api/classify  { freeText, tracking } -> claim-type classification
//   POST /api/generate  { ctx }                -> customer + staff documents
//   GET  /api/health                           -> { ok, model, hasApiKey }

require('dotenv').config();
const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

const apiKey = process.env.ANTHROPIC_API_KEY;
const anthropic = apiKey ? new Anthropic({ apiKey }) : null;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const CLAIM_TYPE_LABELS = {
  damaged: 'Arrived damaged',
  lost: 'Never arrived (lost)',
  delayed: 'Arrived late (delayed)',
  value_dispute: 'Value or contents dispute',
};

function buildExtractionPrompt(freeText, tracking) {
  return `You are the intake classifier for a package claims assistant used by a shipping retail store's front counter. `
    + `A customer has typed a free-text description of a problem with a shipment. Classify it and pull out structured details.\n\n`
    + `Customer's tracking number (may be blank): ${tracking || '(not provided)'}\n`
    + `Customer's description: "${freeText}"\n\n`
    + `Respond with ONLY a JSON object, no prose, no markdown fences, matching exactly this shape:\n`
    + `{"claim_type": "damaged" | "lost" | "delayed" | "value_dispute", `
    + `"confidence": 0.0-1.0, `
    + `"item_description": "short phrase naming the item(s) if mentioned, else empty string", `
    + `"declared_value_guess": "dollar amount if the customer mentioned one, else empty string", `
    + `"follow_up_questions": ["exactly 2 short, specific follow-up questions a claims associate should ask, based on THIS description"], `
    + `"reasoning": "one short sentence on why you picked this claim type"}\n\n`
    + `If the description is ambiguous between two types, pick the more likely one and lower the confidence score.`;
}

function buildFinalDocsPrompt(ctx) {
  return `You are generating claim documentation for a customer at a shipping retail store franchise. `
    + `Using the structured intake data below, produce two documents and a risk assessment. Be concrete and factual — never invent details not given.\n\n`
    + `INTAKE DATA:\n${JSON.stringify(ctx, null, 2)}\n\n`
    + `Respond with ONLY a JSON object, no prose, no markdown fences, matching exactly this shape:\n`
    + `{"customer_packet": "a friendly, well-formatted plain-text document the customer can submit with their claim, including a clear summary of the incident, itemized evidence list, and next steps for the customer. Use line breaks, no markdown symbols.", `
    + `"staff_summary": "a terse internal plain-text summary for the store associate: claim type, tracking number, key facts, missing evidence flagged clearly, and a one-line recommendation on whether to submit now or collect more info first. Use line breaks, no markdown symbols.", `
    + `"risk_level": "low" | "medium" | "high", `
    + `"risk_reasons": ["1-3 short bullet reasons for the risk level, focused on documentation completeness and claim-type-specific denial patterns"]}`;
}

// Anthropic's text responses can arrive as plain JSON or wrapped in a
// ```json fence even when told not to — strip either before parsing.
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const raw = fenced ? fenced[1] : text;
  return JSON.parse(raw.trim());
}

async function callClaude(prompt, maxTokens) {
  if (!anthropic) {
    const err = new Error('ANTHROPIC_API_KEY is not set on the server');
    err.code = 'NO_API_KEY';
    throw err;
  }
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = msg.content.map(b => (b.type === 'text' ? b.text : '')).join('');
  return extractJson(text);
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, model: MODEL, hasApiKey: !!apiKey });
});

app.post('/api/classify', async (req, res) => {
  const { freeText, tracking } = req.body || {};
  if (!freeText || typeof freeText !== 'string') {
    return res.status(400).json({ error: 'freeText is required' });
  }
  try {
    const result = await callClaude(buildExtractionPrompt(freeText, tracking), 400);
    res.json(result);
  } catch (err) {
    console.error('[classify]', err.message);
    res.status(502).json({ error: err.code === 'NO_API_KEY' ? 'AI backend is not configured' : 'AI classification failed' });
  }
});

app.post('/api/generate', async (req, res) => {
  const { ctx } = req.body || {};
  if (!ctx || !ctx.claim_type || !CLAIM_TYPE_LABELS[ctx.claim_type]) {
    return res.status(400).json({ error: 'a valid ctx.claim_type is required' });
  }
  try {
    const result = await callClaude(buildFinalDocsPrompt(ctx), 900);
    res.json(result);
  } catch (err) {
    console.error('[generate]', err.message);
    res.status(502).json({ error: err.code === 'NO_API_KEY' ? 'AI backend is not configured' : 'AI document generation failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Claim Assist running at http://localhost:${PORT}`);
  if (!apiKey) {
    console.warn('WARNING: ANTHROPIC_API_KEY is not set. /api/classify and /api/generate will return errors, and the frontend will fall back to its offline template logic.');
  }
});
