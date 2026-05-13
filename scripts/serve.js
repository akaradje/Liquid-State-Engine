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

// ---- Safe JSON Parse Utility ----

/** Safely parse AI JSON — strips non-ASCII, fixes truncation. */
function safeParseAIJson(raw, fallback) {
  if (!raw || !raw.trim()) return fallback;
  let t = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  t = t.replace(/[^\x00-\x7F]/g, '');
  t = t.replace(/:\s*""\s*([,}])/g, ':"n/a"$1');
  try { return JSON.parse(t); } catch(e) {}
  const m = t.match(/\{[^{}]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch(e) {}
  t = t.replace(/,?\s*"[^"]*$/, '');
  t += '}'.repeat(Math.max(0, (t.match(/\{/g) || []).length - (t.match(/\}/g) || []).length));
  try { return JSON.parse(t); } catch(e) {}
  return fallback;
}

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
      'Cache-Control': 'no-store, no-cache, must-revalidate',
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

      // Step 1.5: Optionally ground with Wikipedia for factual concepts
      const applyGrounding = (groundedSource) => {
        let domainPrompt = getDomainPrompt(domain, depth);
        if (groundedSource) {
          domainPrompt += ` Use this factual context for grounding: ${groundedSource.slice(0, 400)}`;
        }
        return { domainPrompt, groundedSource };
      };

      const groundingPromise = parsed.skipGrounding
        ? Promise.resolve(null)
        : maybeGroundWithWikipedia(keyword);

      groundingPromise.then((groundedSource) => {
      let { domainPrompt } = applyGrounding(groundedSource);

      // Step 2: Build domain-specific decomposition prompt
      // (domainPrompt already computed by applyGrounding)

      // Bug 2 fix: handle non-English input gracefully
      domainPrompt += ' The user may input non-English text. Always respond with English component names in a JSON array regardless of input language.';

      // 6-Level LOD Framework — strict one-level-at-a-time decomposition
      domainPrompt += ' You are an ontological cartographer. Break down using ONE LEVEL OF DETAIL at a time. THE 6 LODs: L1=Category/Field (e.g.,Anatomy,Transportation), L2=System/Entity (e.g.,Human Skeleton,Car), L3=Macro-Parts/Sub-systems (e.g.,Axial Skeleton,Engine), L4=Micro-Components (e.g.,Skull,Piston), L5=Materials/Tissues (e.g.,Bone Tissue,Steel), L6=Chemical/Atomic (e.g.,Calcium,Carbon). RULES: 1. Assess LOD of input concept. 2. Output 4-7 components at EXACTLY LOD+1. 3. NEVER skip levels. If given L2 (Skeleton), output L3 parts, NOT L5 materials. 4. If concept is L6 or indivisible, return ["ATOMIC: [reason]"].';

      // Apply user profile preferences to the prompt
      const userProfile = parsed.userProfile;
      if (userProfile) {
        if (userProfile.preferredStyle === 'concise') {
          domainPrompt += ' Use terse, precise technical terms. Keep component names short (1-2 words).';
        } else if (userProfile.preferredStyle === 'poetic') {
          domainPrompt += ' Use evocative, metaphorical language. Component names can be descriptive phrases.';
        }
        if (userProfile.preferredLength) {
          domainPrompt += ` Return exactly ${userProfile.preferredLength} components.`;
        }
      }

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
            let rawText = parsed?.choices?.[0]?.message?.content?.trim() ?? '';

            // Bug 2: retry once if AI returns empty (non-English input can cause this)
            if (!rawText && !parsed?.disableReflection) {
              console.log(`[DeepSeek] Empty response for "${keyword}", retrying with temp 0.5...`);
              const retryBody = JSON.stringify({ model, temperature: 0.5, max_tokens: maxTokens, stream: false, messages: [{ role: 'system', content: domainPrompt }, { role: 'user', content: userMessage }] });
              const retryReq = https.request(options, (retryRes) => { let rd = ''; retryRes.on('data', c => { rd += c; }); retryRes.on('end', () => { try { rawText = JSON.parse(rd)?.choices?.[0]?.message?.content?.trim() || rawText; processResponse(rawText); } catch { processResponse(rawText); } }); });
              retryReq.on('error', () => processResponse(rawText));
              retryReq.write(retryBody); retryReq.end();
              return;
            }

            processResponse(rawText);
            function processResponse(rawText) {
            // Self-critique reflection (unless disabled)
            const enableReflection = !parsed?.disableReflection;
            if (enableReflection && rawText) {
              reflectAndImprove(domainPrompt, rawText, context, (reflection) => {
                const finalText = reflection?.improved || rawText;
                const components = parseComponents(finalText, keyword);

                const responseBody = JSON.stringify({
                  components,
                  model, tier, keyword, domain, depth, reasoning,
                  reflection: reflection ? {
                    attempts: reflection.attempts,
                    critique: reflection.critique,
                    scores: reflection.scores,
                    finalScore: reflection.finalScore,
                  } : null,
                });

                res.writeHead(200, {
                  'Content-Type': 'application/json',
                  'X-DeepSeek-Model': model, 'X-DeepSeek-Tier': tier,
                  'Access-Control-Allow-Origin': '*',
                  'Access-Control-Expose-Headers': 'X-DeepSeek-Model, X-DeepSeek-Tier',
                });
                res.end(responseBody);
                console.log(`[DeepSeek] "${keyword}" → ${components.length} components (reflected: ${reflection ? 'yes' : 'no'}) via ${model}`);
              });
              return; // Don't fall through — reflection handles the response
            }

            // No reflection: respond immediately
            const components = parseComponents(rawText, keyword);
            const responseBody = JSON.stringify({
              components, model, tier, keyword, domain, depth, reasoning,
              grounded: !!groundedSource,
              groundedSource: groundedSource?.slice(0, 200) || null,
            });
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-DeepSeek-Model': model, 'X-DeepSeek-Tier': tier, 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-DeepSeek-Model, X-DeepSeek-Tier' });
            res.end(responseBody);
            console.log(`[DeepSeek] "${keyword}" → ${components.length} components via ${model}`);
            } // close processResponse

          } catch (err) {
            console.error('[DeepSeek] Parse error:', err.message, 'raw:', data.slice(0, 200));
            const fallbackComponents = keyword.split(/[\s,;]+/).filter(Boolean);
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-DeepSeek-Model': model, 'X-DeepSeek-Tier': tier, 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-DeepSeek-Model, X-DeepSeek-Tier' });
            res.end(JSON.stringify({ components: fallbackComponents.length > 0 ? fallbackComponents : [keyword], model, tier, keyword, domain, depth, reasoning, fallback: true }));
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
      }); // close groundingPromise.then()
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
  science:    'Classify this scientific concept to its correct LOD level, then decompose exactly one level deeper. Use precise terminology.',
  technology: 'Classify this technology to its correct LOD level, then decompose exactly one level deeper into subsystems.',
  philosophy: 'Classify this philosophical concept, then decompose exactly one level deeper into premises or branches.',
  art:        'Classify this artistic concept, then decompose exactly one level deeper into elements or techniques.',
  nature:     'Classify this natural entity, then decompose exactly one level deeper into components or processes.',
  social:     'Classify this social concept, then decompose exactly one level deeper into structures or dynamics.',
  general:    'Classify this concept to its correct LOD level, then decompose exactly one level deeper (4-7 components).',
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
        content: 'Respond in English ONLY. No Thai, no Unicode. Return ONLY: {"domain":"one of: science|technology|philosophy|art|nature|social|general","depth":N,"reasoning":"max 10 words"}',
      },
      { role: 'user', content: keyword },
    ],
    temperature: 0.1,
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
        console.error(`[Domain Analysis] API error ${apiRes.statusCode}, using fallback`);
        callback(fallback);
        return;
      }

      try {
        const parsed = JSON.parse(data);
        let rawText = parsed?.choices?.[0]?.message?.content?.trim() ?? '{}';

        const analysis = safeParseAIJson(rawText);
        if (!analysis) {
          // Regex fallback for partial JSON
          const domainMatch = rawText.match(/"domain"\s*:\s*"([^"]+)"/);
          const depthMatch = rawText.match(/"depth"\s*:\s*(\d+)/);
          const reasoningMatch = rawText.match(/"reasoning"\s*:\s*"([^"]+)"/);
          callback({
            domain: domainMatch?.[1] || 'general',
            depth: Math.max(2, Math.min(5, parseInt(depthMatch?.[1]) || 3)),
            reasoning: (reasoningMatch?.[1] || 'parse fallback').slice(0, 200),
          });
          return;
        }

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
        content: `You are an avant-garde Conceptual Synthesizer and Master Alchemist. Your task is to combine "${keywordA}" and "${keywordB}" into a SINGLE NEW WORD or short phrase (max 2 words).

CRITICAL RULES:
1. NEVER just hyphenate the words (e.g., A-B).
2. NEVER use lazy prefixes like 'Compound', 'Synthesis', or 'Hybrid'.
3. If the concepts are completely unrelated or absurd (e.g., "Quantum Mechanics" + "Spicy Papaya Salad"), invent a highly creative, metaphorical, or sci-fi concept that bridges their core meanings (e.g., "Entangled Spice", "Probabilistic Flavor").
4. Return ONLY valid JSON: {"result":"NewConcept","reasoning":"1 sentence","emergentProperty":"what is genuinely new","confidence":0.0-1.0}. Example: {"result":"Steam","reasoning":"Water heated by fire becomes gaseous","emergentProperty":"Phase transition from liquid to gas","confidence":0.85}`,
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

          const finalResult = result || 'Anomalous Entity';

          // Self-critique reflection for merge
          const mergeSysPrompt = 'You are a Knowledge Synthesizer. Find EMERGENT PROPERTIES from concept intersections.';
          reflectAndImprove(mergeSysPrompt, JSON.stringify({ result: finalResult, reasoning, emergentProperty, confidence }), context, (reflection) => {
            let final = { result: finalResult, reasoning, emergentProperty, confidence };
            if (reflection?.improved) {
              try {
                const improved = JSON.parse(reflection.improved.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim());
                if (improved.result) final = improved;
              } catch { /* keep original */ }
            }

            res.writeHead(200, {
              'Content-Type': 'application/json',
              'X-DeepSeek-Model': model, 'X-DeepSeek-Tier': tier,
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Expose-Headers': 'X-DeepSeek-Model, X-DeepSeek-Tier',
            });
            res.end(JSON.stringify({
              result: final.result,
              reasoning: final.reasoning,
              emergentProperty: final.emergentProperty,
              confidence: final.confidence,
              model, tier,
              reflection: reflection ? {
                attempts: reflection.attempts,
                critique: reflection.critique,
                finalScore: reflection.finalScore,
              } : null,
            }));
            console.log(`[DeepSeek Merge] "${keywordA}" + "${keywordB}" → "${final.result}" (reflected) via ${model}`);
          });
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
    result: `Compound ${keywordA}-${keywordB}`,
    reasoning: `Heuristic synthesis of ${keywordA} and ${keywordB}.`,
    emergentProperty: 'Conceptual combination',
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

    const prompt = `Think outside the box. Given these workspace concepts: ${keywords.join(', ')}. Suggest 3 completely NEW concepts from different domains that would create fascinating emergent properties when combined with any existing concept. Be creative and unexpected. Return ONLY a valid JSON array of exactly 3 strings. Example: ["Entropy", "Bioluminescence", "Recursion"]`;

    const requestBody = JSON.stringify({
      model: MODEL_STANDARD,
      messages: [
        { role: 'system', content: 'You are a creative suggestion engine. Return ONLY a JSON array of exactly 3 strings. No markdown, no explanations. Never return an empty array.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.8,
      max_tokens: 150,
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

// ---- Counterfactual Reasoning ----

function handleCounterfactual(req, res) {
  if (req.method !== 'POST') { res.writeHead(405); res.end(JSON.stringify({ error: 'Method not allowed' })); return; }
  if (!DEEPSEEK_API_KEY) { res.writeHead(200, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' }); res.end(JSON.stringify({})); return; }

  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let p;
    try { p = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
    const keyword = (p.keyword || '').trim();
    const mode = p.mode || 'absent';
    if (!keyword) { res.writeHead(400); res.end(JSON.stringify({ error: 'keyword required' })); return; }

    let prompt;
    const prompts = {
      absent: `What would the world look like if "${keyword}" did not exist? What would fill its role? Return JSON: {"alternative":"1-3 word concept","consequences":["consequence 1","consequence 2","consequence 3"],"reasoning":"1 sentence"}`,
      inverted: `What is the logical inverse of "${keyword}"? Not just opposite, but what would occupy its inverse position in its domain? Return JSON: {"inverse":"1-3 words","reasoning":"1 sentence","sharedContext":"the domain/framework both exist in"}`,
      extreme: `What is "${keyword}" taken to an absolute extreme? Amplified 1000x? Return JSON: {"extreme":"the amplified concept","implications":["implication 1","implication 2","implication 3"]}`,
    };

    prompt = prompts[mode] || prompts.absent;

    const reqBody = JSON.stringify({
      model: MODEL_STANDARD,
      messages: [
        { role:'system', content:'You explore counterfactual worlds. Return ONLY valid JSON. No markdown.' },
        { role:'user', content: prompt },
      ],
      temperature: 0.6, max_tokens: 250, stream: false,
    });

    const opts = { hostname:'api.deepseek.com', port:443, path:'/v1/chat/completions', method:'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${DEEPSEEK_API_KEY}`, 'Accept':'application/json' } };

    const apiReq = https.request(opts, (apiRes) => {
      let d = '';
      apiRes.on('data', c => { d += c; });
      apiRes.on('end', () => {
        if (apiRes.statusCode !== 200) { res.writeHead(502); res.end(JSON.stringify({ error:'API error' })); return; }
        try {
          const parsed = JSON.parse(d);
          const raw = parsed?.choices?.[0]?.message?.content?.trim() ?? '{}';
          const cleaned = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
          const result = JSON.parse(cleaned);
          res.writeHead(200, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' });
          res.end(JSON.stringify(result));
          console.log(`[Counterfactual] "${keyword}" (${mode}) → done`);
        } catch { res.writeHead(200, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' }); res.end(JSON.stringify({})); }
      });
    });
    apiReq.on('error', () => { res.writeHead(502); res.end(JSON.stringify({ error:'Network error' })); });
    apiReq.write(reqBody); apiReq.end();
  });
}

// ---- Tension Detection & Resolution ----

const tensionCache = { hash: '', tensions: [] };

function handleTension(req, res) {
  if (req.method !== 'POST') { res.writeHead(405); res.end(JSON.stringify({ error: 'Method not allowed' })); return; }
  if (!DEEPSEEK_API_KEY) { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ tensions: [] })); return; }

  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
    const keywords = (parsed.keywords || []).filter(Boolean);
    if (keywords.length < 4) { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ tensions: [] })); return; }

    // Cache: only re-run if keywords changed > 20%
    const hash = keywords.sort().join('|');
    if (tensionCache.hash === hash) { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ tensions: tensionCache.tensions })); return; }

    // Handle resolve request
    if (parsed.resolve) {
      const prompt = `These two concepts are in tension: "${parsed.a}" vs "${parsed.b}". What is a SYNTHESIS concept that transcends or resolves this dialectical opposition? Return ONLY valid JSON: {"synthesis":"...","explanation":"1 sentence","confidence":0-1}. Example: "Order" vs "Chaos" → {"synthesis":"Complexity","explanation":"Complex systems exist at the edge of order and chaos","confidence":0.85}`;
      const reqBody = JSON.stringify({ model: MODEL_STANDARD, messages: [{ role:'system', content:'You are a dialectical synthesizer. Return ONLY JSON.' },{ role:'user', content: prompt }], temperature:0.35, max_tokens:150, stream:false });
      const opts = { hostname:'api.deepseek.com', port:443, path:'/v1/chat/completions', method:'POST', headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${DEEPSEEK_API_KEY}`, 'Accept':'application/json' } };
      const apiReq = https.request(opts, (apiRes) => { let d=''; apiRes.on('data',c=>{d+=c}); apiRes.on('end',()=>{ try { const p=JSON.parse(d); const r=p?.choices?.[0]?.message?.content?.trim()??'{}'; const c=r.replace(/```(?:json)?\s*/gi,'').replace(/```/g,'').trim(); const s=JSON.parse(c); res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify(s)); } catch { res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify({synthesis:'Synthesis',explanation:'Dialectical resolution',confidence:0.5})); } }); });
      apiReq.on('error',()=>{ res.writeHead(502); res.end(JSON.stringify({error:'Network error'})); });
      apiReq.write(reqBody); apiReq.end();
      return;
    }

    // Detect tensions
    const prompt = `Identify conceptual frictions among these: ${keywords.join(', ')}. Even subtle opposites like "Order" vs "Chaos" or "Light" vs "Dark" MUST be detected. Return at least 2 pairs if they exist in the list. Intensity should be 0.8+ for direct opposites. Return ONLY JSON: {"tensions":[{"a":"ConceptA","b":"ConceptB","type":"opposition|paradox|dialectic","intensity":0.0-1.0,"explanation":"1 sentence"}]}`;
    const reqBody = JSON.stringify({ model: MODEL_STANDARD, messages: [{ role:'system', content:'You are a dialectical analyst. Find tensions and oppositions. Return ONLY valid JSON, no markdown.' },{ role:'user', content: prompt }], temperature:0.4, max_tokens:300, stream:false });
    const opts = { hostname:'api.deepseek.com', port:443, path:'/v1/chat/completions', method:'POST', headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${DEEPSEEK_API_KEY}`, 'Accept':'application/json' } };
    const apiReq = https.request(opts, (apiRes) => { let d=''; apiRes.on('data',c=>{d+=c}); apiRes.on('end',()=>{ try { const p=JSON.parse(d); const r=p?.choices?.[0]?.message?.content?.trim()??'{}'; const c=r.replace(/```(?:json)?\s*/gi,'').replace(/```/g,'').trim(); const t=JSON.parse(c); tensionCache.hash=hash; tensionCache.tensions=t.tensions||[]; res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify({tensions:tensionCache.tensions})); console.log(`[Tension] ${tensionCache.tensions.length} pairs detected`); } catch { res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify({tensions:[]})); } }); });
    apiReq.on('error',()=>{ res.writeHead(502); res.end(JSON.stringify({error:'Network error'})); });
    apiReq.write(reqBody); apiReq.end();
  });
}

