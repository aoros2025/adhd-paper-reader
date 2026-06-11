import Anthropic from "@anthropic-ai/sdk";

// Hybrid setup: Gemini Flash reads the PDF and produces the structured summary
// (cheap per input token, free tier, handles very long documents); Claude
// Sonnet writes the tap-to-explain answers from the summary context (small
// requests where writing quality matters most).
const GEMINI_MODEL = "gemini-2.5-flash";
const CLAUDE_MODEL = "claude-sonnet-4-6";

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

const REWRITE_SYSTEM_PROMPT = `You are an academic writing assistant. The user will give you rough notes, stream-of-consciousness thoughts, or bullet points. Your job is to rewrite them as a polished academic paragraph AND explain the key translation choices you made.

Produce a JSON object with this structure:

{
  "paragraph": "The polished academic paragraph.",
  "suggestions": ["Brief note about a specific translation choice and why it fits academic writing."]
}

Rules:
- Preserve every idea the user included. Do not add new claims.
- Use formal academic register but stay readable. No unnecessarily complex words.
- Write in third person unless the input is clearly first-person reflection.
- No hedging phrases like "it is important to note." Just make the point.
- suggestions should have 3 to 5 items. Be specific -- reference the actual words changed.`;

const REWRITE_SCHEMA = {
  type: "object",
  properties: {
    paragraph: { type: "string" },
    suggestions: { type: "array", items: { type: "string" } },
  },
  required: ["paragraph", "suggestions"],
  additionalProperties: false,
};

// Gemini's responseSchema uses OpenAPI-style types.
const GEMINI_SUMMARY_SCHEMA = {
  type: "OBJECT",
  properties: {
    error: {
      type: "STRING",
      description:
        "Empty string for a real academic article. Otherwise the not-an-article error message.",
    },
    tldr: { type: "STRING" },
    why_it_matters: { type: "STRING" },
    key_takeaways: { type: "ARRAY", items: { type: "STRING" } },
    sections: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          takeaways: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["title", "takeaways"],
      },
    },
    words_to_know: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          term: { type: "STRING" },
          definition: { type: "STRING" },
        },
        required: ["term", "definition"],
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
  propertyOrdering: [
    "error",
    "tldr",
    "why_it_matters",
    "key_takeaways",
    "sections",
    "words_to_know",
  ],
};

// Gemini inline requests cap at 20MB total, so ~15MB of raw PDF after base64
// inflation. Page count is rarely the limit — text-heavy PDFs run well past
// 100 pages under 15MB.
const MAX_PDF_BASE64_CHARS = 20 * 1024 * 1024;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Tolerate whitespace in secret names — dashboard-entered secrets can end up
// as "ANTHROPIC_API_KEY " and silently never bind to the expected name.
function resolveKey(env, name) {
  if (env[name]) return env[name];
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string" && k.trim() === name) return v.trim();
  }
  return null;
}

async function handleSummarize(request, env) {
  const { pdf } = await request.json();
  if (!pdf) return json({ error: "Missing 'pdf' (base64) in request body." }, 400);
  if (pdf.length > MAX_PDF_BASE64_CHARS)
    return json({ error: "PDF is too large. The limit is 15MB." }, 413);

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": resolveKey(env, "GEMINI_API_KEY"),
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: "application/pdf", data: pdf } },
              {
                text: "Summarize this academic article using the JSON structure you were given.",
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: GEMINI_SUMMARY_SCHEMA,
        },
      }),
    }
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 429)
      return json(
        { error: "Hit the Gemini rate limit (free tier). Wait a minute and try again." },
        429
      );
    if (res.status === 400 || res.status === 403)
      return json({ error: `Gemini rejected the request: ${detail}` }, 400);
    return json({ error: `Gemini error (${res.status}): ${detail}` }, 502);
  }

  const text = data.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? "")
    .join("");
  if (!text)
    return json(
      { error: "Gemini returned no summary. The PDF may be unreadable — try a different file." },
      502
    );
  return new Response(text, { headers: { "content-type": "application/json" } });
}

async function handleExplain(request, env) {
  const { bullet, summary } = await request.json();
  if (!bullet) return json({ error: "Missing 'bullet' in request body." }, 400);

  const context = summary
    ? `Here is the summary of the article the reader is looking at:\n\n${JSON.stringify(summary)}\n\n`
    : "";

  const client = new Anthropic({ apiKey: resolveKey(env, "ANTHROPIC_API_KEY") });
  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2000,
    output_config: { effort: "medium" },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `${context}The reader wants a plain-language explanation of this specific point from the article:\n\n"${bullet}"\n\nExplain it in 3-5 sentences like you're talking to someone smart but unfamiliar with academic writing. No jargon. Respond with the explanation only.`,
      },
    ],
  });

  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  return json({ explanation: text.trim() });
}

async function handleRewrite(request, env) {
  const { notes } = await request.json();
  if (!notes || !notes.trim())
    return json({ error: "Missing 'notes' in request body." }, 400);
  if (notes.length > 20000)
    return json({ error: "That's a lot of notes — keep it under 20,000 characters (about a paragraph's worth of ideas at a time works best)." }, 413);

  const client = new Anthropic({ apiKey: resolveKey(env, "ANTHROPIC_API_KEY") });
  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    system: REWRITE_SYSTEM_PROMPT,
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: REWRITE_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: `Here are my rough notes. Rewrite them as a polished academic paragraph and explain your translation choices:\n\n${notes}`,
      },
    ],
  });

  const text = response.content.find((b) => b.type === "text")?.text ?? "{}";
  return new Response(text, { headers: { "content-type": "application/json" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/summarize" && !resolveKey(env, "GEMINI_API_KEY"))
      return json(
        { error: "Server isn't configured yet: run `npx wrangler secret put GEMINI_API_KEY` (free key at aistudio.google.com/apikey)." },
        500
      );
    if ((url.pathname === "/api/explain" || url.pathname === "/api/rewrite") && !resolveKey(env, "ANTHROPIC_API_KEY"))
      return json(
        { error: "Server isn't configured yet: run `npx wrangler secret put ANTHROPIC_API_KEY`." },
        500
      );
    try {
      if (request.method === "POST" && url.pathname === "/api/summarize")
        return await handleSummarize(request, env);
      if (request.method === "POST" && url.pathname === "/api/explain")
        return await handleExplain(request, env);
      if (request.method === "POST" && url.pathname === "/api/rewrite")
        return await handleRewrite(request, env);
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
