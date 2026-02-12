// src/scanner/scan-dead-code.mjs
// Standalone dead code scanning function — the unified entry point for dead code analysis.
// Replaces both scanner-legacy/index.mjs and the inline scanDeadCodeOnly() in scan-repo-worker.mjs.

import { availableParallelism } from 'os';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { discoverFiles, categoriseFiles } from './discovery.mjs';
import { parseJavaScript } from './parsers/javascript.mjs';
import { parseFile } from './parsers/registry.mjs';
import { analyseImports } from './analysers/imports.mjs';
import { findDeadCode } from './analysers/deadcode.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKER_PATH = join(__dirname, 'parse-worker.mjs');
const DEFAULT_WORKER_COUNT = parseInt(process.env.SWYNX_WORKERS || '0') || Math.min(availableParallelism(), 8);

const CHUNK_THRESHOLD = 10000;  // B3: chunk parsing when file count exceeds this
const CHUNK_SIZE = 5000;        // B3: files per parse chunk

function parallelParse(files, parserType) {
  const maxWorkers = DEFAULT_WORKER_COUNT;
  const workerCount = Math.min(maxWorkers, Math.ceil(files.length / 50));
  if (workerCount <= 1 || files.length < 100) return null;

  return new Promise((resolve) => {
    const chunkSize = Math.ceil(files.length / workerCount);
    let completed = 0;
    const allResults = [];
    let activeWorkers = 0;

    for (let i = 0; i < workerCount; i++) {
      const chunk = files.slice(i * chunkSize, (i + 1) * chunkSize);
      if (chunk.length === 0) continue;
      activeWorkers++;

      const worker = new Worker(WORKER_PATH, {
        workerData: { files: chunk, parserType }
      });

      worker.on('message', (msg) => {
        if (msg.type === 'batch') {
          // B1: Handle batch messages from worker (intermediate results)
          allResults.push(...msg.results);
        } else if (msg.type === 'done') {
          allResults.push(...msg.results);
          completed++;
          if (completed === activeWorkers) resolve(allResults);
        } else if (msg.type === 'error') {
          completed++;
          if (completed === activeWorkers) resolve(allResults);
        }
      });

      worker.on('error', () => {
        completed++;
        if (completed === activeWorkers) resolve(allResults);
      });
    }
  });
}

/**
 * B3: Chunked parse pipeline — processes files in chunks to cap peak memory.
 * Each chunk goes through parallelParse, results accumulated (without content),
 * then next chunk starts. Previous chunk's worker memory is freed.
 */
async function chunkedParse(files, parserType, onProgress) {
  const allResults = [];
  const totalChunks = Math.ceil(files.length / CHUNK_SIZE);

  for (let c = 0; c < totalChunks; c++) {
    const start = c * CHUNK_SIZE;
    const chunk = files.slice(start, start + CHUNK_SIZE);
    onProgress({ phase: 'parse', message: `Parsing chunk ${c + 1}/${totalChunks} (${chunk.length} files)...` });

    const chunkResults = parallelParse(chunk, parserType);
    if (chunkResults) {
      allResults.push(...await chunkResults);
    } else {
      // Fallback to sequential for small chunks
      const parseFn = parserType === 'javascript' ? parseJavaScript : parseFile;
      for (const file of chunk) {
        try {
          const result = await parseFn(file);
          if (result) {
            // Strip content like workers do (B2)
            result.content = null;
            allResults.push(result);
          }
        } catch { /* skip */ }
      }
    }
  }
  return allResults;
}

/**
 * Detect language from file extension (for legacy-compatible summary)
 */
function detectLanguage(filePath) {
  if (/\.[mc]?[jt]sx?$/.test(filePath)) return 'javascript';
  if (/\.py$/.test(filePath)) return 'python';
  if (/\.go$/.test(filePath)) return 'go';
  if (/\.(java|kt)$/.test(filePath)) return 'java';
  if (/\.php$/.test(filePath)) return 'php';
  if (/\.rb$/.test(filePath)) return 'ruby';
  if (/\.rs$/.test(filePath)) return 'rust';
  if (/\.cs$/.test(filePath)) return 'csharp';
  if (/\.dart$/.test(filePath)) return 'dart';
  if (/\.swift$/.test(filePath)) return 'swift';
  if (/\.scala$/.test(filePath)) return 'scala';
  if (/\.ex$|\.exs$/.test(filePath)) return 'elixir';
  return 'other';
}

