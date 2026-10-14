// Claim Assist — backend
//
// Serves the static frontend (public/) and proxies the two AI calls the
// frontend needs to Anthropic's API. The key reason this exists as a
// server at all, rather than calling the API straight from the browser:
// an API key embedded in client-side JS is visible to anyone who opens
// dev tools, so it has to live server-side. The same reasoning applies to
// the email feature below — a mail account's credentials can't live in
// browser JavaScript either.
//
// Endpoints:
//   POST /api/classify   { freeText, tracking } -> claim-type classification
//   POST /api/generate   { ctx }                -> customer + staff documents
//   POST /api/send-to-store { claim fields + photos } -> zips and emails the claim to the store
//   GET  /api/health                            -> { ok, model, hasApiKey, hasEmail }

require('dotenv').config();
const express = require('express');
const path = require('path');
const zlib = require('zlib');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

const apiKey = process.env.ANTHROPIC_API_KEY;
const anthropic = apiKey ? new Anthropic({ apiKey }) : null;

// Email goes out through the Gmail API over HTTPS. (Render's free plan blocks the
// SMTP ports Gmail's normal mail servers use, so SMTP would just hang. The Gmail
// API uses port 443 like any website, so it works, and mail genuinely comes from
// the Gmail account.) Needs a Google OAuth client and a refresh token; see README.
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const googleRefreshToken = process.env.GOOGLE_REFRESH_TOKEN;
const gmailSender = process.env.GMAIL_SENDER; // the Gmail address that authorized the token
// Where "Send to store" claims go (override with STORE_EMAIL if it ever changes).
const storeEmail = process.env.STORE_EMAIL || 'store7041@theupsstore.com';
const emailReady = !!(googleClientId && googleClientSecret && googleRefreshToken && gmailSender);

let cachedToken = null; // { value, expiresAt }
async function getAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60000) return cachedToken.value;
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(20000),
    body: new URLSearchParams({
      client_id: googleClientId,
      client_secret: googleClientSecret,
      refresh_token: googleRefreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    throw new Error(`Google token refresh failed (${resp.status}): ${JSON.stringify(data)}`);
  }
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

const wrap76 = b64 => b64.replace(/.{1,76}/g, '$&\r\n').trimEnd();
function buildMime({ from, to, subject, text, filename, zip }) {
  const boundary = 'claimassist_' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const encSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  return [
    `From: Claim Assist <${from}>`,
    `To: ${to}`,
    `Subject: ${encSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(text, 'utf8').toString('base64')),
    `--${boundary}`,
    `Content-Type: application/zip; name="${filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${filename}"`,
    '',
    wrap76(zip.toString('base64')),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

// Sends one email with a zip attachment. Throws on any failure.
async function sendEmail({ to, subject, text, filename, zip }) {
  const token = await getAccessToken();
  const mime = buildMime({ from: gmailSender, to, subject, text, filename, zip });
  const resp = await fetch('https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'message/rfc822' },
    signal: AbortSignal.timeout(60000),
    body: mime,
  });
  if (!resp.ok) throw new Error(`Gmail API responded ${resp.status}: ${await resp.text()}`);
}

// The send-to-store route carries photos as base64, so it gets a bigger body
// limit. It must be registered before the general 1mb parser below.
app.use('/api/send-to-store', express.json({ limit: '30mb' }));
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
  res.json({ ok: true, model: MODEL, hasApiKey: !!apiKey, hasEmail: emailReady });
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

// ---- Minimal zip writer (no dependency) ----
// Builds a standard .zip from [{name, data: Buffer}] using Node's built-in zlib.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function buildZip(files) {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const comp = zlib.deflateRawSync(f.data);
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

const safeName = s => String(s || 'item').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';
const MAX_ZIP_BYTES = 15 * 1024 * 1024; // base64 adds ~33%; Gmail's limit is 25MB per message

app.post('/api/send-to-store', async (req, res) => {
  const b = req.body || {};
  if (!b.customerPacket || !b.staffSummary) {
    return res.status(400).json({ error: 'customerPacket and staffSummary are required' });
  }
  if (!emailReady) {
    return res.status(503).json({ error: 'Email is not configured on this server' });
  }
  const typeLabel = CLAIM_TYPE_LABELS[b.claimType] || b.claimType || 'Claim';
  const tracking = String(b.tracking || '').trim();

  const files = [
    { name: 'customer-copy.txt', data: Buffer.from(String(b.customerPacket), 'utf8') },
    { name: 'staff-summary.txt', data: Buffer.from(String(b.staffSummary), 'utf8') },
    { name: 'claim-data.json', data: Buffer.from(JSON.stringify({
        claim_type: b.claimType, tracking, item: b.itemDescription, declared_value: b.declaredValue,
        details: b.details, risk_level: b.riskLevel,
        evidence: (Array.isArray(b.evidence) ? b.evidence : []).map(e => ({ item: e.label, marked_have: !!e.have, has_photo: !!e.photo })),
      }, null, 2), 'utf8') },
  ];

  let photoCount = 0;
  const evidence = Array.isArray(b.evidence) ? b.evidence.slice(0, 20) : [];
  evidence.forEach((e, i) => {
    const m = typeof e.photo === 'string' && e.photo.match(/^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return;
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[m[1]] || 'bin';
    files.push({ name: `photos/${String(i + 1).padStart(2, '0')}-${safeName(e.label)}.${ext}`, data: Buffer.from(m[2], 'base64') });
    photoCount++;
  });

  const zip = buildZip(files);
  if (zip.length > MAX_ZIP_BYTES) {
    return res.status(413).json({ error: 'Attachments are too large to email' });
  }

  try {
    await sendEmail({
      to: storeEmail,
      subject: `New claim to review — ${typeLabel}${tracking ? ` (${tracking})` : ''}`,
      text: `A customer submitted a claim through Claim Assist.\n\nClaim type: ${typeLabel}\nTracking: ${tracking || '—'}\nPhotos attached: ${photoCount}\nDenial risk: ${b.riskLevel || '—'}\n\nThe attached zip contains the customer copy, staff summary, claim data, and photos.\n\n${'='.repeat(60)}\nSTAFF SUMMARY\n${'='.repeat(60)}\n${b.staffSummary}\n`,
      filename: `claim-${safeName(tracking || typeLabel)}.zip`,
      zip,
    });
    res.json({ ok: true, photos: photoCount });
  } catch (err) {
    console.error('[send-to-store]', err.message);
    res.status(502).json({ error: 'Failed to send email' });
  }
});

app.listen(PORT, () => {
  console.log(`Claim Assist running at http://localhost:${PORT}`);
  if (!apiKey) {
    console.warn('WARNING: ANTHROPIC_API_KEY is not set. /api/classify and /api/generate will return errors, and the frontend will fall back to its offline template logic.');
  }
  if (!emailReady) {
    console.warn('WARNING: Gmail API is not configured (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GMAIL_SENDER). /api/send-to-store will return an error, and the "Send to store" button will show an error.');
  }
});
