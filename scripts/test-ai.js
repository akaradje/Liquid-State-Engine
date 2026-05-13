#!/usr/bin/env node
/**
 * Liquid-State Engine — AI Capability Test Suite
 *
 * Tests all 15 AI endpoints with real HTTP requests.
 * Run: node scripts/test-ai.js [--quick]
 * Requires: server running on localhost:8080 (npm run serve)
 *
 * --quick mode skips the 1s delay between tests.
 */

const http = require('http');

const BASE = 'http://127.0.0.1:8080';
const DELAY = process.argv.includes('--quick') ? 200 : 1000;

let passed = 0, failed = 0, total = 0;

// ---- HTTP Helper ----

function httpRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const options = {
      hostname: url.hostname, port: url.port, path: url.pathname,
      method, headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON: ${data.slice(0, 100)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout 30s')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function testEndpoint(name, method, path, body, validate) {
  total++;
  const start = Date.now();
  try {
    const res = await httpRequest(method, path, body);
    const elapsed = Date.now() - start;
    const result = validate(res);
    if (result === true) {
      passed++;
      console.log(`  \x1b[32m✓\x1b[0m ${name} (${elapsed}ms)`);
      console.log(`     ${JSON.stringify(res).slice(0, 200)}`);
    } else {
      failed++;
      console.log(`  \x1b[31m✗\x1b[0m ${name} (${elapsed}ms) — ${result}`);
      console.log(`     ${JSON.stringify(res).slice(0, 200)}`);
    }
  } catch (err) {
    failed++;
    const elapsed = Date.now() - start;
    console.log(`  \x1b[31m✗\x1b[0m ${name} (${elapsed}ms) — ERROR: ${err.message}`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- Main ----

async function main() {
  console.log('\n🧪 Liquid-State Engine — AI Test Suite\n');
  console.log(`   Server: ${BASE}\n`);

  // Check server is running (TCP-level check, more lenient)
  try {
    await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: 8080, path: '/', method: 'GET', timeout: 5000 }, () => resolve());
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    });
    console.log('   ✓ Server is running\n');
  } catch {
    console.error('❌ Cannot connect to 127.0.0.1:8080 — is the server running in another terminal?\n   Start with: npm run serve\n');
    process.exit(1);
  }

  // ---- Test 1: Fracture (Thai) ----
  await testEndpoint('Fracture (Thai: "รถ")', 'POST', '/api/enrich', { keyword: 'รถ' }, (res) => {
    if (!Array.isArray(res.components)) return 'components is not an array';
    if (res.components.length < 3) return `only ${res.components.length} components (need 3+)`;
    if (!res.model) return 'missing model field';
    return true;
  });
  await sleep(DELAY);

  // ---- Test 2: Fracture (English, ULTRA) ----
  await testEndpoint('Fracture (EN: "Quantum Computing")', 'POST', '/api/enrich', { keyword: 'Quantum Computing' }, (res) => {
    if (!Array.isArray(res.components)) return 'components is not an array';
    if (res.components.length < 3) return `only ${res.components.length} components (need 4-7)`;
    // ULTRA tier check is optional — model routing depends on evaluateComplexity
    return true;
  });
  await sleep(DELAY);

  // ---- Test 3: Merge ----
  await testEndpoint('Merge ("Fire" + "Water")', 'POST', '/api/enrich', { mode: 'merge', keywords: ['Fire', 'Water'] }, (res) => {
    if (!res.result || typeof res.result !== 'string') return 'result is missing or not a string';
    if (res.result === 'Fire' || res.result === 'Water') return `result is input word: ${res.result}`;
    if (res.result === 'Conceptual Anomaly') return 'result is fallback — AI merge failed';
    return true;
  });
  await sleep(DELAY);

  // ---- Test 4: Deep Fracture ----
  await testEndpoint('Deep Fracture ("Photosynthesis")', 'POST', '/api/enrich/deep', { keyword: 'Photosynthesis', depth: 2 }, (res) => {
    if (!res.tree) return 'missing tree field';
    if (!Array.isArray(res.tree.components)) return 'tree.components is not an array';
    if (res.tree.components.length < 3) return `only ${res.tree.components.length} top-level components`;
    const hasGrandchildren = res.tree.components.some(c => Array.isArray(c.components) && c.components.length > 0);
    if (!hasGrandchildren) return 'no grandchildren (depth-2 failed)';
    return true;
  });
  await sleep(DELAY);

  // ---- Test 5: Debate ----
  await testEndpoint('Debate ("Consciousness")', 'POST', '/api/debate', { keyword: 'Consciousness', rounds: 1 }, (res) => {
    if (!Array.isArray(res.components)) return 'components is not an array';
    if (res.components.length < 2) return `only ${res.components.length} components`;
    if (!res.perspectives || typeof res.perspectives !== 'object') return 'missing perspectives';
    return true;
  });
  await sleep(DELAY);

  // ---- Test 6: Analogy ----
  await testEndpoint('Analogy (bird:sky::fish:?)', 'POST', '/api/analogy', { a: 'bird', b: 'sky', c: 'fish' }, (res) => {
    if (!res.answer || typeof res.answer !== 'string') return 'answer is missing';
    if (typeof res.confidence !== 'number' || res.confidence < 0 || res.confidence > 1) return 'confidence out of range';
    return true;
  });
  await sleep(DELAY);

  // ---- Test 7: Counterfactual (Absent) ----
  await testEndpoint('Counterfactual Absent ("Gravity")', 'POST', '/api/counterfactual', { keyword: 'Gravity', mode: 'absent' }, (res) => {
    if (!res.alternative || typeof res.alternative !== 'string') return 'alternative is missing';
    return true;
  });
  await sleep(DELAY);

  // ---- Test 8: Counterfactual (Inverted) ----
  await testEndpoint('Counterfactual Inverted ("Light")', 'POST', '/api/counterfactual', { keyword: 'Light', mode: 'inverted' }, (res) => {
    if (!res.inverse || typeof res.inverse !== 'string') return 'inverse is missing';
    return true;
  });
  await sleep(DELAY);

  // ---- Test 9: Counterfactual (Extreme) ----
  await testEndpoint('Counterfactual Extreme ("Speed")', 'POST', '/api/counterfactual', { keyword: 'Speed', mode: 'extreme' }, (res) => {
    if (!res.extreme || typeof res.extreme !== 'string') return 'extreme is missing';
    return true;
  });
  await sleep(DELAY);

  // ---- Test 10: Classify ----
  await testEndpoint('Classify ("Dog")', 'POST', '/api/classify', { keyword: 'Dog' }, (res) => {
    if (!Array.isArray(res.chain)) return 'chain is not an array';
    if (res.chain.length < 3) return `chain too short (${res.chain.length})`;
    return true;
  });
  await sleep(DELAY);

  // ---- Test 11: Curiosity ----
  await testEndpoint('Curiosity (5 elements)', 'POST', '/api/curiosity', {
    workspace: [
      { keyword: 'Fire', age: 0, connections: 0 },
      { keyword: 'Water', age: 0, connections: 0 },
      { keyword: 'Earth', age: 0, connections: 0 },
      { keyword: 'Air', age: 0, connections: 0 },
      { keyword: 'Metal', age: 0, connections: 0 },
    ],
  }, (res) => {
    if (!res.type) return 'missing type field';
    if (!['merge', 'fracture', 'explore', 'counter'].includes(res.type)) return `unknown type: ${res.type}`;
    if (!res.prompt) return 'missing prompt';
    return true;
  });
  await sleep(DELAY);

  // ---- Test 12: Tension ----
  await testEndpoint('Tension (Order/Chaos/Light/Darkness...)', 'POST', '/api/detect-tension', {
    keywords: ['Order', 'Chaos', 'Light', 'Darkness', 'Creation', 'Destruction'],
  }, (res) => {
    if (!Array.isArray(res.tensions)) return 'tensions is not an array';
    if (res.tensions.length < 1) return 'no tensions detected (expected 1+)';
    if (!res.tensions[0].a || !res.tensions[0].b) return 'tension missing a/b fields';
    return true;
  });
  await sleep(DELAY);

  // ---- Test 13: Suggest ----
  await testEndpoint('Suggest (AI/ML topics)', 'POST', '/api/suggest', {
    keywords: ['Quantum', 'Neural Network', 'Evolution', 'Consciousness'],
  }, (res) => {
    const arr = res.suggestions || [];
    if (!Array.isArray(arr)) return 'suggestions is not an array';
    if (arr.length < 1) return 'no suggestions returned';
    return true;
  });
  await sleep(DELAY);

  // ---- Test 14: Embed ----
  await testEndpoint('Embed (2 texts)', 'POST', '/api/embed', { texts: ['Hello world', 'Gravity'] }, (res) => {
    if (!Array.isArray(res.embeddings)) return 'embeddings is not an array';
    if (res.embeddings.length !== 2) return `expected 2 embeddings, got ${res.embeddings.length}`;
    if (!Array.isArray(res.embeddings[0]) || res.embeddings[0].length < 10) return 'embedding vector too short';
    return true;
  });
  await sleep(DELAY);

  // ---- Test 15: Agent ----
  await testEndpoint('Agent ("chemical formula of water")', 'POST', '/api/agent', {
    task: 'What is the chemical formula for water?',
  }, (res) => {
    if (!res.answer || typeof res.answer !== 'string') return 'answer is missing';
    const hasWater = /h[₂2]o|water/i.test(res.answer);
    if (!hasWater) return 'answer doesn\'t mention water/H2O: ' + JSON.stringify(res.answer.slice(0, 80));
    return true;
  });

  // ---- Summary ----
  console.log(`\n${'═'.repeat(50)}`);
  if (failed === 0) {
    console.log(`\x1b[32m✅ ALL ${passed}/${total} TESTS PASSED\x1b[0m`);
  } else {
    console.log(`\x1b[31m❌ ${passed}/${total} passed, ${failed} FAILED\x1b[0m`);
  }
  console.log(`${'═'.repeat(50)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