// ---- Proactive Curiosity Engine ----

function handleCuriosity(req, res) {
  if (req.method !== 'POST') { res.writeHead(405); res.end(JSON.stringify({ error: 'Method not allowed' })); return; }
  if (!DEEPSEEK_API_KEY) { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ type: 'explore', prompt: 'Try connecting two concepts by dragging one onto another.', suggestedNodes: [], reasoning: 'No API key configured' })); return; }

  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

    const keywords = (parsed.workspace || []).map(k => k.keyword).filter(Boolean);
    const neverFractured = parsed.neverFractured || [];
    const neverMerged = parsed.neverMerged || [];
    const feedback = parsed.feedback || [];

    if (keywords.length < 3) { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ type: 'explore', prompt: 'Add a few more concepts to your workspace!', suggestedNodes: [], reasoning: 'Not enough nodes' })); return; }

    // Bias: prefer types with higher acceptance rate
    const typeBias = {};
    for (const f of feedback) {
      if (!typeBias[f.type]) typeBias[f.type] = { total: 0, accepted: 0 };
      typeBias[f.type].total++;
      if (f.outcome === 'accepted') typeBias[f.type].accepted++;
    }
    const preferredType = Object.entries(typeBias)
      .filter(([, v]) => v.total >= 3)
      .sort((a, b) => (b[1].accepted / b[1].total) - (a[1].accepted / a[1].total))[0]?.[0] || 'any';

    const prompt = `Given this user's workspace concepts: ${keywords.slice(0, 15).join(', ')}.
Never fractured: ${neverFractured.slice(0, 3).join(', ') || 'none'}.
Never merged: ${neverMerged.slice(0, 3).join(', ') || 'none'}.
User prefers: ${preferredType} type suggestions.

Generate ONE interesting question or experiment. Use one of these formats:
- "What emerges from [X] + [Y]?" (suggest merge) → type: "merge"
- "What are the hidden components of [Z]?" (suggest fracture) → type: "fracture"
- "How does [A] relate to [B]?" (suggest exploration) → type: "explore"
- "What is the opposite of [X]?" (suggest counter-concept) → type: "counter"

Return ONLY valid JSON:
{"type":"merge|fracture|explore|counter","prompt":"...","suggestedNodes":["node1","node2"],"reasoning":"1-sentence reason"}`;

    const reqBody = JSON.stringify({
      model: MODEL_LITE,
      messages: [
        { role: 'system', content: 'You are a curious AI assistant. Return ONLY valid JSON. No markdown.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7, max_tokens: 150, stream: false,
    });

    const opts = { hostname: 'api.deepseek.com', port: 443, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}`, 'Accept': 'application/json' } };

    const apiReq = https.request(opts, (apiRes) => {
      let d = '';
      apiRes.on('data', c => { d += c; });
      apiRes.on('end', () => {
        try {
          const p = JSON.parse(d);
          const raw = p?.choices?.[0]?.message?.content?.trim() ?? '{}';
          const cleaned = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
          const result = JSON.parse(cleaned);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(result));
          console.log(`[Curiosity] → ${result.type}: "${result.prompt?.slice(0, 60)}"`);
        } catch {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ type: 'explore', prompt: `Try connecting "${keywords[0]}" and "${keywords[Math.min(1, keywords.length - 1)]}"`, suggestedNodes: [keywords[0], keywords[1] || keywords[0]], reasoning: 'Explore workspace connections' }));
        }
      });
    });
    apiReq.on('error', () => { res.writeHead(502); res.end(JSON.stringify({ error: 'Network error' })); });
    apiReq.write(reqBody); apiReq.end();
  });
}

// ---- Analogical Reasoning ----

function handleAnalogy(req, res) {
  if (req.method !== 'POST') { res.writeHead(405); res.end(JSON.stringify({ error: 'Method not allowed' })); return; }
  if (!DEEPSEEK_API_KEY) { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ answer: '?', relationship: 'unknown', confidence: 0 })); return; }

  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

    const a = (parsed.a || '').trim();
    const b = (parsed.b || '').trim();
    const c = (parsed.c || '').trim();
    const explain = parsed.explain || false;

    if (!a || !b || !c) { res.writeHead(400); res.end(JSON.stringify({ error: 'a, b, c are required' })); return; }

    let prompt;
    if (explain) {
      prompt = `Explain WHY the analogy "${a}" is to "${b}" as "${c}" is to "${parsed.answer || '?'}" works. What is the underlying relationship? Return JSON: {"relationship":"...","explanation":"...","confidence":0-1}`;
    } else {
      prompt = `Complete the analogy: "${a}" is to "${b}" as "${c}" is to what? Identify the underlying relationship first, then find the best answer. Return JSON: {"answer":"...","relationship":"...","confidence":0-1,"alternatives":["alt1","alt2","alt3"]}`;
    }

    const reqBody = JSON.stringify({
      model: MODEL_STANDARD,
      messages: [
        { role: 'system', content: 'You are an analogical reasoning engine. Return ONLY valid JSON. No markdown.' },
        { role: 'user', content: prompt },
      ],
      temperature: explain ? 0.2 : 0.4, max_tokens: 200, stream: false,
    });

    const opts = { hostname: 'api.deepseek.com', port: 443, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}`, 'Accept': 'application/json' } };

    const apiReq = https.request(opts, (apiRes) => {
      let d = '';
      apiRes.on('data', c => { d += c; });
      apiRes.on('end', () => {
        if (apiRes.statusCode !== 200) { res.writeHead(502); res.end(JSON.stringify({ error: 'API error' })); return; }
        try {
          const p = JSON.parse(d);
          const raw = p?.choices?.[0]?.message?.content?.trim() ?? '{}';
          const cleaned = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
          const result = JSON.parse(cleaned);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(explain ? {
            relationship: result.relationship || '',
            explanation: result.explanation || '',
            confidence: result.confidence ?? 0.5,
          } : {
            answer: result.answer || '?',
            relationship: result.relationship || '',
            confidence: result.confidence ?? 0.5,
            alternatives: result.alternatives || [],
          }));
          console.log(`[Analogy] ${a}:${b}::${c}:${result.answer || 'explained'}`);
        } catch { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ answer: '?', relationship: 'unknown', confidence: 0 })); }
      });
    });
    apiReq.on('error', () => { res.writeHead(502); res.end(JSON.stringify({ error: 'Network error' })); });
    apiReq.write(reqBody); apiReq.end();
  });
}

