const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors({ origin: ['https://01checker.netlify.app', 'http://localhost:3000'] }));
app.use(express.json());

const POOL_PATH = path.join(__dirname, 'pool.json');
const MODEL = 'claude-sonnet-4-6';
const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

function loadPool() {
  try {
    return JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function savePool(pool) {
  fs.writeFileSync(POOL_PATH, JSON.stringify(pool, null, 2));
}

async function fetchPageText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 01Checker/1.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  // Strip tags, collapse whitespace, keep first ~3000 chars for Claude
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3000);
}

async function batchedMap(items, fn, { batchSize = 4, delayMs = 1000, onItem } = {}) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    if (i > 0) await new Promise((r) => setTimeout(r, delayMs));
    const batchResults = await Promise.all(
      items.slice(i, i + batchSize).map(async (item) => {
        const result = await fn(item);
        onItem?.(result);
        return result;
      })
    );
    results.push(...batchResults);
  }
  return results;
}

// POST /api/check
// Body: { urls: string[] }
// Streams SSE: progress events per URL, then a final done event with all results
app.post('/api/check', async (req, res) => {
  const { urls } = req.body;
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls must be a non-empty array' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const pool = loadPool();
  const total = urls.length;
  let checked = 0;

  try {
    const results = await batchedMap(urls, async (url) => {
      // Exact URL match against pool
      const exact = pool.find((t) => t.url === url);
      if (exact) {
        return {
          url,
          status: 'duplicate',
          match: { title: exact.practice_title, country: exact.country, agency: exact.agency, url: exact.url },
        };
      }

      if (pool.length === 0) {
        return { url, status: 'new' };
      }

      // Fetch page content (10s timeout via fetchPageText)
      let pageText;
      try {
        pageText = await fetchPageText(url);
      } catch (err) {
        return { url, status: 'new', fetchError: err.message };
      }

      const poolSummary = pool
        .map((t, i) => `${i}. title="${t.practice_title}" country="${t.country}" agency="${t.agency}" url="${t.url}"`)
        .join('\n');

      // Claude duplicate check (30s timeout)
      let message;
      try {
        message = await client.messages.create(
          {
            model: MODEL,
            max_tokens: 256,
            messages: [
              {
                role: 'user',
                content: `You are a strict duplicate detector for government open-data and civic-tech practices.

EXISTING POOL (index. title / country / agency / url):
${poolSummary}

NEW PAGE CONTENT (first 3000 chars):
${pageText}

NEW PAGE URL: ${url}

TASK: Return duplicate:true ONLY if the new page is the EXACT SAME real-world practice as a pool entry — meaning it is run by the SAME government entity, in the SAME country/city, and is the SAME specific initiative (not just the same topic).

RULES:
- Same subject area or policy domain alone → NOT a duplicate
- Same country but different agency or different initiative → NOT a duplicate
- Same agency but different program → NOT a duplicate
- Only identical initiative from the identical government entity → duplicate

EXAMPLES:
- Pool has "UK HMRC Making Tax Digital"; new page is about "Australia ATO Digital Tax Lodgment" → {"status":"new"} (same topic, different country/agency)
- Pool has "NYC Open Data Portal"; new page is about "Chicago Open Data Portal" → {"status":"new"} (same concept, different city)
- Pool has "NYC Open Data Portal"; new page is a different URL for the same NYC Open Data Portal → {"status":"duplicate","index":<index>}
- Pool has "Estonia X-Road data exchange"; new page is about "Finland X-Road deployment" → {"status":"new"} (same platform, different country instance)

Respond with ONLY valid JSON:
- If duplicate: {"status":"duplicate","index":<pool index>}
- If new: {"status":"new"}`,
              },
            ],
          },
          { signal: AbortSignal.timeout(30000) }
        );
      } catch (err) {
        return { url, status: 'new', fetchError: `Claude: ${err.message}` };
      }

      let parsed;
      try {
        const text = message.content[0].text.trim();
        parsed = JSON.parse(text.match(/\{[\s\S]*\}/)[0]);
      } catch {
        parsed = { status: 'new' };
      }

      if (parsed.status === 'duplicate' && typeof parsed.index === 'number') {
        const match = pool[parsed.index];
        return {
          url,
          status: 'duplicate',
          match: { title: match.practice_title, country: match.country, agency: match.agency, url: match.url },
        };
      }
      return { url, status: 'new' };
    }, {
      onItem: (result) => {
        checked++;
        sendEvent({
          checked,
          total,
          url: result.url,
          status: result.status === 'duplicate' ? 'duplicate' : result.fetchError ? 'error' : 'new',
        });
      },
    });

    sendEvent({ done: true, results });
  } catch (err) {
    sendEvent({ error: err.message });
  }

  res.end();
});

// POST /api/extract
// Body: { urls: string[] }
// Returns: { results: Array<{ url, country, agency, practice_title, description }|{ url, error }> }
app.post('/api/extract', async (req, res) => {
  const { urls } = req.body;
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls must be a non-empty array' });
  }

  const results = await batchedMap(urls, async (url) => {
    let pageText;
    try {
      pageText = await fetchPageText(url);
    } catch (err) {
      return { url, error: `Failed to fetch: ${err.message}` };
    }

    // Claude metadata extraction (30s timeout)
    let message;
    try {
      message = await client.messages.create(
        {
          model: MODEL,
          max_tokens: 512,
          messages: [
            {
              role: 'user',
              content: `Extract structured metadata from this government/civic-tech practice page.

PAGE URL: ${url}
PAGE CONTENT (first 3000 chars):
${pageText}

Respond entirely in Arabic. All field values must be in Arabic.

Respond with ONLY valid JSON (no markdown, no extra text):
{
  "country": "<اسم الدولة>",
  "agency": "<اسم الجهة الحكومية أو المؤسسة>",
  "practice_title": "<عنوان قصير ووصفي للممارسة>",
  "description": "<ما تفعله هذه الممارسة، بحد أقصى 80 كلمة>"
}`,
            },
          ],
        },
        { signal: AbortSignal.timeout(30000) }
      );
    } catch (err) {
      return { url, error: `Claude API error: ${err.message}` };
    }

    let extracted;
    try {
      const text = message.content[0].text.trim();
      extracted = JSON.parse(text.match(/\{[\s\S]*\}/)[0]);
    } catch {
      return { url, error: 'Failed to parse Claude response' };
    }

    return { url, ...extracted };
  });

  res.json({ results });
});

// POST /api/add
// Body: { topics: Array<{ url, country, agency, practice_title, description }> }
// Returns: { added: number, pool_size: number }
app.post('/api/add', (req, res) => {
  const { topics } = req.body;
  if (!Array.isArray(topics) || topics.length === 0) {
    return res.status(400).json({ error: 'topics must be a non-empty array' });
  }

  const pool = loadPool();
  let added = 0;

  for (const topic of topics) {
    if (!topic.url) continue;
    const exists = pool.some((t) => t.url === topic.url);
    if (!exists) {
      pool.push({
        url: topic.url,
        country: topic.country || '',
        agency: topic.agency || '',
        practice_title: topic.practice_title || '',
        description: topic.description || '',
        added_at: new Date().toISOString(),
      });
      added++;
    }
  }

  savePool(pool);
  res.json({ added, pool_size: pool.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`01Checker running on port ${PORT}`);
});
