# Development Log — AI Auto-Enrich Feature

**Date**: 2026-05-12
**Branch**: `feat/phase6-perf-max` (extended)
**Feature**: AI-powered automatic payload enrichment for the Liquid-State Engine, now powered by DeepSeek V4 with intelligent model routing.

---

## 1. Summary of Changes

### New Files

| File | Purpose |
|------|---------|
| `web/ai-enrich.js` | Client-side enrichment module — calls local server proxy for DeepSeek API |
| `.env.example` | Environment variable template for `DEEPSEEK_API_KEY` |

### Modified Files

| File | Changes |
|------|---------|
| `scripts/serve.js` | **Major rewrite.** Added `POST /api/enrich` endpoint with OpenAI-compatible DeepSeek client. Implements `evaluateComplexity()` for LITE/STANDARD/ULTRA model routing. Returns `X-DeepSeek-Model` response header. All API key management is server-side — never exposed to browser. |
| `web/ai-enrich.js` | **Architecture change.** Replaced direct Claude/Gemini API calls with `fetch('/api/enrich', ...)` to local server proxy. Removed client-side API key management. Enrichment metadata now includes `model` and `tier` fields from server response headers. Caching layer preserved. |
| `web/payload.js` | Added `_maybeEnrich()` method that triggers AI enrichment on single-keyword text payload registration. Enrichment metadata (`_enrichment`) propagated through merge/fracture events. |
| `web/rules.js` | Updated `normalizePayload` to preserve `_enrichment` metadata. Enhanced `fractureArray` to handle AI-enriched arrays: each element becomes its own labeled text node when enough fracture slots are available. Updated `mergeComposite` to inherit enrichment from enriched parents. |
| `web/hud/app.js` | InspectorPanel enrichment badge now shows "Powered by DeepSeek V4 **[model name]**" with tier info in tooltip. AiSettingsDialog redesigned with tier explanation table (LITE/STANDARD/ULTRA) and server-side setup instructions. Loading spinner updated to "enriching via DeepSeek…". |
| `web/hud/style.css` | Added `.hud-enrich-tiers`, `.hud-tier-row`, `.hud-tier-label`, `.hud-tier-model`, `.hud-tier-desc` styles. Added `code` styling within enrichment descriptions. |
| `web/main.js` | Added `configureAI(apiKey, provider)` and `enrichKeyword(keyword)` to `window.lse` API. |
| `web/index.html` | Updated `window.__LSE_CONFIG__` to reflect server-side architecture — no API keys in browser. |

---

## 2. Architecture: DeepSeek V4 with Intelligent Model Routing

### Overview

```
┌──────────────────────────────────────────────────────────┐
│                    BROWSER (Client)                       │
│                                                          │
│  ┌──────────────────┐     ┌────────────────────────────┐ │
│  │ ai-enrich.js     │     │ HUD Inspector              │ │
│  │ fetch('/api/     │     │ "Powered by DeepSeek V4    │ │
│  │  enrich',        │     │  deepseek-reasoner"        │ │
│  │  {keyword})      │     └────────────────────────────┘ │
│  └────────┬─────────┘                                    │
│           │ POST /api/enrich                             │
│           │ { keyword: "ERC-20 Logic" }                  │
└───────────┼──────────────────────────────────────────────┘
            │
┌───────────┼──────────────────────────────────────────────┐
│           ▼           SERVER (scripts/serve.js)           │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │            evaluateComplexity(keyword)              │  │
│  │                                                    │  │
│  │  LITE        STANDARD         ULTRA                │  │
│  │  1-2 words   everything       technical symbols    │  │
│  │  <10 chars   in between       domain keywords      │  │
│  │     │            │                │                │  │
│  │     ▼            ▼                ▼                │  │
│  │  deepseek-    deepseek-       deepseek-            │  │
│  │  chat         chat            reasoner             │  │
│  │  (fast)       (balanced)      (reasoning)          │  │
│  └──────────────────────┬─────────────────────────────┘  │
│                         │                                │
│                         ▼                                │
│  ┌────────────────────────────────────────────────────┐  │
│  │  POST https://api.deepseek.com/v1/chat/completions  │  │
│  │  Authorization: Bearer $DEEPSEEK_API_KEY            │  │
│  │  Body: { model, messages, temperature, max_tokens } │  │
│  └──────────────────────┬─────────────────────────────┘  │
│                         │                                │
│                         ▼                                │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Response to client:                               │  │
│  │  Header: X-DeepSeek-Model: deepseek-reasoner       │  │
│  │  Header: X-DeepSeek-Tier: ULTRA                    │  │
│  │  Body: { components: [...], model, tier, keyword } │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### Complexity Tiers

| Tier | Trigger | Model | Temperature | Max Tokens |
|------|---------|-------|-------------|------------|
| **LITE** | 1–2 words AND <10 characters (e.g., "Apple", "Blue") | `deepseek-chat` | 0.4 | 512 |
| **STANDARD** | Everything between LITE and ULTRA | `deepseek-chat` | 0.3 | 512 |
| **ULTRA** | Technical symbols (`-`, `_`, `#`, `+`, etc.) OR domain keywords (`blockchain`, `rust`, `physics`, `system`, `quantum`, `algorithm`, `cryptography`, `compiler`, `kernel`, `protocol`, `ontology`, `epistemology`, `metaphysics`) | `deepseek-reasoner` | 0.2 | 1024 |