// ---- Ontology Classification ----

function handleClassify(req, res) {
  if (req.method !== 'POST') { res.writeHead(405); res.end(JSON.stringify({ error: 'Method not allowed' })); return; }
  if (!DEEPSEEK_API_KEY) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ chain: [], confidence: 0 }));
    return;
  }

  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return;
    }
    const keyword = (parsed.keyword || '').trim();
    if (!keyword) { res.writeHead(400); res.end(JSON.stringify({ error: 'keyword required' })); return; }

    const prompt = `You are a strict Taxonomist. For the word "${keyword}", you MUST return a full hierarchy chain of exactly 6 levels from specific to general. Example: "Poodle" → ["Poodle","Dog","Canine","Mammal","Animal","Entity"]. Return ONLY valid JSON: {"chain":["most specific",...,"most general"],"confidence":0.0-1.0}`;

    const reqBody = JSON.stringify({
      model: MODEL_LITE,
      messages: [
        { role: 'system', content: 'You are a strict taxonomist. You MUST return exactly 6 taxonomy levels from specific to most general. Never return fewer than 5 levels. Return ONLY valid JSON. No markdown.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2, max_tokens: 200, stream: false,
    });

    const opts = { hostname: 'api.deepseek.com', port: 443, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}`, 'Accept': 'application/json' } };

    const apiReq = https.request(opts, (apiRes) => {
      let d = '';
      apiRes.on('data', c => { d += c; });
      apiRes.on('end', () => {
        if (apiRes.statusCode !== 200) { res.writeHead(200); res.end(JSON.stringify({ chain: buildDefaultChain(keyword), confidence: 0.3 })); return; }
        try {
          const parsed = JSON.parse(d);
          const raw = parsed?.choices?.[0]?.message?.content?.trim() ?? '{}';
          const cleaned = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
          const result = JSON.parse(cleaned);
          const chain = Array.isArray(result.chain) ? result.chain.map(String) : buildDefaultChain(keyword);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ chain: chain.length >= 3 ? chain : buildDefaultChain(keyword), confidence: result.confidence ?? 0.7 }));
        } catch {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ chain: buildDefaultChain(keyword), confidence: 0.3 }));
        }
      });
    });
    apiReq.on('error', () => { res.writeHead(200); res.end(JSON.stringify({ chain: buildDefaultChain(keyword), confidence: 0.3 })); });
    apiReq.write(reqBody); apiReq.end();
  });
}

function buildDefaultChain(keyword) {
  return [keyword, 'Concept', 'Abstraction', 'Information', 'System', 'Entity'];
}

// ---- Embedding Endpoint (with local fallback) ----

/** In-memory cache: text → embedding vector */
const embedCache = new Map();

/**
 * Generate a local 128-dim embedding vector from text using character trigram hashing.
 * Fast, deterministic, no API calls needed.
 */
function localEmbed(text) {
  const dim = 128;
  const vec = new Array(dim).fill(0);
  const s = text.toLowerCase().trim();
  // Character trigrams
  for (let i = 0; i < s.length - 2; i++) {
    const trigram = s.slice(i, i + 3);
    let hash = 0;
    for (let j = 0; j < 3; j++) hash = ((hash << 5) - hash + trigram.charCodeAt(j)) | 0;
    vec[Math.abs(hash) % dim] += 1;
  }
  // Word-level boost
  const words = s.split(/\s+/);
  for (const w of words) {
    let h = 0;
    for (let j = 0; j < w.length; j++) h = ((h << 5) - h + w.charCodeAt(j)) | 0;
    vec[Math.abs(h) % dim] += 2;
  }
  // L2 normalize
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map(v => v / norm);
}

/**
 * POST /api/embed
 * Body: { texts: string[] }
 * Returns: { embeddings: number[][] }
 */
function handleEmbed(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Allow': 'POST' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
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

    const texts = (parsed.texts || (parsed.text ? [parsed.text] : [])).filter(Boolean);
    if (texts.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'texts array is required.' }));
      return;
    }

    // Check cache first
    const uncached = [];
    const embeddings = [];
    for (const t of texts) {
      const key = t.toLowerCase().trim();
      if (embedCache.has(key)) {
        embeddings.push(embedCache.get(key));
      } else {
        uncached.push(t);
        embeddings.push(null); // placeholder
      }
    }

    if (uncached.length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ embeddings }));
      return;
    }

    // Try DeepSeek embeddings API first
    if (DEEPSEEK_API_KEY) {
      const reqBody = JSON.stringify({
        model: 'text-embedding-3-small',
        input: uncached,
      });

      const options = {
        hostname: 'api.deepseek.com', port: 443,
        path: '/v1/embeddings', method: 'POST',
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
          if (apiRes.statusCode === 200) {
            try {
              const resp = JSON.parse(data);
              const remoteEmbeddings = resp.data?.map(d => d.embedding) || [];
              finishEmbeddings(embeddings, uncached, remoteEmbeddings, res);
              return;
            } catch { /* fall through to local */ }
          }
          // Fallback: use local embeddings
          const localEmbeddings = uncached.map(t => localEmbed(t));
          finishEmbeddings(embeddings, uncached, localEmbeddings, res);
        });
      });

      apiReq.on('error', () => {
        const localEmbeddings = uncached.map(t => localEmbed(t));
        finishEmbeddings(embeddings, uncached, localEmbeddings, res);
      });

      apiReq.write(reqBody);
      apiReq.end();
    } else {
      // No API key: use local embeddings directly
      const localEmbeddings = uncached.map(t => localEmbed(t));
      finishEmbeddings(embeddings, uncached, localEmbeddings, res);
    }
  });
}

function finishEmbeddings(embeddings, uncached, newEmbeddings, res) {
  // Fill in placeholders + cache
  let ei = 0;
  for (let i = 0; i < embeddings.length; i++) {
    if (embeddings[i] === null) {
      embeddings[i] = newEmbeddings[ei] || localEmbed(uncached[ei]);
      embedCache.set(uncached[ei].toLowerCase().trim(), embeddings[i]);
      ei++;
    }
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ embeddings }));
  console.log(`[Embed] ${embeddings.length} vectors (${uncached.length} new, cached: ${embeddings.length - uncached.length})`);
}

// ---- Self-Critique Reflection Loop ----

/**
 * Reflect on an AI response and optionally regenerate with critique context.
 * @param {string} originalPrompt - the system prompt used
 * @param {string} firstResponse - the AI's first response text
 * @param {string} context - optional background context
 * @param {function} callback - called with { improved, critique, scores, attempts }
 */
function reflectAndImprove(originalPrompt, firstResponse, context, callback) {
  const critiquePrompt = `Rate this response to "${originalPrompt.slice(0, 120)}":
"${firstResponse.slice(0, 200)}"

Return ONLY this short JSON (no markdown):
{"score":N,"redo":true/false,"tip":"max 15 words english"}

English only. Return ONLY valid JSON: {"score":N,"redo":true or false,"tip":"max 10 words"}`;

  const requestBody = JSON.stringify({
    model: MODEL_STANDARD,
    messages: [
      { role: 'system', content: 'English only. Return ONLY: {"score":N,"redo":true or false,"tip":"max 10 words"}' },
      { role: 'user', content: critiquePrompt },
    ],
    temperature: 0.2,
    max_tokens: 200,
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
      if (apiRes.statusCode !== 200) { callback(null); return; }

      try {
        const parsed = JSON.parse(data);
        const rawText = parsed?.choices?.[0]?.message?.content?.trim() ?? '{}';
        const critique = safeParseAIJson(rawText);

        if (!critique) {
          // Regex fallback for simplified partial JSON
          const redoMatch = rawText.match(/redo["\s:]+(\w+)/);
          const shouldRegen = redoMatch?.[1] === 'true';
          const score = parseInt(rawText.match(/score["\s:]+(\d+)/)?.[1]) || 7;
          const tipMatch = rawText.match(/tip["\s:]+"([^"]+)"/);
          const tip = tipMatch?.[1] || 'improve quality';
          const scores = { accuracy: score, creativity: score, depth: score, relevance: score };
          if (shouldRegen && score < 7) {
            doRegenerate(originalPrompt, firstResponse, tip, scores, score, callback);
          } else {
            callback({ improved: firstResponse, critique: tip, scores, attempts: 1, finalScore: score });
          }
          return;
        }

        const score = critique.score || 7;
        const shouldRegen = critique.redo === true;
        const tip = critique.tip || '';
        const scores = { accuracy: score, creativity: score, depth: score, relevance: score };

        if (shouldRegen && score < 7 && DEEPSEEK_API_KEY) {
          console.log(`[Reflect] Score ${score} — regenerating: ${tip.slice(0, 60)}`);
          doRegenerate(originalPrompt, firstResponse, tip || 'Be more precise and creative.', scores, score, callback);
        } else {
          console.log(`[Reflect] Score ${score} — keeping original`);
          callback({
            improved: firstResponse,
            critique: tip,
            scores,
            attempts: 1,
            finalScore: score,
          });
        }
      } catch (err) {
        console.error('[Reflect] Critique parse error:', err.message);
        callback(null);
      }
    });
  });

  apiReq.on('error', () => callback(null));
  apiReq.write(requestBody);
  apiReq.end();
}

/** Shared regeneration helper for reflectAndImprove. */
function doRegenerate(originalPrompt, firstResponse, critiqueText, scores, avgScore, callback) {
  const opts = {
    hostname: 'api.deepseek.com', port: 443, path: '/v1/chat/completions',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}`, 'Accept': 'application/json' },
  };
  const regenBody = JSON.stringify({
    model: MODEL_STANDARD,
    messages: [
      { role: 'system', content: originalPrompt },
      { role: 'user', content: `Improve your previous response. Critique: ${critiqueText}` },
    ],
    temperature: 0.35, max_tokens: 512, stream: false,
  });
  const regenReq = https.request(opts, (regenRes) => {
    let regenData = '';
    regenRes.on('data', chunk => { regenData += chunk; });
    regenRes.on('end', () => {
      try {
        const p = JSON.parse(regenData);
        const improved = p?.choices?.[0]?.message?.content?.trim() ?? firstResponse;
        callback({ improved, critique: critiqueText, scores, attempts: 2, finalScore: avgScore });
      } catch { callback({ improved: firstResponse, critique: critiqueText, scores, attempts: 2, finalScore: avgScore }); }
    });
  });
  regenReq.on('error', () => callback({ improved: firstResponse, critique: critiqueText, scores, attempts: 2, finalScore: avgScore }));
  regenReq.write(regenBody);
  regenReq.end();
}

