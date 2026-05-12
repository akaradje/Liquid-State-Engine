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
      handleMerge(parsed.keywords[0], parsed.keywords[1], res, parsed.context || '');
      return;
    }

    // ---- Fracture Mode (default) with 2-step reasoning ----
    const keyword = (parsed.keyword || '').trim();
    const context = (parsed.context || '').trim();
    if (!keyword) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'keyword is required.' }));
      return;
    }

    // Step 1: Analyze the domain of the keyword
    analyzeDomain(keyword, (domainResult) => {
      const { domain, depth, reasoning } = domainResult;
      console.log(`[DeepSeek Domain] "${keyword}" → ${domain} (depth: ${depth})`);

      // Step 2: Build domain-specific decomposition prompt
      const domainPrompt = getDomainPrompt(domain, depth);

      let userMessage = keyword;
      if (context) {
        userMessage = `${keyword}\n\nPrevious knowledge about this concept: ${context}`;
      }

      // Use the ULTRA model for complex domains, STANDARD otherwise
      const { tier, model } = evaluateComplexity(keyword);
      const temperature = 0.3;
      const maxTokens = 512;

      const requestBody = JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: domainPrompt,
          },
          {
            role: 'user',
            content: userMessage,
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
            const components = parseComponents(rawText, keyword);

            const responseBody = JSON.stringify({
              components,
              model,
              tier,
              keyword,
              domain,
              depth,
              reasoning,
            });

            res.writeHead(200, {
              'Content-Type': 'application/json',
              'X-DeepSeek-Model': model,
              'X-DeepSeek-Tier': tier,
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Expose-Headers': 'X-DeepSeek-Model, X-DeepSeek-Tier',
            });
            res.end(responseBody);

            console.log(`[DeepSeek] "${keyword}" → ${components.length} components (domain: ${domain}, depth: ${depth}) via ${model}`);
          } catch (err) {
            console.error('[DeepSeek] Parse error:', err.message, 'raw:', data.slice(0, 200));
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
              domain,
              depth,
              reasoning,
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

// ---- Domain Analysis (Step 1 of 2-step fracture reasoning) ----

const DOMAIN_PROMPTS = {
  science:    'Break this scientific concept into its fundamental physical, chemical, or mathematical components. Use precise scientific terminology.',
  technology: 'Decompose this technology into its engineering subsystems, protocols, and architectural layers.',
  philosophy: 'Analyze this philosophical concept into its core epistemological premises, axioms, and logical arguments.',
  art:        'Break this artistic concept into its aesthetic elements, techniques, compositional principles, and cultural influences.',
  nature:     'Decompose this natural entity into its biological, ecological, or geological components and processes.',
  social:     'Analyze this social concept into its structural components: institutions, behaviors, norms, and power dynamics.',
  general:    'Break down this concept into 4 to 7 fundamental components using the most appropriate analytical framework.',
};

/**
 * Step 1: Call DeepSeek (lite model) to identify the domain and abstraction depth of a keyword.
 * Calls `callback` with { domain, depth, reasoning }.
 */
function analyzeDomain(keyword, callback) {
  const fallback = { domain: 'general', depth: 3, reasoning: 'Domain analysis skipped (fast path)' };

  const requestBody = JSON.stringify({
    model: MODEL_LITE,
    messages: [
      {
        role: 'system',
        content: 'You are a domain classifier. Analyze the user\'s keyword and return ONLY a valid JSON object with three fields: "domain" (one of: science, technology, philosophy, art, nature, social, general), "depth" (integer 2-5 indicating how many abstraction layers this concept has), "reasoning" (one short sentence explaining your classification). No markdown, no code fences — just the raw JSON object.',
      },
      { role: 'user', content: keyword },
    ],
    temperature: 0.1,
    max_tokens: 80,
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
        console.error(`[Domain Analysis] API error ${apiRes.statusCode}, using fallback`);
        callback(fallback);
        return;
      }

      try {
        const parsed = JSON.parse(data);
        let rawText = parsed?.choices?.[0]?.message?.content?.trim() ?? '{}';
        rawText = rawText.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();

        const analysis = JSON.parse(rawText);
        const validDomains = ['science', 'technology', 'philosophy', 'art', 'nature', 'social', 'general'];
        callback({
          domain: validDomains.includes(analysis.domain) ? analysis.domain : 'general',
          depth: Math.max(2, Math.min(5, parseInt(analysis.depth) || 3)),
          reasoning: (analysis.reasoning || 'No reasoning provided').slice(0, 200),
        });
      } catch (err) {
        console.error(`[Domain Analysis] Parse error:`, err.message, 'using fallback');
        callback(fallback);
      }
    });
  });

  apiReq.on('error', (err) => {
    console.error(`[Domain Analysis] Network error:`, err.message, 'using fallback');
    callback(fallback);
  });

  apiReq.write(requestBody);
  apiReq.end();
}

