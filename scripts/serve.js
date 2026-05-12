#!/usr/bin/env node
/**
 * Liquid-State Engine — Dev Server with DeepSeek AI Proxy
 *
 * Serves the web/ directory with COOP/COEP headers required for
 * SharedArrayBuffer support in Web Workers.
 *
 * Provides a /api/enrich endpoint that proxies AI enrichment requests
 * to the DeepSeek API (OpenAI-compatible) with intelligent model routing
 * based on keyword complexity.
 *
 * Required headers:
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 *
 * Environment (set in .env or system):
 *   DEEPSEEK_API_KEY — API key for api.deepseek.com (required for /api/enrich)
 *   MODEL_LITE / MODEL_STANDARD / MODEL_ULTRA — optional model overrides
 *
 * Usage:
 *   node scripts/serve.js [port]
 */

// Load .env from project root (scripts/ → ../.env)
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const http = require('http');
const https = require('https');
const fs = require('fs');

const PORT = process.argv[2] || 8080;
const ROOT = path.resolve(__dirname, '..', 'web');
const PKG = path.resolve(__dirname, '..', 'web', 'pkg');

// DeepSeek API configuration (OpenAI-compatible)
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';

// ---- Model Routing (env-overridable) ----

const MODEL_LITE     = process.env.MODEL_LITE     || 'deepseek-chat';
const MODEL_STANDARD = process.env.MODEL_STANDARD || 'deepseek-chat';
const MODEL_ULTRA    = process.env.MODEL_ULTRA    || 'deepseek-reasoner';

/** Keywords that always trigger the ULTRA reasoning tier. */
const ULTRA_KEYWORDS = /\b(blockchain|rust|physics|system|quantum|algorithm|cryptography|compiler|kernel|protocol|ontology|epistemology|metaphysics)\b/i;

/** Symbols indicating technical/formal content. */
const TECHNICAL_SYMBOLS = /[-_#@+*\/\\\(\)\[\]{}<>|&^~`'"=.:;!?]/;

/**
 * Evaluate keyword complexity to determine the appropriate DeepSeek model tier.
 *
 * @param {string} keyword
 * @returns {{ tier: string, model: string, reason: string }}
 */
function evaluateComplexity(keyword) {
  const trimmed = keyword.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  const charCount = trimmed.length;

  // ULTRA: technical keywords with symbols, or matching ULTRA domain patterns
  if (TECHNICAL_SYMBOLS.test(trimmed) || ULTRA_KEYWORDS.test(trimmed)) {
    return {
      tier: 'ULTRA',
      model: MODEL_ULTRA,
      reason: `technical content detected (symbols: ${TECHNICAL_SYMBOLS.test(trimmed)}, domain: ${ULTRA_KEYWORDS.test(trimmed)})`,
    };
  }

  // LITE: short, simple keywords
  if (wordCount <= 2 && charCount < 10) {
    return {
      tier: 'LITE',
      model: MODEL_LITE,
      reason: `short keyword (${wordCount} word(s), ${charCount} chars)`,
    };
  }

  // STANDARD: everything in between
  return {
    tier: 'STANDARD',
    model: MODEL_STANDARD,
    reason: `moderate complexity (${wordCount} word(s), ${charCount} chars)`,
  };
}

// ---- MIME Map ----

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---- Static File Serving ----

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';

  try {
    const stat = fs.statSync(filePath);
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

// ---- AI Enrichment API ----

/**
 * POST /api/enrich
 *
 * Two modes:
 *   Fracture (default): { keyword: string }
 *     → returns { components: string[], model, tier }
 *   Merge: { mode: "merge", keywords: [string, string] }
 *     → returns { result: string, model, tier }
 *
 * Headers: X-DeepSeek-Model: <model-name>
 */
function handleEnrich(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Allow': 'POST' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  if (!DEEPSEEK_API_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Server not configured',
      detail: 'Set DEEPSEEK_API_KEY environment variable.',
    }));
    return;
  }

  // Read request body
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body.' }));
      return;
    }

    // ---- Merge Mode ----
    if (parsed.mode === 'merge' && Array.isArray(parsed.keywords) && parsed.keywords.length === 2) {
      handleMerge(parsed.keywords[0], parsed.keywords[1], res);
      return;
    }

    // ---- Fracture Mode (default) ----
    const keyword = (parsed.keyword || '').trim();
    if (!keyword) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'keyword is required.' }));
      return;
    }

    // Evaluate complexity and select model
    const { tier, model, reason } = evaluateComplexity(keyword);
    console.log(`[DeepSeek] "${keyword}" → ${tier} (${model}) — ${reason}`);

    // System + user message split for better instruction following
    const temperature = 0.3;
    const maxTokens = 512;

    const requestBody = JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: 'You are a logical data extractor. Break down the user\'s concept into 4 to 7 fundamental scientific, physical, or conceptual components. Return ONLY a valid JSON array of strings. No markdown, no explanations. Example: ["Refraction", "Water Droplets", "Light Spectrum"]',
        },
        {
          role: 'user',
          content: keyword,
        },
      ],
      temperature,
      max_tokens: maxTokens,
      stream: false,
    });

    const options = {
      hostname: 'api.deepseek.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Accept': 'application/json',
      },
    };

    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => { data += chunk; });
      apiRes.on('end', () => {
        if (apiRes.statusCode !== 200) {
          console.error(`[DeepSeek] API error ${apiRes.statusCode}: ${data.slice(0, 300)}`);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: `DeepSeek API returned ${apiRes.statusCode}`,
            detail: data.slice(0, 500),
          }));
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const rawText = parsed?.choices?.[0]?.message?.content?.trim() ?? '';

          // Parse the AI response into components
          const components = parseComponents(rawText, keyword);

          const responseBody = JSON.stringify({
            components,
            model,
            tier,
            keyword,
          });

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'X-DeepSeek-Model': model,
            'X-DeepSeek-Tier': tier,
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'X-DeepSeek-Model, X-DeepSeek-Tier',
          });
          res.end(responseBody);

          console.log(`[DeepSeek] "${keyword}" → ${components.length} components via ${model}`);
        } catch (err) {
          console.error('[DeepSeek] Parse error:', err.message, 'raw:', data.slice(0, 200));
          // Return a fallback array instead of 500
          const fallbackComponents = keyword.split(/[\s,;]+/).filter(Boolean);
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'X-DeepSeek-Model': model,
            'X-DeepSeek-Tier': tier,
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'X-DeepSeek-Model, X-DeepSeek-Tier',
          });
          res.end(JSON.stringify({
            components: fallbackComponents.length > 0 ? fallbackComponents : [keyword],
            model,
            tier,
            keyword,
            fallback: true,
          }));
        }
      });
    });

    apiReq.on('error', (err) => {
      console.error('[DeepSeek] Network error:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'DeepSeek API unreachable', detail: err.message }));
    });

    apiReq.write(requestBody);
    apiReq.end();
  });
}