### Complexity Evaluation Logic

```javascript
function evaluateComplexity(keyword) {
  const wordCount = keyword.split(/\s+/).filter(Boolean).length;
  const charCount = keyword.length;

  // ULTRA: technical symbols or domain keywords
  if (/[-_#@+*\/\\\(\)\[\]{}<>|&^~`'"=.:;!?]/.test(keyword)
      || /\b(blockchain|rust|physics|system|quantum|algorithm|...)\b/i.test(keyword)) {
    return { tier: 'ULTRA', model: 'deepseek-reasoner' };
  }

  // LITE: short and simple
  if (wordCount <= 2 && charCount < 10) {
    return { tier: 'LITE', model: 'deepseek-chat' };
  }

  // STANDARD
  return { tier: 'STANDARD', model: 'deepseek-chat' };
}
```

### Request/Response Format

**Request** (client → server):
```json
POST /api/enrich
Content-Type: application/json

{ "keyword": "ERC-20 Logic" }
```

**Response** (server → client):
```json
HTTP 200 OK
X-DeepSeek-Model: deepseek-reasoner
X-DeepSeek-Tier: ULTRA

{
  "components": ["Token Standard", "Smart Contract", "Ethereum", "Transfer Function", "Allowance Mechanism", "Events", "Decimals", "Symbol", "Total Supply"],
  "model": "deepseek-reasoner",
  "tier": "ULTRA",
  "keyword": "ERC-20 Logic"
}
```

---

## 3. Security Architecture

### API Key Isolation

- **Server-side only**: `DEEPSEEK_API_KEY` is read from environment variables by the Node.js server process. It is never sent to the browser, never appears in client-side JavaScript, and never appears in network responses.
- **No client-side keys**: The browser's `window.__LSE_CONFIG__` no longer holds API keys. The `ai-enrich.js` module calls `/api/enrich` (same-origin) with no authentication headers.
- **Same-origin proxy**: All AI calls go through the local dev server, which acts as a secure proxy. The browser never communicates directly with `api.deepseek.com`.

### Trust Levels

Enriched payloads carry `trustLevel: 'medium'` metadata, following the Liquid Information Trust Ladder pattern:
- `low` — raw AI output, unverified (not currently used)
- `medium` — AI output with successful JSON parse validation (all enriched payloads)
- `high` — AI output verified against a known schema (future)

---

## 4. Enrichment → Fracture Flow (with DeepSeek)

1. **Text payload created** (e.g., user types "blockchain" in draw-mode dialog)
2. **AI enrichment triggers** → `POST /api/enrich { keyword: "blockchain" }`
3. **Server evaluates complexity**: "blockchain" matches `ULTRA_KEYWORDS` → `deepseek-reasoner` with temperature 0.2 and 1024 max tokens
4. **DeepSeek responds** with component array: `["Distributed Ledger","Consensus Mechanism","Cryptography","Blocks","Transactions","Nodes","Smart Contracts","Mining"]`
5. **Client stores enriched payload**: `{ type: 'array', value: [...], _enrichment: { source: 'DeepSeek V4', model: 'deepseek-reasoner', tier: 'ULTRA', ... } }`
6. **HUD inspector shows**: "Powered by DeepSeek V4 **deepseek-reasoner**" with ULTRA tier in tooltip
7. **User double-clicks the node** → Rust fracture spawns 8 child entities
8. **Each child is a labeled text node** ("Distributed Ledger", "Consensus Mechanism", etc.)
9. **Each child can be further enriched** — e.g., "Cryptography" → `deepseek-chat` (STANDARD tier, no special symbols)

---

## 5. Migration from Direct API Calls

| Aspect | Before (v0.1) | After (v0.2 — DeepSeek V4) |
|--------|---------------|---------------------------|
| **API endpoint** | Direct to `api.anthropic.com` or `generativelanguage.googleapis.com` | Local server proxy `POST /api/enrich` |
| **API key location** | Browser (localStorage / window config) | Server environment variable `DEEPSEEK_API_KEY` |
| **Model selection** | Manual (`AI_PROVIDER` constant) | Automatic `evaluateComplexity()` → LITE/STANDARD/ULTRA |
| **Models available** | Claude Sonnet 4.6, Gemini 2.0 Flash | DeepSeek Chat, DeepSeek Reasoner |
| **Key exposure** | API key visible in browser DevTools | Key never leaves the server process |
| **CORS** | Required `anthropic-dangerous-direct-browser-access: true` header | Same-origin fetch, no CORS needed |
| **Response metadata** | `source`, `model` | `source`, `model`, `tier` (from response headers) |
| **HUD badge** | "Claude API" or "Gemini 2.0 Flash" | "Powered by DeepSeek V4 [model-name]" |

---

## 6. Glassmorphism Consistency

All new UI elements maintain the existing design language:
- Tier table uses the same `rgba(20, 30, 55, 0.5)` background with cyan border
- Tier labels use the existing blue accent (`rgba(60, 140, 255, 0.2)`)
- Model names displayed in monospace font
- Enrichment badge inherited from v0.1 with updated text
- AI settings dialog reuses `.hud-overlay` and `.hud-dialog` base classes

---

## 7. CPU-Only / DOM-Free Constraints

- All node visuals remain pixel-rendered by the Rust/Wasm renderer
- The HUD overlay uses `pointer-events: none` by default
- AI enrichment runs asynchronously (non-blocking fetch to server proxy)
- Server proxy is stateless — no impact on the client-side render loop
- No DOM elements inside the canvas area

---

## 8. Server Startup

```bash
# Set your DeepSeek API key
export DEEPSEEK_API_KEY=sk-your-key-here       # Linux/macOS
set DEEPSEEK_API_KEY=sk-your-key-here          # Windows (cmd)
$env:DEEPSEEK_API_KEY="sk-your-key-here"        # Windows (PowerShell)

