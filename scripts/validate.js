#!/usr/bin/env node
/**
 * Liquid-State Engine — Pre-Commit Validator
 *
 * Checks for known dangerous patterns that have caused crashes before.
 * Run: node scripts/validate.js
 * Exit code 0 = pass, 1 = fail
 *
 * Use as git pre-commit hook:
 *   ln -sf ../../scripts/validate.js .git/hooks/pre-commit
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const SCRIPTS = path.join(ROOT, 'scripts');

let errors = 0;
let warnings = 0;

function error(file, line, msg) {
  console.error(`  ❌ ERROR ${file}:${line} — ${msg}`);
  errors++;
}

function warn(file, line, msg) {
  console.warn(`  ⚠️  WARN  ${file}:${line} — ${msg}`);
  warnings++;
}

function checkFile(filePath, rules) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const relPath = path.relative(ROOT, filePath);

    for (const rule of rules) {
      if (rule.pattern.test(line)) {
        if (rule.exclude && rule.exclude.test(line)) continue;
        if (rule.severity === 'error') {
          error(relPath, lineNum, rule.message);
        } else {
          warn(relPath, lineNum, rule.message);
        }
      }
    }
  }
}

// ============================================================
// Rule Definitions
// ============================================================

const CSS_RULES = [
  {
    pattern: /\.data-box[^{]*\{[^}]*pointer-events\s*:\s*none/,
    message: 'pointer-events:none on .data-box — will block all interaction!',
    severity: 'error',
  },
  {
    pattern: /pointer-events\s*:\s*none/,
    exclude: /\/\*|\/\/|\.particle|#trails-canvas|#relations-svg|#tension-svg|\.hud-root|\.node-tooltip|\.analogy-slot|\.remote-cursor/,
    message: 'pointer-events:none — verify this is on a non-interactive element only',
    severity: 'warn',
  },
];

const JS_RULES_WEB = [
  {
    pattern: /pointer-events\s*[=:]\s*['"]auto['"]/,
    exclude: /\.pointerEvents\s*=\s*'stroke'|#create-btn|\.rating-btns|\.suggested|\.hud/,
    message: 'pointer-events:auto on overlay/SVG — may block workspace clicks!',
    severity: 'error',
  },
  {
    pattern: /JSON\.parse\s*\(/,
    exclude: /safeParseAIJson|localStorage|JSON\.parse\(body\)|JSON\.parse\(e\.data\)|JSON\.parse\(stored\)|JSON\.parse\(raw\)|JSON\.parse\(fb\)|JSON\.parse\(pf\)/,
    message: 'Raw JSON.parse on potential AI response — use safeParseAIJson() instead',
    severity: 'warn',
  },
];

const JS_RULES_SERVE = [
  {
    pattern: /JSON\.parse\s*\(/,
    exclude: /safeParseAIJson|JSON\.parse\(body\)|JSON\.parse\(data\)|require/,
    message: 'JSON.parse without safeParseAIJson — AI responses may be truncated/non-ASCII',
    severity: 'warn',
  },
  {
    pattern: /max_tokens\s*[:=]\s*[1-9]\d?\s*[,}\n]/,
    message: 'max_tokens < 100 — likely too low for structured JSON response',
    severity: 'warn',
  },
];

const GLOBAL_JS_RULES = [
  {
    pattern: /^\s*const\s+\w+\s*=(?!.*(?:require|import|document|window|new |Map|Set|=>|\{|\[))/,
    exclude: /ENDPOINT|KEY|STORAGE|MIME|ULTRA_KEYWORDS|TECHNICAL_SYMBOLS|PARTICLE|DURATION|COLORS|WS_URL|AGENT_COLORS|PORT|ROOT|PKG|DEEPSEEK/,
    message: 'const used — verify this value is never reassigned (use let if unsure)',
    severity: 'warn',
  },
];

// ============================================================
// Import/Export Validation
// ============================================================

function validateImports() {
  const mainPath = path.join(WEB, 'main.js');
  if (!fs.existsSync(mainPath)) return;

  const content = fs.readFileSync(mainPath, 'utf-8');
  const importRegex = /import\s*\{([^}]+)\}\s*from\s*['"]\.\/([^'"]+)['"]/g;
  let match;

  while ((match = importRegex.exec(content)) !== null) {
    const importedNames = match[1].split(',').map(s => s.trim());
    const modulePath = path.join(WEB, match[2]);

    if (!fs.existsSync(modulePath)) {
      error('web/main.js', 0, `Import from '${match[2]}' — FILE DOES NOT EXIST!`);
      continue;
    }

    const moduleContent = fs.readFileSync(modulePath, 'utf-8');
    for (const name of importedNames) {
      if (!name) continue;
      const exportPattern = new RegExp(`export\\s+(function|class|const|let|var|async\\s+function)\\s+${name}\\b`);
      const exportDefault = new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`);
      if (!exportPattern.test(moduleContent) && !exportDefault.test(moduleContent)) {
        error('web/main.js', 0, `Import '${name}' from '${match[2]}' — NOT EXPORTED by that file!`);
      }
    }
  }
}

// ============================================================
// Variable Declaration Check
// ============================================================

function checkUndeclaredInHandlers() {
  const mainPath = path.join(WEB, 'main.js');
  if (!fs.existsSync(mainPath)) return;

  const content = fs.readFileSync(mainPath, 'utf-8');

  // Known state variables that MUST be declared
  const requiredVars = ['mouseX', 'mouseY', 'isDragging', 'dragNodeId', 'dragTarget', 'dragStartX', 'dragStartY', 'nodeStartX', 'nodeStartY', 'mergeTarget'];

  for (const v of requiredVars) {
    const declPattern = new RegExp(`(let|var|const)\\s+${v}\\b`);
    if (!declPattern.test(content)) {
      error('web/main.js', 0, `Required variable '${v}' is NOT declared — will cause ReferenceError!`);
    }
  }
}

// ============================================================
// Z-Index Sanity Check
// ============================================================

function checkZIndexConflicts() {
  const cssPath = path.join(WEB, 'style.css');
  if (!fs.existsSync(cssPath)) return;

  const content = fs.readFileSync(cssPath, 'utf-8');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/z-index\s*:\s*(\d+)/);
    if (match) {
      const z = parseInt(match[1]);
      // data-box should be at least 100
      if (lines.slice(Math.max(0, i - 5), i).join('\n').includes('.data-box') && z < 100) {
        warn('web/style.css', i + 1, `.data-box z-index is ${z} — should be >= 100 to stay above overlays`);
      }
    }
  }
}

// ============================================================
// Run All Checks
// ============================================================

console.log('\n🔍 Liquid-State Engine — Pre-Commit Validation\n');

// CSS checks
console.log('📋 Checking CSS rules...');
const cssFiles = fs.readdirSync(WEB).filter(f => f.endsWith('.css')).map(f => path.join(WEB, f));
cssFiles.push(path.join(WEB, 'hud', 'style.css'));
for (const f of cssFiles) {
  if (fs.existsSync(f)) checkFile(f, CSS_RULES);
}

// JS checks (web/)
console.log('📋 Checking web/ JavaScript...');
const webJsFiles = fs.readdirSync(WEB).filter(f => f.endsWith('.js')).map(f => path.join(WEB, f));
for (const f of webJsFiles) {
  checkFile(f, JS_RULES_WEB);
}

// JS checks (scripts/)
console.log('📋 Checking scripts/ JavaScript...');
const scriptFiles = fs.readdirSync(SCRIPTS).filter(f => f.endsWith('.js')).map(f => path.join(SCRIPTS, f));
for (const f of scriptFiles) {
  if (f.includes('validate.js')) continue; // don't check ourselves
  checkFile(f, JS_RULES_SERVE);
}

// Import/Export validation
console.log('📋 Validating imports/exports...');
validateImports();

// Variable declarations
console.log('📋 Checking required variable declarations...');
checkUndeclaredInHandlers();

// Z-index sanity
console.log('📋 Checking z-index hierarchy...');
checkZIndexConflicts();

// ============================================================
// Results
// ============================================================

console.log('');
if (errors > 0) {
  console.error(`\n💀 FAILED: ${errors} error(s), ${warnings} warning(s)`);
  console.error('   Fix all errors before committing.\n');
  process.exit(1);
} else if (warnings > 0) {
  console.warn(`\n⚠️  PASSED with ${warnings} warning(s)`);
  console.warn('   Review warnings — they may indicate potential issues.\n');
  process.exit(0);
} else {
  console.log('\n✅ ALL CHECKS PASSED — safe to commit.\n');
  process.exit(0);
}
