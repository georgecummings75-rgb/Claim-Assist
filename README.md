# Claim Assist

An AI-guided intake tool for shipment claims (damaged, lost, delayed, or value-dispute
packages). A customer describes what happened, the tool classifies the claim type,
walks them through the right follow-up questions and evidence checklist, and generates
a customer-facing packet plus an internal staff summary — including a denial-risk flag
when documentation is incomplete.

Built for an MBA 508 capstone (AI use / prompt engineering) grounded in claims intake
at a The UPS Store franchise.

## How it's put together

```
claim-assist/
├── public/
│   ├── index.html      landing page
│   ├── app.html        the claim intake tool
│   └── styles.css       shared styling
├── server.js            Express backend — proxies AI calls, serves the frontend
├── package.json
├── .env.example
└── README.md
```

The frontend never talks to Anthropic directly. It calls two routes on the backend
(`/api/classify`, `/api/generate`), and the backend holds the API key and calls
Anthropic's API server-side. This is the standard reason a static page can't be "the
whole app" for anything AI-powered: a key embedded in browser JavaScript is visible to
anyone who opens dev tools, so the call has to be proxied through a server that keeps
the key private.

## Running it locally

Requires [Node.js](https://nodejs.org) 18 or later.

```bash
cd claim-assist
npm install
cp .env.example .env
# edit .env and paste in a real Anthropic API key (console.anthropic.com)
npm start
```

Then open `http://localhost:3000`.

If you skip the API key, the app still runs — the frontend falls back to a
deterministic, rule-based version of the checklist and risk score (see "Failure
handling" below) instead of the AI-generated one. That's intentional: it's what lets
you demo the tool even without a key, and it's a real design decision worth
discussing in the "risk / controls" section of your report.

## Deploying it somewhere real

This is a standard two-piece Node app (static frontend + small API), so it runs on any
Node host. A few options, roughly easiest first:

- **Render** or **Railway** — connect the GitHub repo, set the `ANTHROPIC_API_KEY`
  environment variable in their dashboard, and both platforms auto-detect
  `npm start`. No server management.
- **Fly.io** — `fly launch` in this folder, then `fly secrets set ANTHROPIC_API_KEY=...`.
- **A plain VPS** (DigitalOcean, Linode, etc.) — clone the repo, `npm install`,
  set the env var, and run it behind a process manager like `pm2` or as a
  `systemd` service, with Nginx or Caddy in front for HTTPS.

Whichever host you use, only two things are required: Node 18+, and the
`ANTHROPIC_API_KEY` environment variable set on the server (never in the frontend
code, never committed to git).

## What this prototype does and doesn't do

Worth stating plainly, since a capstone evaluation should be honest about scope:

- **No real carrier integration.** It doesn't file anything with UPS's actual claims
  system — it prepares a complete, well-organized packet a person still submits.
- **No persistent storage.** Photo "uploads" are held in the browser as data URLs for
  the current session only; nothing is saved to a database or file storage. A real
  deployment would need actual file storage (e.g., S3-compatible storage) and,
  because these are customer photos and claim details, a real privacy/retention
  policy — not something to improvise.
- **No authentication.** Anyone with the link can use it. Fine for a kiosk or an
  internal pilot; not fine as a public, unauthenticated intake point for a real
  business without adding at least basic protections.
- **Failure handling.** If the AI backend is unreachable or misconfigured, the
  frontend automatically falls back to a rule-based version: a customer copy built
  from a template, and a risk score that's just "how many checklist items are still
  unchecked." This means the tool degrades gracefully rather than blocking someone
  from filing a claim — but it also means the two code paths (AI-generated vs.
  fallback) can produce meaningfully different document quality, which is worth
  testing and reporting on directly.
- **Not reviewed by UPS corporate or franchise legal/brand counsel.** Before this (or
  anything like it) touched a real customer under The UPS Store name, it would need
  sign-off on branding, data handling, and how it interacts with the actual claims
  process — this prototype exists for capstone evaluation, not production use.

## The two AI calls, for reference

Both prompts live in `server.js` (`buildExtractionPrompt`, `buildFinalDocsPrompt`) and
are unchanged from the logic used during design — useful if your written report wants
to quote them directly:

1. **Classification** (`/api/classify`) — takes the customer's free-text description
   and returns a structured guess at claim type, item, value, and two follow-up
   questions, with a confidence score.
2. **Document generation** (`/api/generate`) — takes the full structured intake
   (claim type, details, evidence checklist) and returns the customer packet, staff
   summary, and a risk assessment with reasons.

Both are instructed to return raw JSON only, which the backend parses directly —
worth noting as a design decision if your report discusses prompt engineering
choices (structured-output prompting vs. free-form generation with post-hoc parsing).
