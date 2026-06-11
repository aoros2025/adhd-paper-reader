# Paper Brain — ADHD-friendly academic article reader

Upload an academic PDF and get a plain-language breakdown: a one-sentence TL;DR, why it matters, key takeaways, a section-by-section summary, and a jargon glossary. Tap any takeaway to get it explained in 3–5 friendly sentences.

## Hybrid model setup

Two models split the work by what each is best at:

- **Gemini 2.5 Flash** reads the PDF and produces the structured summary — the token-heavy part. Free tier covers personal use; handles long PDFs (the limit is 15MB of file size, not 100 pages).
- **Claude Sonnet 4.6** writes the tap-to-explain answers from the summary context — small requests where writing quality matters most (~1¢ each, no PDF re-upload).

```
public/index.html   → static frontend (drag-and-drop PDF, renders the summary)
src/worker.js       → Cloudflare Worker
  POST /api/summarize  → Gemini 2.5 Flash, schema-enforced JSON summary
  POST /api/explain    → Claude Sonnet 4.6, plain-language explanation of one bullet
```

## Setup from scratch

```sh
npm install

# 1. Authenticate wrangler (once)
npx wrangler login

# 2. Set both API keys as Worker secrets
#    Gemini: free key at https://aistudio.google.com/apikey
#    Claude: https://platform.claude.com/settings/keys
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY

# 3. Deploy
npm run deploy
```

Prefer the CLI over the Cloudflare dashboard for secrets — a pasted name with a stray space won't bind (the Worker tolerates trailing whitespace in secret names, but the CLI avoids the problem entirely).

## Local development

```sh
printf 'GEMINI_API_KEY=...\nANTHROPIC_API_KEY=sk-ant-...\n' > .dev.vars
npm run dev
```

## Auto-deploy from GitHub (optional)

Pushes to `main` deploy automatically once you add a repo secret:

1. Create a Cloudflare API token at <https://dash.cloudflare.com/profile/api-tokens> using the **Edit Cloudflare Workers** template.
2. Add it to the GitHub repo: Settings → Secrets and variables → Actions → New repository secret → name `CLOUDFLARE_API_TOKEN`.

## Limits

- PDFs up to 15MB (Gemini inline request limit); page count is rarely the constraint for text PDFs
- The PDF never leaves memory in the browser; it's sent once per summarize and not stored anywhere
- Free-tier Gemini requests may be used by Google for product improvement — use a paid key for sensitive documents