/**
 * Parse the AI response text into an array of component strings.
 */
function parseComponents(text, keyword) {
  let cleaned = text.trim();

  // Aggressively strip ALL markdown code fences (anywhere in the response)
  cleaned = cleaned.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  // Also strip leading/trailing backticks that aren't full fences
  cleaned = cleaned.replace(/^`+|`+$/g, '').trim();

  // Try JSON parse
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      const items = parsed.map(String).filter(s => s.trim().length > 0);
      if (items.length > 0) return items;
    }
  } catch { /* fall through */ }

  // Fallback: bulleted or numbered list
  const lines = cleaned.split(/[\n\r]+/).filter(Boolean);
  const items = lines
    .map(line => line.replace(/^[\s]*[-*•\d]+[.)]\s*/, '').trim())
    .map(line => line.replace(/^["'\s]+|["'\s]+$/g, ''))
    .filter(s => s.length > 0 && s.length < 100);

  if (items.length > 0) return items;

  // Last resort: split keyword itself
  const words = keyword.split(/[\s,;]+/).filter(Boolean);
  if (words.length > 1) return words;

  throw new Error(`Could not parse components. Raw: ${cleaned.slice(0, 100)}`);
}

// ---- Merge Handler ----

function handleMerge(keywordA, keywordB, res) {
  const combined = `${keywordA} + ${keywordB}`;
  const { tier, model, reason } = evaluateComplexity(combined);
  console.log(`[DeepSeek Merge] "${keywordA}" + "${keywordB}" → ${tier} (${model}) — ${reason}`);

  const requestBody = JSON.stringify({
    model,
    messages: [
      {
        role: 'system',
        content: 'You are a Master Alchemist. Combine the two concepts into ONE new, logical, and creative entity. Return ONLY that single word. No markdown, no quotes.',
      },
      {
        role: 'user',
        content: `${keywordA} + ${keywordB}`,
      },
    ],
    temperature: 0.3,
    max_tokens: 200,
    stream: false,
  });

  const options = {
    hostname: 'api.deepseek.com',
    port: 443,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
      'Accept': 'application/json',
    },
  };

  const apiReq = https.request(options, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => { data += chunk; });
    apiRes.on('end', () => {
      if (apiRes.statusCode !== 200) {
        console.error(`[DeepSeek Merge] API error ${apiRes.statusCode}: ${data.slice(0, 300)}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `DeepSeek API returned ${apiRes.statusCode}` }));
        return;
      }

      try {
        const parsed = JSON.parse(data);
        const rawText = parsed?.choices?.[0]?.message?.content?.trim() ?? '';

        // Clean up: strip markdown, quotes, punctuation, newlines
        let result = rawText
          .replace(/```(?:json)?\s*/gi, '').replace(/```/g, '') // markdown fences
          .split('\n')[0].trim();
        result = result.replace(/^["'\s]+|["'\s]+$/g, '').replace(/[.!?,;:]+$/, '').trim();

        // Fallback: if empty/joined/unusable, use creative scientific fallback
        if (!result || result.length > 60
            || result === `${keywordA}-${keywordB}`
            || result === `${keywordA} ${keywordB}`
            || result.toLowerCase() === 'stable matter') {
          result = 'Conceptual Anomaly';
          console.log(`[DeepSeek Merge] Empty/unusable response, fallback: "${result}"`);
        }

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-DeepSeek-Model': model,
          'X-DeepSeek-Tier': tier,
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'X-DeepSeek-Model, X-DeepSeek-Tier',
        });
        res.end(JSON.stringify({ result, model, tier }));

        console.log(`[DeepSeek Merge] "${keywordA}" + "${keywordB}" → "${result}" via ${model}`);
      } catch (err) {
        console.error('[DeepSeek Merge] Parse error:', err.message);
        const fallback = 'Unstable Isotope';
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-DeepSeek-Model': model,
          'X-DeepSeek-Tier': tier,
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'X-DeepSeek-Model, X-DeepSeek-Tier',
        });
        res.end(JSON.stringify({ result: fallback, model, tier, fallback: true }));
      }
    });
  });

  apiReq.on('error', (err) => {
    console.error('[DeepSeek Merge] Network error:', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'DeepSeek API unreachable' }));
  });

  apiReq.write(requestBody);
  apiReq.end();
}

// ---- HTTP Server ----

const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // API routes
  if (url.pathname === '/api/enrich') {
    handleEnrich(req, res);
    return;
  }

  // Static file routes
  let urlPath = url.pathname;
  if (urlPath === '/' || urlPath === '') {
    urlPath = '/index.html';
  }

  const relPath = urlPath.replace(/^\/+/, '');
  let filePath = path.join(ROOT, relPath);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(PKG, relPath.replace(/^web\//, ''));
  }
  if (!fs.existsSync(filePath) && relPath.startsWith('pkg/')) {
    filePath = path.resolve(__dirname, '..', relPath);
  }

  serveFile(res, filePath);
});

server.listen(PORT, () => {
  console.log(`\n🌊 Liquid-State Engine dev server running at http://localhost:${PORT}/`);
  console.log(`   COOP: same-origin`);
  console.log(`   COEP: require-corp`);
  console.log(`   Root: ${ROOT}`);
  console.log(`   SharedArrayBuffer: ENABLED`);
  console.log(`\n   DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY ? '✓ Loaded (starts with ' + DEEPSEEK_API_KEY.slice(0, 5) + '...)' : '✗ NOT SET — /api/enrich disabled'}`);
  console.log(`   DeepSeek AI Proxy:`);
  if (DEEPSEEK_API_KEY) {
    console.log(`   ✓ DEEPSEEK_API_KEY configured`);
    console.log(`   ✓ POST /api/enrich — intelligent model routing`);
    console.log(`     LITE     → ${MODEL_LITE} (short/simple keywords)`);
    console.log(`     STANDARD → ${MODEL_STANDARD} (moderate complexity)`);
    console.log(`     ULTRA    → ${MODEL_ULTRA} (technical/formal content)`);
  } else {
    console.log(`   ⚠ DEEPSEEK_API_KEY not set — /api/enrich disabled`);
    console.log(`     Set the environment variable and restart.`);
  }
  console.log('');
});