const DEFAULT_EXCLUDE = [
  '**/node_modules/**', '**/bower_components/**', '**/.git/**', '**/dist/**', '**/build/**',
  '**/.swynx-quarantine/**', '**/coverage/**', '**/*.min.js', '**/*.min.css',
  '**/logs/**', '**/log/**', '**/*.log',
  '**/tmp/**', '**/temp/**', '**/.cache/**', '**/cache/**',
  '**/__pycache__/**', '**/*.pyc', '**/*.pyo',
  '**/.pytest_cache/**', '**/.mypy_cache/**',
  '**/*.sql', '**/*.sqlite', '**/*.sqlite3', '**/*.db',
  '**/tests/baselines/**', '**/test/baselines/**',
  '**/__snapshots__/**', '**/snapshots/**',
  '**/test-fixtures/**', '**/test_fixtures/**', '**/__fixtures__/**',
  '**/fixtures/**', '**/fixture/**',
  '**/testdata/**', '**/test-data/**',
  '**/vendor/**',
  '**/__mockdata__/**', '**/__mock__/**', '**/__for-testing__/**',
  '**/pkg-tests-fixtures/**', '**/pkg-tests-specs/**',
  '**/type-tests/**', '**/type-test/**',
  // Test fixture / baseline directories (huge in compiler repos)
  '**/TestData/**', '**/testData/**',
  '**/test-cases/**', '**/test_cases/**',
  '**/conformance/**',
  '**/testcases/**',
  // Compiler test input directories
  '**/cases/**/*.ts',
  '**/test/cases/**',
  // IDE/editor test fixtures
  '**/test-fixture/**',
  // C# intermediate / compiled output
  '**/obj/**',
  '**/bin/Debug/**', '**/bin/Release/**',
  // C# scaffolding baselines (test-generated output)
  '**/Scaffolding/Baselines/**',
  // Rust compiler test inputs (standalone files compiled by test harness, not source code)
  '**/tests/ui/**', '**/tests/derive_ui/**', '**/tests/compile-fail/**',
  '**/tests/run-pass/**', '**/tests/run-fail/**', '**/tests/ui-fulldeps/**',
  '**/tests/pretty/**', '**/tests/mir-opt/**', '**/tests/assembly/**',
  '**/tests/codegen/**', '**/tests/debuginfo/**', '**/tests/incremental/**',
  '**/tests/codegen-llvm/**', '**/tests/rustdoc-html/**', '**/tests/crashes/**',
  '**/tests/assembly-llvm/**', '**/tests/rustdoc-ui/**', '**/tests/rustdoc-js/**',
  '**/tests/rustdoc-json/**', '**/tests/codegen-units/**', '**/tests/coverage-run-rustdoc/**',
  // Cypress/E2E system test fixture projects (standalone apps used as test targets)
  '**/system-tests/projects/**', '**/system-tests/project-fixtures/**',
  // RustPython test snippet inputs
  '**/extra_tests/snippets/**',
  // Python stdlib copies (RustPython, cpython)
  '**/Lib/encodings/**',
  // Python vendored third-party code
  '**/_vendor/**', '**/_distutils/**',
  // Compiled/bundled static assets (Phoenix/Elixir)
  '**/static/assets/**',
  // Generated protobuf/gRPC output directories
  '**/gen/proto/**',
];

/**
 * Standalone dead code scan.
 *
 * @param {string} projectPath - Absolute path to the project root
 * @param {Object} [options]
 * @param {string[]} [options.exclude] - Glob patterns to exclude
 * @param {number}  [options.workers] - Max parallel parse workers
 * @param {Function} [options.onProgress] - Progress callback ({ phase, message })
 * @returns {Promise<Object>} Result with both legacy-compatible and full-scanner fields
 */