/**
 * Build a domain-specific system prompt for the decomposition step.
 */
function getDomainPrompt(domain, depth) {
  const base = DOMAIN_PROMPTS[domain] || DOMAIN_PROMPTS.general;
  const countHint = depth >= 4
    ? `Return 5 to 7 components.`
    : `Return 4 to 6 components.`;
  return `${base} ${countHint} Return ONLY a valid JSON array of strings. No markdown, no explanations.`;
}

// ---- Emergent Synthesis Protocol (Merge) ----

function handleMerge(keywordA, keywordB, res, context = '', retryCount = 0) {
  const combined = `${keywordA} + ${keywordB}`;
  const { tier, model, reason } = evaluateComplexity(combined);
  const retryLabel = retryCount > 0 ? ` [retry #${retryCount}]` : '';
  console.log(`[DeepSeek Merge] "${keywordA}" + "${keywordB}" → ${tier} (${model}) — ${reason}${context ? ' [with context]' : ''}${retryLabel}`);

  let userMessage = `${keywordA} + ${keywordB}`;
  if (context) {
    userMessage = `${keywordA} + ${keywordB}\n\nBackground knowledge: ${context}`;
  }

  const temperature = retryCount > 0 ? 0.7 : 0.3;

  const requestBody = JSON.stringify({
    model,
    messages: [
      {
        role: 'system',
        content: `You are a Knowledge Synthesizer. Given two concepts, find the EMERGENT PROPERTY that arises from their intersection — not just a combination, but a genuinely new concept that neither parent alone could produce. Think: What new capability, phenomenon, or principle emerges when these two interact?

Return ONLY a valid JSON object with exactly these fields:
- "result": the emergent concept name (1-3 words)
- "reasoning": a brief explanation of the synthesis (1 sentence)
- "emergentProperty": what is genuinely NEW that neither parent had alone
- "confidence": a number from 0.0 to 1.0 indicating how strong the emergent connection is

Example: {"result":"Photosynthesis","reasoning":"Light energy captured and converted to chemical energy by combining solar radiation with leaf biology","emergentProperty":"Self-sustaining energy conversion from inorganic inputs","confidence":0.92}`,
      },
      {
        role: 'user',
        content: userMessage,
      },
    ],
    temperature,
    max_tokens: 250,
    stream: false,
  });

  const doApiCall = (body) => {
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
          sendFallback(res, model, tier, keywordA, keywordB);
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const rawText = parsed?.choices?.[0]?.message?.content?.trim() ?? '{}';
          const cleaned = rawText.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();

          const synthesis = JSON.parse(cleaned);
          const result = (synthesis.result || '').trim();
          const reasoning = (synthesis.reasoning || '').slice(0, 200);
          const emergentProperty = (synthesis.emergentProperty || '').slice(0, 200);
          const confidence = Math.max(0, Math.min(1, parseFloat(synthesis.confidence) || 0.5));

          // Validate: confidence too low or result is just a parent name → retry once
          if (retryCount < 1 && (confidence < 0.5
              || result.toLowerCase() === keywordA.toLowerCase()
              || result.toLowerCase() === keywordB.toLowerCase()
              || !result)) {
            console.log(`[DeepSeek Merge] Low quality (confidence: ${confidence}, result: "${result}"), retrying with higher temperature...`);
            handleMerge(keywordA, keywordB, res, context, retryCount + 1);
            return;
          }

          const finalResult = result || 'Emergent Compound';

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'X-DeepSeek-Model': model,
            'X-DeepSeek-Tier': tier,
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'X-DeepSeek-Model, X-DeepSeek-Tier',
          });
          res.end(JSON.stringify({
            result: finalResult,
            reasoning,
            emergentProperty,
            confidence,
            model,
            tier,
          }));

          console.log(`[DeepSeek Merge] "${keywordA}" + "${keywordB}" → "${finalResult}" (confidence: ${confidence}) via ${model}`);
        } catch (err) {
          console.error('[DeepSeek Merge] Parse error:', err.message);
          if (retryCount < 1) {
            console.log('[DeepSeek Merge] Parse failed, retrying...');
            handleMerge(keywordA, keywordB, res, context, retryCount + 1);
          } else {
            sendFallback(res, model, tier, keywordA, keywordB);
          }
        }
      });
    });

    apiReq.on('error', (err) => {
      console.error('[DeepSeek Merge] Network error:', err.message);
      if (retryCount < 1) {
        handleMerge(keywordA, keywordB, res, context, retryCount + 1);
      } else {
        sendFallback(res, model, tier, keywordA, keywordB);
      }
    });

    apiReq.write(body);
    apiReq.end();
  };

  doApiCall(requestBody);
}