// ---- Multi-Agent Debate System ----

const AGENTS = {
  SCIENTIST:  { name: 'scientist',  system: 'You are a rigorous empirical scientist. Focus on measurable, testable, physical components. Use precise terminology.', color: '#4ECDC4' },
  PHILOSOPHER:{ name: 'philosopher',system: 'You are a deep philosophical thinker. Focus on meaning, epistemology, fundamental axioms, and conceptual frameworks.', color: '#A78BFA' },
  ARTIST:     { name: 'artist',     system: 'You are a creative artist. Focus on aesthetic, emotional, symbolic, and experiential components. Think metaphorically.', color: '#FFE66D' },
};

function callAgent(systemPrompt, userMessage, model = MODEL_LITE) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model, messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Break down the concept: "${userMessage}" into 4-6 components. Return ONLY a valid JSON array of strings. No explanations.` },
      ],
      temperature: 0.35, max_tokens: 300, stream: false,
    });

    const req = https.request({
      hostname: 'api.deepseek.com', port: 443, path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}`, 'Accept': 'application/json' },
    }, (resp) => {
      let d = '';
      resp.on('data', c => { d += c; });
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          const raw = parsed?.choices?.[0]?.message?.content?.trim() ?? '';
          const cleaned = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
          const arr = JSON.parse(cleaned);
          resolve(Array.isArray(arr) ? arr.map(String) : []);
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.write(body); req.end();
  });
}

