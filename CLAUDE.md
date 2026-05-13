# CLAUDE.md — AI Coding Rules for Liquid-State-Engine

> This file is read by Claude Code (and other AI assistants) before making changes.
> Follow these rules STRICTLY. Violations cause runtime crashes.

## Golden Rules

1. **READ before EDIT** — Always read the full file before modifying it. Never guess at code structure.
2. **ONE concern per commit** — Don't mix features with bug fixes.
3. **Test after EVERY change** — Run `node scripts/serve.js` and verify no startup errors.
4. **Never break drag** — After any change, verify nodes can be dragged continuously.

## Forbidden Patterns (Will Crash)

### ❌ NEVER DO:
```js
// 1. Undeclared variables in event handlers
mouseX = e.clientX;  // ← CRASH: ReferenceError if not declared with let/var

// 2. const for reassignable values
const prompt = "base";
prompt += " extra";  // ← CRASH: TypeError: Assignment to constant variable

// 3. pointer-events: none on data-box or its parents
.data-box.some-state { pointer-events: none; }  // ← BREAKS ALL INTERACTION

// 4. Full-screen overlays with pointer-events: auto
svg.style.cssText = '...pointer-events:auto...';  // ← BLOCKS ENTIRE UI

// 5. Raw JSON.parse on AI responses
const data = JSON.parse(aiResponse);  // ← CRASH: AI returns truncated/non-ASCII

// 6. Missing export names in imports
import { nonExistent } from './module.js';  // ← ENTIRE MODULE FAILS SILENTLY
```

### ✅ ALWAYS DO:
```js
// 1. Declare all state variables at module top
let mouseX = 0;
let mouseY = 0;

// 2. Use let when value might change
let prompt = "base";
prompt += " extra";

// 3. Keep data-box always interactive
.data-box { pointer-events: auto !important; }  // last resort if needed

// 4. SVG/Canvas overlays pass-through
svg.style.pointerEvents = 'none';
path.style.pointerEvents = 'stroke';  // only lines clickable

// 5. Use safeParseAIJson for AI responses
const data = safeParseAIJson(aiResponse, { fallback: true });

// 6. Verify exports exist before adding imports
// Check the target file first!
```

## File Modification Checklist

Before modifying ANY file, verify:

- [ ] I have READ the current file content
- [ ] My changes don't remove existing `let`/`const` declarations
- [ ] I'm not adding `pointer-events: none` to anything interactive
- [ ] I'm not adding a full-screen element with `pointer-events: auto`
- [ ] Any new variables are declared with `let` (not `const` unless truly immutable)
- [ ] Any new imports match exact export names in the target file
- [ ] Any new CSS doesn't add `transition` to elements that get dragged
- [ ] Any new async operation has error handling (try/catch) and timeout recovery

## Architecture Constraints

### Event System (web/main.js)
- mousedown/mousemove/mouseup handlers are on `workspace` and `window`
- Touch handlers mirror mouse handlers exactly
- `dragTarget.style.transition = 'none'` MUST be set during drag
- `isDragging` and `dragNodeId` MUST be reset on mouseup/touchend

### AI Response Parsing (scripts/serve.js)
- ALL prompts include: "Respond in English ONLY. Return valid JSON."
- ALL responses parsed with `safeParseAIJson(text, fallbackValue)`
- `max_tokens` minimum: 200 for JSON responses, 512 for component arrays
- Non-ASCII stripped before parse: `text.replace(/[^\x00-\x7F]/g, '')`

### CSS Layer Order (z-index)
```
  1: #workspace
 45: #trails-canvas (pointer-events: none)
 50: #relations-svg (pointer-events: none)
 55: #tension-svg (pointer-events: none)
100: .data-box (ALWAYS interactive)
2000: HUD, buttons
3000: modal overlays
5000: context menus, tooltips
```

### State Recovery
- `.enriching` class: auto-removed after 15s timeout
- `.merging` class: restored on API failure in catch block
- `.debating` class: restored on API failure in catch block
- Drag state: always reset in mouseup (even if error thrown)

## Commit Message Format

```
type: brief description

Types: fix, feat, refactor, style, docs, test
Examples:
  fix: resolve drag freeze caused by tension-svg overlay
  feat: add counterfactual reasoning mode
  refactor: extract safeParseAIJson into utility module
```

## Testing Protocol

After ANY code change, run this verification:

```bash
# 1. Server starts clean
node scripts/serve.js
# Expected: No errors, "🌊 Liquid-State Engine dev server running"

# 2. In browser (http://localhost:8080):
# - Create node → should appear
# - Drag node → should follow mouse smoothly, no freeze after 2s
# - Double-click node → should fracture into components
# - Drag node A onto node B → should merge
# - Check console: no ReferenceError, no TypeError
```

## Known Safe Patterns

### Adding a new API endpoint:
```js
// In serve.js HTTP server handler, add BEFORE static file serving:
if (url.pathname === '/api/new-endpoint') {
  handleNewEndpoint(req, res);
  return;
}
```

### Adding a new CSS state to .data-box:
```css
/* SAFE: visual only, no pointer-events change */
.data-box.new-state {
  border-color: rgba(100, 200, 255, 0.5);
  animation: someAnim 1s ease-in-out;
  /* NEVER: pointer-events: none */
}
```

### Adding a new keyboard shortcut:
```js
// In the keyboard shortcuts section (search for "Keyboard Shortcuts")
if (key === 'n') {
  // new feature
}
```

### Adding a new module import:
```js
// 1. FIRST: verify the file exists and exports what you need
// 2. Add import at the top of main.js with other imports
// 3. If import fails → entire main.js stops → everything breaks
// 4. So ALWAYS verify the export name matches exactly
```