export async function scanDeadCode(projectPath, options = {}) {
  const { exclude = DEFAULT_EXCLUDE, onProgress = () => {} } = options;
  const t0 = Date.now();

  // Phase 1: Discover files
  onProgress({ phase: 'discovery', message: 'Discovering files...' });
  const files = await discoverFiles(projectPath, { exclude });
  const categorised = categoriseFiles(files);
  const totalFiles = files.length;
  onProgress({ phase: 'discovery', message: `${totalFiles} files discovered` });

  // Phase 2: Parse JS/TS — use chunked pipeline for large repos
  onProgress({ phase: 'parse', message: `Parsing ${categorised.javascript.length} JS/TS files...` });
  const jsFiles = categorised.javascript;
  let jsAnalysis;
  if (jsFiles.length > CHUNK_THRESHOLD) {
    // B3: Chunked parse for truly massive repos
    jsAnalysis = await chunkedParse(jsFiles, 'javascript', onProgress);
  } else {
    const jsParallel = parallelParse(jsFiles, 'javascript');
    if (jsParallel) {
      jsAnalysis = await jsParallel;
    } else {
      jsAnalysis = [];
      for (const file of jsFiles) {
        jsAnalysis.push(await parseJavaScript(file));
      }
    }
  }
  onProgress({ phase: 'parse', message: `Parsed ${jsAnalysis.length} JS/TS files` });

  // Phase 3: Parse other languages
  const otherLangFiles = [
    ...categorised.python || [],
    ...categorised.java || [],
    ...categorised.kotlin || [],
    ...categorised.csharp || [],
    ...categorised.go || [],
    ...categorised.rust || []
  ];
  const otherLangAnalysis = [];
  if (otherLangFiles.length > 0) {
    onProgress({ phase: 'parse', message: `Parsing ${otherLangFiles.length} other-language files...` });
    if (otherLangFiles.length > CHUNK_THRESHOLD) {
      // B3: Chunked parse for large non-JS repos
      otherLangAnalysis.push(...await chunkedParse(otherLangFiles, 'other', onProgress));
    } else {
      const otherParallel = parallelParse(otherLangFiles, 'other');
      if (otherParallel) {
        otherLangAnalysis.push(...await otherParallel);
      } else {
        for (const file of otherLangFiles) {
          try {
            const parsed = await parseFile(file);
            if (parsed) otherLangAnalysis.push(parsed);
          } catch { /* skip */ }
        }
      }
    }
    onProgress({ phase: 'parse', message: `Parsed ${otherLangAnalysis.length} other-language files` });
  }

  // Phase 4: Build import graph
  onProgress({ phase: 'graph', message: 'Building import graph...' });
  const importGraph = await analyseImports(jsAnalysis);

  // Phase 5: Find dead code
  onProgress({ phase: 'detection', message: 'Detecting dead code...' });
  let packageJson = {};
  try {
    packageJson = JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf-8'));
  } catch { /* no package.json */ }

  const allCodeAnalysis = [...jsAnalysis, ...otherLangAnalysis];
  const deadCode = await findDeadCode(allCodeAnalysis, importGraph, projectPath, packageJson, {});

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  onProgress({ phase: 'done', message: `Done in ${elapsed}s` });

  // Build deadFiles array — ONLY fully dead files (safe to delete)
  const deadFiles = (deadCode.fullyDeadFiles || []).map(f => ({
    file: f.file,
    size: f.sizeBytes || f.size || 0,
    lines: f.lineCount || f.lines || 0,
    language: f.language || detectLanguage(f.file),
    exports: (f.exports || []).map(e => typeof e === 'string' ? { name: e, type: 'unknown' } : e),
    partial: false,
  }));

  // Build partiallyDeadFiles array — files with some unused exports (NOT safe to delete)
  const partialFiles = (deadCode.partiallyDeadFiles || []).map(f => ({
    file: f.file,
    size: f.sizeBytes || f.size || 0,
    lines: f.lineCount || f.lines || 0,
    language: f.language || detectLanguage(f.file),
    exports: (f.exports || []).map(e => typeof e === 'string' ? { name: e, type: 'unknown' } : e),
    deadExports: f.deadExports || [],
    partial: true,
  }));

  // Sort by size descending
  deadFiles.sort((a, b) => b.size - a.size);
  partialFiles.sort((a, b) => b.size - a.size);

  // Build language counts from all discovered files
  const languages = {};
  for (const file of files) {
    const rel = typeof file === 'string' ? file : file.relativePath || file;
    const lang = detectLanguage(rel);
    if (lang !== 'other') {
      languages[lang] = (languages[lang] || 0) + 1;
    }
  }

  const deadCount = deadFiles.length;
  const deadRate = totalFiles > 0 ? ((deadCount / totalFiles) * 100).toFixed(2) : '0.00';
  const totalDeadBytes = deadFiles.reduce((sum, f) => sum + f.size, 0);

  return {
    // Dead files (fully dead — safe to delete)
    deadFiles,
    // Partially dead files (have unused exports — NOT safe to delete)
    partialFiles,
    entryPoints: deadCode.entryPoints || [],
    summary: {
      totalFiles,
      entryPoints: (deadCode.entryPoints || []).length,
      reachableFiles: totalFiles - deadCount - (deadCode.entryPoints || []).length,
      deadFiles: deadCount,
      partialFiles: partialFiles.length,
      deadRate: `${deadRate}%`,
      totalDeadBytes,
      languages
    },

    // Full scanner fields (richer detail)
    fullyDeadFiles: deadCode.fullyDeadFiles || [],
    partiallyDeadFiles: deadCode.partiallyDeadFiles || [],
    skippedDynamic: deadCode.skippedDynamic || [],
    excludedGenerated: deadCode.excludedGenerated || [],

    // Metadata
    elapsed,
    totalFiles
  };
}