function callSynthesizer(results, keyword) {
  return new Promise((resolve) => {
    const summary = Object.entries(results).map(([agent, comps]) =>
      `${agent.toUpperCase()}: [${comps.join(', ')}]`
    ).join('\n');

    const body = JSON.stringify({
      model: MODEL_STANDARD,
      messages: [
        {
          role: 'system',
          content: `You have 3 expert perspectives on the concept "${keyword}". Synthesize a FINAL list of 5-7 components that honors the strongest insights from each perspective.

Return ONLY valid JSON:
{
  "components": ["comp1","comp2",...],
  "perspectives": { "comp1": "scientist", "comp2": "philosopher", ... },
  "synthesisReasoning": "1-sentence synthesis explanation"
}`,
        },
        { role: 'user', content: `Expert perspectives:\n${summary}` },
      ],
      temperature: 0.3, max_tokens: 400, stream: false,
    });

    const req = https.request({
      hostname: 'api.deepseek.com', port: 443, path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}`, 'Accept': 'application/json' },
    }, (resp) => {
      let d = '';
      resp.on('data', c => { d += c; });
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          const raw = parsed?.choices?.[0]?.message?.content?.trim() ?? '{}';
          const cleaned = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
          resolve(JSON.parse(cleaned));
        } catch { resolve({ components: [], perspectives: {}, synthesisReasoning: '' }); }
      });
    });
    req.on('error', () => resolve({ components: [], perspectives: {}, synthesisReasoning: '' }));
    req.write(body); req.end();
  });
}

function handleDebate(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405); res.end(JSON.stringify({ error: 'Method not allowed' })); return;
  }
  if (!DEEPSEEK_API_KEY) {
    res.writeHead(500); res.end(JSON.stringify({ error: 'DEEPSEEK_API_KEY not set' })); return;
  }

  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', async () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return;
    }
    const keyword = (parsed.keyword || '').trim();
    const rounds = Math.max(1, Math.min(3, parseInt(parsed.rounds) || 2));
    if (!keyword) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'keyword required' })); return;
    }

    console.log(`[Debate] "${keyword}" — ${rounds} rounds, 3 agents`);

    try {
      // Round 1: Each agent independently fractures
      const round1 = {
        scientist:  await callAgent(AGENTS.SCIENTIST.system, keyword),
        philosopher: await callAgent(AGENTS.PHILOSOPHER.system, keyword),
        artist:     await callAgent(AGENTS.ARTIST.system, keyword),
      };

      // Round 2: Each agent sees the others and revises
      let round2 = round1;
      if (rounds >= 2) {
        const r2Promises = Object.entries(AGENTS).map(async ([key, agent]) => {
          const others = Object.entries(round1)
            .filter(([k]) => k !== key.toLowerCase())
            .map(([k, comps]) => `${k}: [${comps.join(', ')}]`).join(' | ');
          const revised = await callAgent(
            `${agent.system} You just saw other perspectives: ${others}. Revise your decomposition considering their insights. Return ONLY a JSON array.`,
            keyword,
            MODEL_LITE
          );
          return [key.toLowerCase(), revised.length > 0 ? revised : round1[key.toLowerCase()]];
        });
        const r2Entries = await Promise.all(r2Promises);
        round2 = Object.fromEntries(r2Entries);
      }

      // Synthesizer: combine all perspectives
      const synthesis = await callSynthesizer(round2, keyword);

      const debateLog = [
        { round: 1, scientist: round1.scientist, philosopher: round1.philosopher, artist: round1.artist },
      ];
      if (rounds >= 2) {
        debateLog.push({ round: 2, scientist: round2.scientist, philosopher: round2.philosopher, artist: round2.artist });
      }

      const response = {
        components: synthesis.components || [],
        perspectives: synthesis.perspectives || {},
        synthesisReasoning: synthesis.synthesisReasoning || '',
        debateLog,
        model: MODEL_STANDARD,
        tier: 'STANDARD',
      };

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(response));
      console.log(`[Debate] "${keyword}" → ${response.components.length} components synthesized`);
    } catch (err) {
      console.error('[Debate] Error:', err.message);
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
  });
}

// ---- External Tools & AI Agent ----

const toolCache = new Map(); // key → { result, timestamp }
const CACHE_TTL = 3600000; // 1 hour
const toolRateLimit = new Map(); // IP → { calls, windowStart }

function checkToolRate(ip) {
  const now = Date.now();
  const entry = toolRateLimit.get(ip) || { calls: 0, windowStart: now };
  if (now - entry.windowStart > 60000) { entry.calls = 0; entry.windowStart = now; }
  if (entry.calls >= 20) return false;
  entry.calls++;
  toolRateLimit.set(ip, entry);
  return true;
}

function cachedFetch(key, fetcher) {
  const cached = toolCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return Promise.resolve(cached.result);
  return fetcher().then(result => { toolCache.set(key, { result, timestamp: Date.now() }); return result; });
}

// ---- Tool Implementations ----

async function searchWikipedia(query) {
  const key = `wiki:${query.toLowerCase()}`;
  return cachedFetch(key, () => new Promise((resolve) => {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
    https.get(url, { headers: { 'User-Agent': 'LiquidStateEngine/1.0' } }, (resp) => {
      let d = '';
      resp.on('data', c => { d += c; });
      resp.on('end', () => {
        try { const j = JSON.parse(d); resolve(j.extract || j.title || 'No Wikipedia summary found.'); } catch { resolve('Wikipedia unavailable.'); }
      });
    }).on('error', () => resolve('Wikipedia unavailable.'));
  }));
}

async function defineWord(word) {
  const key = `dict:${word.toLowerCase()}`;
  return cachedFetch(key, () => new Promise((resolve) => {
    const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
    https.get(url, (resp) => {
      let d = '';
      resp.on('data', c => { d += c; });
      resp.on('end', () => {
        try {
          const j = JSON.parse(d);
          const meaning = j[0]?.meanings?.[0]?.definitions?.[0]?.definition || 'No definition found.';
          resolve(meaning);
        } catch { resolve('Dictionary unavailable.'); }
      });
    }).on('error', () => resolve('Dictionary unavailable.'));
  }));
}

function calculateMath(expression) {
  try {
    // Safe eval: only allow numbers and operators
    const sanitized = expression.replace(/[^0-9+\-*/().%\s]/g, '');
    const result = Function(`"use strict"; return (${sanitized})`)();
    return String(result);
  } catch { return 'Calculation error'; }
}

function getCurrentDate() {
  return new Date().toISOString().split('T')[0];
}

const TOOLS = {
  searchWikipedia: { fn: searchWikipedia, desc: 'Search Wikipedia for factual summary of a topic', args: 'query:string' },
  defineWord: { fn: defineWord, desc: 'Get dictionary definition of a word', args: 'word:string' },
  calculateMath: { fn: calculateMath, desc: 'Evaluate a mathematical expression', args: 'expression:string' },
  getCurrentDate: { fn: getCurrentDate, desc: 'Get today\'s date', args: 'none' },
};

// ---- Agent Endpoint (ReAct Loop) ----

function handleAgent(req, res) {
  if (req.method !== 'POST') { res.writeHead(405); res.end(JSON.stringify({ error: 'Method not allowed' })); return; }
  if (!DEEPSEEK_API_KEY) { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ answer: 'AI agent unavailable — set DEEPSEEK_API_KEY', toolsUsed: [], trace: [] })); return; }

  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', async () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
    const task = (parsed.task || '').trim();
    const context = (parsed.context || '').trim();
    if (!task) { res.writeHead(400); res.end(JSON.stringify({ error: 'task required' })); return; }

    const ip = req.socket?.remoteAddress || 'unknown';
    if (!checkToolRate(ip)) { res.writeHead(429); res.end(JSON.stringify({ error: 'Rate limit (20 calls/min)' })); return; }

    const toolsUsed = [];
    const trace = [];
    let currentContext = context ? `Context: ${context}\nTask: ${task}` : task;
    let finalAnswer = '';

    const toolList = Object.entries(TOOLS).map(([name, t]) => `- ${name}(${t.args}): ${t.desc}`).join('\n');

    for (let step = 0; step < 4; step++) {
      const prompt = step === 0
        ? `You are an AI agent with access to tools. Task: "${currentContext}"\n\nAvailable tools:\n${toolList}\n\nDecide: do you need a tool to answer this? Return JSON: {"action":"tool|answer","tool":"toolName","args":"argument","reasoning":"why"}\nIf you can answer directly, set action to "answer" and put your answer in a field called "answer".`
        : `Tool result for "${toolsUsed[toolsUsed.length - 1]?.tool}": ${trace[trace.length - 1]?.result?.slice(0, 300)}\n\nTask: "${task}"\n\nCan you answer now, or do you need another tool? Return JSON: {"action":"tool|answer","tool":"...","args":"...","reasoning":"...","answer":"your final answer if action is answer"}`;

      const reqBody = JSON.stringify({ model: MODEL_STANDARD, messages: [{ role: 'system', content: 'You are a tool-using AI agent. Return ONLY valid JSON.' }, { role: 'user', content: prompt }], temperature: 0.2, max_tokens: 300 });
      const opts = { hostname: 'api.deepseek.com', port: 443, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}`, 'Accept': 'application/json' } };

      try {
        const apiResult = await new Promise((resolve) => {
          const apiReq = https.request(opts, (apiRes) => {
            let d = ''; apiRes.on('data', c => { d += c; }); apiRes.on('end', () => resolve(d));
          });
          apiReq.on('error', () => resolve(''));
          apiReq.write(reqBody); apiReq.end();
        });

        const p = JSON.parse(apiResult);
        const raw = p?.choices?.[0]?.message?.content?.trim() ?? '{}';
        const cleaned = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
        const decision = JSON.parse(cleaned);

        trace.push({ step, decision: decision.action, reasoning: decision.reasoning || '' });

        if (decision.action === 'answer' || !decision.tool) {
          finalAnswer = decision.answer || decision.reasoning || 'Task completed.';
          break;
        }

        // Execute tool
        const toolName = decision.tool;
        const tool = TOOLS[toolName];
        if (!tool) { finalAnswer = `Unknown tool: ${toolName}`; break; }

        let toolResult;
        try { toolResult = await tool.fn(decision.args || ''); } catch (e) { toolResult = `Tool error: ${e.message}`; }

        toolsUsed.push({ tool: toolName, args: decision.args || '' });
        trace[trace.length - 1].result = typeof toolResult === 'string' ? toolResult.slice(0, 500) : String(toolResult);
        currentContext = `Tool result: ${trace[trace.length - 1].result}`;
      } catch (err) {
        trace.push({ step, error: err.message });
        finalAnswer = 'Agent encountered an error.';
        break;
      }
    }

    if (!finalAnswer) finalAnswer = 'Could not resolve task within tool budget.';
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ answer: finalAnswer, toolsUsed, trace }));
    console.log(`[Agent] "${task.slice(0, 50)}" → ${toolsUsed.length} tools → answered`);
  });
}