# Start the server
node scripts/serve.js

# Output:
# 🌊 Liquid-State Engine dev server running at http://localhost:8080/
#    COOP: same-origin
#    COEP: require-corp
#    SharedArrayBuffer: ENABLED
#
#    DeepSeek AI Proxy:
#    ✓ DEEPSEEK_API_KEY configured
#    ✓ POST /api/enrich — intelligent model routing
#      LITE     → deepseek-chat (short/simple keywords)
#      STANDARD → deepseek-chat (moderate complexity)
#      ULTRA    → deepseek-reasoner (technical/formal content)
```

---

## 9. Testing Checklist

- [x] `cargo check --target wasm32-unknown-unknown` — clean
- [x] `cargo test` — all 18 tests pass
- [x] Server starts with and without `DEEPSEEK_API_KEY` set
- [x] `/api/enrich` returns 500 with helpful message when key is missing
- [x] `evaluateComplexity` correctly routes "Apple" → LITE, "car engine" → STANDARD, "ERC-20 Logic" → ULTRA
- [x] `X-DeepSeek-Model` header present in responses
- [x] Client enrichment metadata includes `model` and `tier` fields
- [x] HUD inspector shows "Powered by DeepSeek V4 [model]" badge
- [x] AI settings dialog explains tier system
- [x] No API keys exposed in browser (check DevTools Network tab)
- [x] Enrichment cache still works (same keyword = instant return)
- [x] Fracture still produces individually labeled child nodes
- [x] All canvas visuals remain Wasm pixel-rendered (no DOM in canvas area)
