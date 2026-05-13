# Liquid-State Engine — Project Rules & Conventions

## Architecture Overview

This is a DOM-based AI workspace where concepts (nodes) are created, fractured, merged, and analyzed using DeepSeek API.

### File Structure
- `scripts/serve.js` — Node.js dev server + AI proxy (DeepSeek API)
- `web/main.js` — Main frontend orchestrator (drag, create, fracture, merge, debate, analogy)
- `web/ai-enrich.js` — Client-side AI enrichment caller
- `web/ai-memory.js` — Semantic memory (knowledge graph)
- `web/semantic-space.js` — Embedding-based similarity
- `web/ontology.js` — IS-A hierarchy tree
- `web/tension-detector.js` — Contradiction detection (SVG lines)
- `web/curiosity.js` — Proactive AI suggestions
- `web/meta-learner.js` — User feedback learning
- `web/collab.js` — WebSocket collaboration
- `web/trails.js` — Energy beam canvas effects
- `web/particles.js` — Fracture/merge particle effects
- `web/audio.js` — Web Audio procedural sounds
- `web/persistence.js` — Save/load workspace
- `web/relations-viz.js` — SVG relationship lines
- `web/hud/app.js` — Preact HUD overlay
- `web/style.css` — Main styles (glassmorphism)
- `web/hud/style.css` — HUD panel styles

## Critical Rules (MUST FOLLOW)

### 1. Never Add `pointer-events: none` to Interactive Elements
- `.data-box` must ALWAYS be clickable and draggable
- Only use `pointer-events: none` on overlay/decoration layers (canvas, SVG containers, particles)
- SVG overlays (tension-svg, relations-svg) MUST have `pointer-events: none` on the container
- Individual SVG paths can use `pointer-events: stroke` if they need click handling

### 2. Always Declare Variables Before Use
- Every variable used in event handlers MUST be declared with `let` or `const` at module top-level
- Never rely on implicit globals
- Key state variables: `mouseX`, `mouseY`, `isDragging`, `dragTarget`, `dragNodeId`, `mergeTarget`

### 3. CSS Transitions Must Not Block Drag
- When starting a drag: set `element.style.transition = 'none'`
- When ending a drag: restore with `element.style.transition = ''`
- Never leave `transition: left 0.6s` on a node that's being actively dragged

### 4. AI API Responses — Always English JSON
- All DeepSeek prompts MUST include: "Respond in English ONLY. Return valid JSON."
- Use `safeParseAIJson()` for ALL AI response parsing (never raw `JSON.parse`)
- Set adequate `max_tokens` (minimum 200 for any structured response)
- Strip non-ASCII before parsing: `text.replace(/[^\x00-\x7F]/g, '')`

### 5. Safety Timeouts for Async States
- Any element that gets class `enriching` MUST have a safety timeout (15s) to remove it
- Any element that gets class `merging` MUST recover if the API call fails (try/catch/finally)
- Never leave a node in a loading state permanently

### 6. ES Module Import Discipline
- `web/main.js` uses ES modules (`type="module"` in index.html)
- All imports must match exact export names — verify before adding new imports
- If any import fails, the ENTIRE module stops executing (no partial execution)
- Test that all imported files exist and export the expected names

### 7. SVG/Canvas Overlay Layers — Z-Index Rules
```
z-index:   1 — #workspace
z-index:  45 — #trails-canvas (pointer-events: none)
z-index:  50 — #relations-svg (pointer-events: none)  
z-index:  55 — #tension-svg (pointer-events: none)
z-index:  90 — .suggested ghost nodes
z-index: 100 — .data-box (interactive)
z-index: 500 — analogy slots
z-index: 2000 — #create-btn, HUD panels
z-index: 3000 — .input-overlay (modal dialogs)
z-index: 5000 — .context-menu, .curiosity-bubble, tooltips
z-index: 9999 — remote cursors, toasts
```

### 8. `const` vs `let` Decision
- Use `const` ONLY for values that are never reassigned
- If a variable will EVER be modified (even with `+=`), use `let`
- When in doubt, use `let` — a `const` reassignment crash is worse than a `let` being constant

### 9. Server-Side (serve.js) Rules
- All API endpoints return JSON with `Content-Type: application/json`
- Include `Access-Control-Allow-Origin: *` on all responses
- Use `Cache-Control: no-store, no-cache, must-revalidate` for static files
- The `DEEPSEEK_API_KEY` is server-side only — never expose to client
- Model routing: LITE (flash), STANDARD (chat), ULTRA (pro)

### 10. Testing Changes
- After ANY code change, verify:
  1. `node scripts/serve.js` starts without errors
  2. Browser loads without console errors (except WebSocket 8081 which is optional)
  3. Can create a node
  4. Can drag a node continuously without freezing
  5. Can double-click to fracture
  6. Can drag two nodes together to merge
