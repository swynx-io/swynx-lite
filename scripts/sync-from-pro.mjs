#!/usr/bin/env node
// scripts/sync-from-pro.mjs
// Copies shared modules from Swynx Pro into src/shared/

import { cpSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LITE_ROOT = join(__dirname, '..');
const PRO_ROOT = '/var/www/swynx';
const SHARED = join(LITE_ROOT, 'src', 'shared');

// Clean previous shared copy
if (existsSync(SHARED)) {
  rmSync(SHARED, { recursive: true, force: true });
}
mkdirSync(SHARED, { recursive: true });

// ── Scanner modules ──────────────────────────────────────────────────────────

const scannerDest = join(SHARED, 'scanner');
mkdirSync(join(scannerDest, 'parsers'), { recursive: true });
mkdirSync(join(scannerDest, 'analysers'), { recursive: true });

// Core scanner files
const scannerFiles = [
  'scan-dead-code.mjs',
  'discovery.mjs',
  'parse-worker.mjs',
];

for (const f of scannerFiles) {
  cpSync(join(PRO_ROOT, 'src', 'scanner', f), join(scannerDest, f));
}

// All parsers
cpSync(join(PRO_ROOT, 'src', 'scanner', 'parsers'), join(scannerDest, 'parsers'), { recursive: true });

// Selected analysers (dead code detection only — no decay, deps, bundles, etc.)
const analysers = [
  'deadcode.mjs',
  'imports.mjs',
  'buildSystems.mjs',
  'generatedCode.mjs',
  'configParsers.mjs',
  'entryPointDetector.mjs',
];

for (const f of analysers) {
  const src = join(PRO_ROOT, 'src', 'scanner', 'analysers', f);
  if (existsSync(src)) {
    cpSync(src, join(scannerDest, 'analysers', f));
  }
}

// ── Fixer modules ────────────────────────────────────────────────────────────

const fixerDest = join(SHARED, 'fixer');
mkdirSync(fixerDest, { recursive: true });

const fixerFiles = [
  'quarantine.mjs',
  'import-cleaner.mjs',
  'barrel-cleaner.mjs',
];

for (const f of fixerFiles) {
  const src = join(PRO_ROOT, 'src', 'fixer', f);
  if (existsSync(src)) {
    cpSync(src, join(fixerDest, f));
  }
}

// ── Security modules ─────────────────────────────────────────────────────────

const securityDest = join(SHARED, 'security');
mkdirSync(securityDest, { recursive: true });

const securityFiles = [
  'scanner.mjs',
  'patterns.mjs',
  'proximity.mjs',
];

for (const f of securityFiles) {
  const src = join(PRO_ROOT, 'src', 'security', f);
  if (existsSync(src)) {
    cpSync(src, join(securityDest, f));
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log('  sync-from-pro complete');
console.log('  scanner  → src/shared/scanner/');
console.log('  fixer    → src/shared/fixer/');
console.log('  security → src/shared/security/');
