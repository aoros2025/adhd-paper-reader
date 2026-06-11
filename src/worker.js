import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-4-8";

const SYSTEM_PROMPT = `You are a research assistant helping people with ADHD understand academic articles. Your job is to make dense research feel accessible and relevant -- not dumbed down, just human.

When given an academic article and asked to summarize it, produce a JSON object with this structure:

{
  "tldr": "One sentence. Plain language. No jargon. What did this study do and find?",
  "why_it_matters": "2-3 sentences. Connect this research to something real. Why should a non-academic person care? Write like you're texting a smart friend.",
  "key_takeaways": ["One clear idea per bullet. No sub-bullets. No hedging language like 'it may suggest.' Just what the research actually found or argued."],
  "sections": [{ "title": "The section heading as it appears in the article", "takeaways": ["One clear idea per bullet."] }],
  "words_to_know": [{ "term": "the jargon word", "definition": "what it actually means in plain English" }]
}

Rules:
- key_takeaways is a global summary of the whole article -- 5 to 7 items
- sections should reflect the actual structure of the article (Abstract, Introduction, Methods, Results, Discussion, etc.). Include every major section.
- Each section's takeaways should have 2 to 4 items
- words_to_know should only include terms that appear in your takeaways (global or section-level) and are not common knowledge
- Do not use markdown inside the JSON values
- Set "error" to an empty string. EXCEPT: if the PDF is not an academic article, set "error" to: "This doesn't look like an academic article. Try uploading a research paper or journal article." and leave the other fields as empty strings / empty arrays.

When asked to explain a specific point from the article, explain it in 3-5 sentences like you're talking to someone smart but unfamiliar with academic writing. No jargon. No references to the study methodology unless necessary. Just what it means and why it's interesting.`;

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    error: {
      type: "string",
      description:
        "Empty string for a real academic article. Otherwise the not-an-article error message.",
    },
    tldr: { type: "string" },
    why_it_matters: { type: "string" },
    key_takeaways: { type: "array", items: { type: "string" } },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          takeaways: { type: "array", items: { type: "string" } },
        },
        required: ["title", "takeaways"],
        additionalProperties: false,
      },
    },
    words_to_know: {
      type: "array",
      items: {
        type: "object",
        properties: {
          term: { type: "string" },
          definition: { type: "string" },
        },
        required: ["term", "definition"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "error",
    "tldr",
    "why_it_matters",
    "key_takeaways",
    "sections",
    "words_to_know",
  ],
  additionalProperties: false,
};

// 32MB is the Claude API's PDF limit; base64 inflates ~4/3, so cap the
// decoded size client- and server-side.
const MAX_PDF_BYTES = 32 * 1024 * 1024;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Both endpoints send the identical system prompt and PDF block first, with a
// cache breakpoint on the PDF — explain calls after a summarize hit the cache.
function pdfMessageContent(pdfBase64, instruction) {
  return [
    {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: pdfBase64,
      },
      cache_control: { type: "ephemeral" },
    },
    { type: "text", text: instruction },
  ];
}

// Tolerate whitespace in the secret name — dashboard-entered secrets can end
// up as "ANTHROPIC_API_KEY " and silently never bind to the expected name.
function resolveApiKey(env) {
  if (env.ANTHROPIC_API_KEY) return env.ANTHROPIC_API_KEY;
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string" && k.trim() === "ANTHROPIC_API_KEY") return v.trim();
  }
  return null;
}

async function handleSummarize(request, env) {
  const { pdf } = await request.json();
  if (!pdf) return json({ error: "Missing 'pdf' (base64) in request body." }, 400);
  if (pdf.length * 0.75 > MAX_PDF_BYTES)
    return json({ error: "PDF is too large. The limit is 32MB (about 100 pages)." }, 413);

  const client = new Anthropic({ apiKey: resolveApiKey(env) });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    output_config: {
      format: { type: "json_schema", schema: SUMMARY_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: pdfMessageContent(
          pdf,
          "Summarize this academic article using the JSON structure you were given."
        ),
      },
    ],
  });

  const text = response.content.find((b) => b.type === "text")?.text ?? "{}";
  return new Response(text, { headers: { "content-type": "application/json" } });
}

async function handleExplain(request, env) {
  const { pdf, bullet } = await request.json();
  if (!pdf || !bullet)
    return json({ error: "Missing 'pdf' or 'bullet' in request body." }, 400);
  if (pdf.length * 0.75 > MAX_PDF_BYTES)
    return json({ error: "PDF is too large. The limit is 32MB (about 100 pages)." }, 413);

  const client = new Anthropic({ apiKey: resolveApiKey(env) });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: pdfMessageContent(
          pdf,
          `The reader wants a plain-language explanation of this specific point from the article:\n\n"${bullet}"\n\nExplain it in 3-5 sentences like you're talking to someone smart but unfamiliar with academic writing. No jargon. Respond with the explanation only.`
        ),
      },
    ],
  });

  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  return json({ explanation: text.trim() });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") && !resolveApiKey(env))
      return json(
        { error: "Server isn't configured yet: run `npx wrangler secret put ANTHROPIC_API_KEY`." },
        500
      );
    try {
      if (request.method === "POST" && url.pathname === "/api/summarize")
        return await handleSummarize(request, env);
      if (request.method === "POST" && url.pathname === "/api/explain")
        return await handleExplain(request, env);
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError)
        return json({ error: "Server is missing a valid Anthropic API key." }, 500);
      if (err instanceof Anthropic.RateLimitError)
        return json({ error: "Too many requests right now. Wait a minute and try again." }, 429);
      if (err instanceof Anthropic.BadRequestError) {
        const detail = err.error?.error?.message ?? err.message;
        return json({ error: `Claude rejected the request: ${detail}` }, 400);
      }
      if (err instanceof Anthropic.APIError) {
        const detail = err.error?.error?.message ?? err.message;
        return json({ error: `Upstream error (${err.status}): ${detail}` }, 502);
      }
      console.error(err);
      return json({ error: "Something went wrong. Try again." }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};
