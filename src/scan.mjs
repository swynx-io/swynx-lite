// src/scan.mjs
// Scan orchestrator — wraps the shared scanner for Lite

import { resolve } from 'path';
import { existsSync } from 'fs';
import { loadConfig } from './config.mjs';
import { scanDeadCode } from './shared/scanner/scan-dead-code.mjs';
import { ProgressSpinner } from './output/progress.mjs';
import { renderScanOutput } from './output/console.mjs';
import { formatJSON } from './output/json.mjs';

/**
 * Run a dead code scan
 *
 * @param {string} targetPath - Path to scan
 * @param {object} cliOptions - CLI options
 * @returns {Promise<{ exitCode: number, results: object }>}
 */
export async function runScan(targetPath, cliOptions = {}) {
  const projectPath = resolve(targetPath || '.');

  if (!existsSync(projectPath)) {
    console.error(`  Error: path not found — ${projectPath}`);
    return { exitCode: 2, results: null };
  }

  // Load config
  const config = loadConfig(projectPath, cliOptions);

  // Detect CI
  const isCI = cliOptions.ci || !!process.env.CI || !!process.env.GITHUB_ACTIONS || !!process.env.GITLAB_CI;
  const isJSON = cliOptions.json || false;
  const noColor = cliOptions.color === false || !!process.env.NO_COLOR || isCI;
  const verbose = cliOptions.verbose || false;

  // Progress spinner (only in interactive mode)
  const spinner = new ProgressSpinner({
    enabled: !isJSON && !isCI,
    noColor,
  });

  spinner.start('Discovering files...');

  // Build exclude patterns from config
  const exclude = config.ignore.length > 0 ? undefined : undefined;

  let results;
  try {
    results = await scanDeadCode(projectPath, {
      exclude: undefined, // use scanner defaults + config ignore is separate
      onProgress: (p) => spinner.update(p),
    });
  } catch (e) {
    spinner.stop();
    console.error(`  Error during scan: ${e.message}`);
    if (verbose) console.error(e.stack);
    return { exitCode: 2, results: null };
  }

  spinner.stop();

  // Filter out ignored files from results
  if (config.ignore.length > 0) {
    const { minimatch } = await loadMinimatch();
    if (minimatch) {
      const ignoreFilter = f => {
        const filePath = f.file || f.path || '';
        return !config.ignore.some(pattern => minimatch(filePath, pattern, { dot: true }));
      };
      results.deadFiles = results.deadFiles.filter(ignoreFilter);
      if (results.partialFiles) {
        results.partialFiles = results.partialFiles.filter(ignoreFilter);
      }
      // Recalculate summary
      const deadCount = results.deadFiles.length;
      const totalDeadBytes = results.deadFiles.reduce((sum, f) => sum + (f.size || 0), 0);
      const deadRate = results.summary.totalFiles > 0
        ? ((deadCount / results.summary.totalFiles) * 100).toFixed(2)
        : '0.00';
      results.summary.deadFiles = deadCount;
      results.summary.partialFiles = (results.partialFiles || []).length;
      results.summary.totalDeadBytes = totalDeadBytes;
      results.summary.deadRate = `${deadRate}%`;
    }
  }

  // Security scanning
  let security = null;
  if (config.security.enabled && cliOptions.security !== false) {
    try {
      const { runSecurityScan } = await import('./security.mjs');
      security = await runSecurityScan(projectPath, results, { onProgress: (p) => spinner.update(p) });
    } catch {
      // Security module may not be available — skip silently
    }
  }

  // Output
  if (isJSON) {
    console.log(formatJSON(results, { projectPath, security }));
  } else {
    console.log(renderScanOutput(results, { noColor, verbose, ci: isCI, security }));
  }

  // Exit code logic
  let exitCode = 0;
  if (isCI) {
    const threshold = parseFloat(cliOptions.threshold ?? config.ci.threshold ?? 0);
    const deadRate = parseFloat(results.summary.deadRate);

    if (deadRate > threshold) {
      exitCode = 1;
    }

    // Security failures in CI
    if (config.ci.failOnSecurity && security && security.summary) {
      const minSev = config.ci.securitySeverity || 'HIGH';
      const sevRank = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
      const minRank = sevRank[minSev] || 3;

      const hasFailure = (security.findings || []).some(f =>
        (sevRank[f.severity] || 0) >= minRank
      );
      if (hasFailure) exitCode = 1;
    }
  }

  return { exitCode, results, security };
}

/**
 * Try to load minimatch for ignore pattern matching
 */
async function loadMinimatch() {
  try {
    const { minimatch } = await import('minimatch');
    return { minimatch };
  } catch {
    // minimatch not available — glob patterns in ignore won't work
    // (it's a transitive dep from glob, so usually available)
    try {
      // Try the glob module's internal minimatch
      const mod = await import('glob');
      if (mod.minimatch) return { minimatch: mod.minimatch };
    } catch { /* */ }
    return { minimatch: null };
  }
}
