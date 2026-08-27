# Ask about Chana

A tiny reference agent for a recruiter to ask questions about Chana Froind's real work
history and get answers grounded in 223 documented cases. No vector DB, no framework — one
static HTML page and one serverless function that sends the whole corpus to Claude on every
request, cached.

## How it works

- `data/instructions.md` and `data/corpus.md` are the entire knowledge base. They are never
  edited by the app — read once, concatenated, sent verbatim as the system prompt.
- `api/ask.js` is the only server code: a Vercel serverless function that streams a response
  from Claude and enforces rate limits.
- `public/index.html` is the whole front end: one file, inline CSS/JS, no build step.

## Setup

### 1. Get an API key

Create a key at [console.anthropic.com](https://console.anthropic.com/settings/keys). You'll
need billing enabled on the account (see the cost note below for what this actually costs).

### 2. Add the key to Vercel

If you don't have the Vercel CLI yet:

```bash
npm install -g vercel
```

Link the project (first time only) and add the key as an environment variable:

```bash
vercel link
vercel env add ANTHROPIC_API_KEY
```

Paste the key when prompted. Add it for all three environments (Production, Preview,
Development) if asked.

### 3. Deploy

```bash
vercel deploy --prod
```

That's it — the deployed URL is what goes on the CV.

### Running locally

Copy `.env.example` to `.env` and fill in your key, then:

```bash
npm install
vercel dev
```

This runs the static page and the serverless function together at `http://localhost:3000`.

### Updating the corpus

`data/corpus.md` is regenerated periodically from a larger source under a fixed token budget.
When a new version arrives, just replace the file and redeploy — nothing in the code depends
on its length, its episode count, or any episode id.

## Cost

Model: `claude-sonnet-5` — $2/MTok input, $10/MTok output. A cached read is 0.1× the input
price, i.e. $0.20/MTok.

The cached system prompt (instructions + corpus) is about 136K tokens:

- A **cache write** (first question in an hour, or after the 1-hour TTL expires): ~**$0.54**.
- A **cache read** (every question after that, within the hour): ~**$0.027**.

A realistic recruiter session — one write plus four reads — costs roughly **$0.65**. Traffic
is capped server-side (10 questions/hour and 40/day per visitor, 300/day total across
everyone) specifically to keep a worst-case day bounded and predictable.