/** Send a structured fallback when merge synthesis fails. */
function sendFallback(res, model, tier, keywordA, keywordB) {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'X-DeepSeek-Model': model,
    'X-DeepSeek-Tier': tier,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'X-DeepSeek-Model, X-DeepSeek-Tier',
  });
  res.end(JSON.stringify({
    result: 'Emergent Compound',
    reasoning: `Synthesized from ${keywordA} and ${keywordB} via heuristic combination.`,
    emergentProperty: 'Novel conceptual intersection',
    confidence: 0.35,
    model,
    tier,
    fallback: true,
  }));
}

// ---- Deep Fracture (recursive multi-level decomposition) ----

/** Simple rate limiter: allows maxConcurrent parallel API calls. */
function createRateLimiter(maxConcurrent) {
  let running = 0;
  const queue = [];
  const run = () => {
    while (running < maxConcurrent && queue.length > 0) {
      const next = queue.shift();
      running++;
      next().finally(() => { running--; run(); });
    }
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push(() => Promise.resolve().then(fn).then(resolve, reject));
    run();
  });
}

/**
 * POST /api/enrich/deep
 * Body: { keyword: string, depth: number (1-3) }
 * Returns: { tree: { keyword, components: [...recursive trees...] } }
 */
function handleDeepFracture(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Allow': 'POST' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  if (!DEEPSEEK_API_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Server not configured — set DEEPSEEK_API_KEY.' }));
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body.' }));
      return;
    }

    const keyword = (parsed.keyword || '').trim();
    const depth = Math.max(1, Math.min(3, parseInt(parsed.depth) || 2));
    if (!keyword) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'keyword is required.' }));
      return;
    }

    console.log(`[Deep Fracture] "${keyword}" depth=${depth} — building recursive tree...`);

    const limiter = createRateLimiter(10);

    /** Recursively fracture a keyword to the given remaining depth. */
    async function fractureRecursive(kw, remainingDepth) {
      if (remainingDepth <= 0) return { keyword: kw, components: [] };

      // Call the regular fracture prompt (single-level)
      const components = await limiter(() => callDeepSeekForComponents(kw));
      if (!components || components.length < 3) {
        return { keyword: kw, components: [] };
      }

      // Recurse into children
      const childTrees = await Promise.all(
        components.map(child => fractureRecursive(child, remainingDepth - 1))
      );

      return {
        keyword: kw,
        components: childTrees,
      };
    }

    fractureRecursive(keyword, depth)
      .then(tree => {
        const count = countTreeNodes(tree);
        console.log(`[Deep Fracture] "${keyword}" depth=${depth} → ${count} total nodes in tree`);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ tree, totalNodes: count }));
      })
      .catch(err => {
        console.error('[Deep Fracture] Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Deep fracture failed', detail: err.message }));
      });
  });
}

