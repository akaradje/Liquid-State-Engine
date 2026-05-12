#!/usr/bin/env node
/**
 * Liquid-State Engine — Dev Server
 *
 * Serves the web/ directory with COOP/COEP headers required for
 * SharedArrayBuffer support in Web Workers.
 *
 * Required headers:
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 *
 * Usage:
 *   node scripts/serve.js [port]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.argv[2] || 8080;
const ROOT = path.resolve(__dirname, '..', 'web');
const PKG = path.resolve(__dirname, '..', 'pkg');

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
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let urlPath = url.pathname;

  // Default to index.html
  if (urlPath === '/' || urlPath === '') {
    urlPath = '/index.html';
  }

  // Remove leading slash
  const relPath = urlPath.replace(/^\/+/, '');

  // First try web/ directory, then pkg/ (for wasm module)
  let filePath = path.join(ROOT, relPath);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(PKG, relPath.replace(/^web\//, ''));
  }
  // Also try parent pkg/ for ../pkg/ imports
  if (!fs.existsSync(filePath) && relPath.startsWith('pkg/')) {
    filePath = path.resolve(__dirname, '..', relPath);
  }

  serveFile(res, filePath);
});

server.listen(PORT, () => {
  console.log(`Liquid-State Engine dev server running at http://localhost:${PORT}/`);
  console.log(`  COOP: same-origin`);
  console.log(`  COEP: require-corp`);
  console.log(`  Root: ${ROOT}`);
  console.log(`  SharedArrayBuffer: ENABLED`);
});
