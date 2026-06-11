# Paper Brain — ADHD-friendly academic article reader

Upload an academic PDF and get a plain-language breakdown: a one-sentence TL;DR, why it matters, key takeaways, a section-by-section summary, and a jargon glossary. Tap any takeaway to get it explained in 3–5 friendly sentences.

Built as a single Cloudflare Worker (static frontend + API) calling the Claude API (`claude-opus-4-8`). The PDF is cached server-side via prompt caching, so tap-to-explain follow-ups are fast and cheap.

## Architecture

```
public/index.html   → static frontend (drag-and-drop PDF, renders the summary)
src/worker.js       → Cloudflare Worker
  POST /api/summarize  → Claude, structured JSON output (schema-enforced)
  POST /api/explain    → Claude, plain-language explanation of one bullet
```

## Setup from scratch

```sh
npm install

# 1. Authenticate wrangler (once)
npx wrangler login

# 2. Set your Anthropic API key as a Worker secret
npx wrangler secret put ANTHROPIC_API_KEY

# 3. Deploy
npm run deploy
```

## Local development

```sh
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .dev.vars
npm run dev
```

## Auto-deploy from GitHub (optional)

Pushes to `main` deploy automatically once you add a repo secret:

1. Create a Cloudflare API token at <https://dash.cloudflare.com/profile/api-tokens> using the **Edit Cloudflare Workers** template.
2. Add it to the GitHub repo: Settings → Secrets and variables → Actions → New repository secret → name `CLOUDFLARE_API_TOKEN`.

## Limits

- PDFs up to 32MB / ~100 pages (Claude API document limit)
- The PDF never leaves memory in the browser; it's sent per-request and not stored anywhere