/** Call DeepSeek for a single keyword's components. Returns string[] or null. */
async function callDeepSeekForComponents(kw) {
  return new Promise((resolve) => {
    const { model } = evaluateComplexity(kw);
    const requestBody = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a logical data extractor. Break down the concept into 4 to 7 fundamental components. Return ONLY a valid JSON array of strings. No markdown.' },
        { role: 'user', content: kw },
      ],
      temperature: 0.3,
      max_tokens: 512,
      stream: false,
    });

    const options = {
      hostname: 'api.deepseek.com', port: 443, path: '/v1/chat/completions',
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
        if (apiRes.statusCode !== 200) { resolve(null); return; }
        try {
          const parsed = JSON.parse(data);
          const raw = parsed?.choices?.[0]?.message?.content?.trim() ?? '';
          const cleaned = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
          const arr = JSON.parse(cleaned);
          resolve(Array.isArray(arr) ? arr.map(String) : null);
        } catch { resolve(null); }
      });
    });
    apiReq.on('error', () => resolve(null));
    apiReq.write(requestBody);
    apiReq.end();
  });
}

/** Count total nodes in a recursive tree. */
function countTreeNodes(tree) {
  if (!tree || !tree.components || tree.components.length === 0) return 1;
  return 1 + tree.components.reduce((sum, child) => sum + countTreeNodes(child), 0);
}

// ---- Suggestion Engine ----

function handleSuggest(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Allow': 'POST' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  if (!DEEPSEEK_API_KEY) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ suggestions: [] }));
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body.' }));
      return;
    }

    const keywords = (parsed.keywords || []).filter(Boolean);
    if (keywords.length < 2) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ suggestions: [] }));
      return;
    }

    const prompt = `Given these concepts that exist in the user's workspace: ${keywords.join(', ')}.

Suggest 3 NEW concepts that would create interesting emergent properties when merged with any of the existing ones. Choose concepts from different domains than the existing ones. Return ONLY a JSON array of 3 strings. Example: ["Photosynthesis", "Blockchain", "Renaissance"]`;

    const requestBody = JSON.stringify({
      model: MODEL_LITE,
      messages: [
        { role: 'system', content: 'You are a creative suggestion engine. Return ONLY a JSON array of exactly 3 strings. No markdown, no explanations.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.8,
      max_tokens: 100,
      stream: false,
    });

    const options = {
      hostname: 'api.deepseek.com', port: 443, path: '/v1/chat/completions',
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
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ suggestions: [] }));
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const raw = parsed?.choices?.[0]?.message?.content?.trim() ?? '';
          const cleaned = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
          const suggestions = JSON.parse(cleaned);
          const items = (Array.isArray(suggestions) ? suggestions : []).map(String).filter(Boolean).slice(0, 3);

          console.log(`[Suggest] Workspace (${keywords.length} concepts) → ${items.length} suggestions: ${items.join(', ')}`);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ suggestions: items }));
        } catch (err) {
          console.error('[Suggest] Parse error:', err.message);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ suggestions: [] }));
        }
      });
    });

    apiReq.on('error', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ suggestions: [] }));
    });

    apiReq.write(requestBody);
    apiReq.end();
  });
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
  if (url.pathname === '/api/suggest') {
    handleSuggest(req, res);
    return;
  }
  if (url.pathname === '/api/enrich/deep') {
    handleDeepFracture(req, res);
    return;
  }
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