// ---- Tool-Augmented Fracture (Wikipedia grounding) ----

async function maybeGroundWithWikipedia(keyword) {
  try {
    const summary = await searchWikipedia(keyword);
    if (summary && summary.length > 20 && !summary.includes('unavailable')) {
      return summary.slice(0, 500);
    }
  } catch {}
  return null;
}

// ---- Concept Description (tooltip definitions) ----

const descCache = new Map();

function handleDescribe(req, res) {
  if (req.method !== 'POST') { res.writeHead(405); res.end(JSON.stringify({ error: 'Method not allowed' })); return; }
  if (!DEEPSEEK_API_KEY) { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ description: 'AI description unavailable' })); return; }

  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
    const keyword = (parsed.keyword || '').trim();
    if (!keyword) { res.writeHead(400); res.end(JSON.stringify({ error: 'keyword required' })); return; }

    // Check cache
    const cacheKey = keyword.toLowerCase();
    if (descCache.has(cacheKey)) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ description: descCache.get(cacheKey) }));
      return;
    }

    const reqBody = JSON.stringify({
      model: MODEL_LITE,
      messages: [
        { role: 'system', content: 'You are a concise encyclopedia. Given a concept, provide a 1-sentence definition (max 15 words). Respond in the SAME language as the input. If the input is Thai, respond in Thai. If English, respond in English. Return ONLY the definition text, no quotes, no markdown.' },
        { role: 'user', content: keyword },
      ],
      temperature: 0.3, max_tokens: 60, stream: false,
    });

    const opts = { hostname: 'api.deepseek.com', port: 443, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}`, 'Accept': 'application/json' } };

    const apiReq = https.request(opts, (apiRes) => {
      let d = '';
      apiRes.on('data', c => { d += c; });
      apiRes.on('end', () => {
        let description = '';
        if (apiRes.statusCode === 200) {
          try {
            const p = JSON.parse(d);
            description = (p?.choices?.[0]?.message?.content?.trim() || '').replace(/^["']|["']$/g, '');
          } catch {}
        }
        if (!description) description = keyword;
        descCache.set(cacheKey, description);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ description }));
      });
    });
    apiReq.on('error', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ description: keyword }));
    });
    apiReq.write(reqBody); apiReq.end();
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
  if (url.pathname === '/api/describe') {
    handleDescribe(req, res);
    return;
  }
  if (url.pathname === '/api/agent') {
    handleAgent(req, res);
    return;
  }
  if (url.pathname === '/api/counterfactual') {
    handleCounterfactual(req, res);
    return;
  }
  if (url.pathname === '/api/detect-tension') {
    handleTension(req, res);
    return;
  }
  if (url.pathname === '/api/curiosity') {
    handleCuriosity(req, res);
    return;
  }
  if (url.pathname === '/api/analogy') {
    handleAnalogy(req, res);
    return;
  }
  if (url.pathname === '/api/classify') {
    handleClassify(req, res);
    return;
  }
  if (url.pathname === '/api/debate') {
    handleDebate(req, res);
    return;
  }
  if (url.pathname === '/api/embed') {
    handleEmbed(req, res);
    return;
  }
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
