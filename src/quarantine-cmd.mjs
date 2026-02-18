// src/quarantine-cmd.mjs
// Quarantine orchestrator — scan, move dead files to .swynx-quarantine/, done.
// No import/barrel cleanup — just the safe move-and-test flow.

import { resolve, join } from 'path';
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'fs';
import { loadConfig } from './config.mjs';
import { scanDeadCode } from './shared/scanner/scan-dead-code.mjs';
import { createSession, quarantineFile } from './shared/fixer/quarantine.mjs';
import { ProgressSpinner } from './output/progress.mjs';
import { renderQuarantineOutput } from './output/console.mjs';
import { formatCleanJSON } from './output/json.mjs';

/**
 * Run the quarantine command
 */
export async function runQuarantine(targetPath, cliOptions = {}) {
  const projectPath = resolve(targetPath || '.');

  if (!existsSync(projectPath)) {
    console.error(`  Error: path not found — ${projectPath}`);
    return { exitCode: 2 };
  }

  const config = loadConfig(projectPath, cliOptions);
  const isJSON = cliOptions.json || false;
  const noColor = cliOptions.color === false || !!process.env.NO_COLOR;
  const dryRun = cliOptions.dryRun || false;
  const autoYes = cliOptions.yes || false;

  const spinner = new ProgressSpinner({
    enabled: !isJSON,
    noColor,
  });

  // Step 1: Scan
  spinner.start('Scanning for dead code...');

  let scanResults;
  try {
    scanResults = await scanDeadCode(projectPath, {
      onProgress: (p) => spinner.update(p),
    });
  } catch (e) {
    spinner.stop();
    console.error(`  Error during scan: ${e.message}`);
    return { exitCode: 2 };
  }

  spinner.stop();

  // Apply ignore filters
  if (config.ignore.length > 0) {
    let minimatch;
    try {
      const mod = await import('minimatch');
      minimatch = mod.minimatch || mod.default;
    } catch {
      try {
        const g = await import('glob');
        minimatch = g.minimatch;
      } catch { /* skip */ }
    }

    if (minimatch) {
      const ignoreFilter = f => {
        const filePath = f.file || f.path || '';
        return !config.ignore.some(pattern => minimatch(filePath, pattern, { dot: true }));
      };
      scanResults.deadFiles = scanResults.deadFiles.filter(ignoreFilter);
      if (scanResults.partialFiles) {
        scanResults.partialFiles = scanResults.partialFiles.filter(ignoreFilter);
      }
      const deadCount = scanResults.deadFiles.length;
      const totalDeadBytes = scanResults.deadFiles.reduce((sum, f) => sum + (f.size || 0), 0);
      const deadRate = scanResults.summary.totalFiles > 0
        ? ((deadCount / scanResults.summary.totalFiles) * 100).toFixed(2)
        : '0.00';
      scanResults.summary.deadFiles = deadCount;
      scanResults.summary.partialFiles = (scanResults.partialFiles || []).length;
      scanResults.summary.totalDeadBytes = totalDeadBytes;
      scanResults.summary.deadRate = `${deadRate}%`;
    }
  }

  const deadFiles = scanResults.deadFiles || [];
  if (deadFiles.length === 0) {
    if (isJSON) {
      console.log(formatCleanJSON({ dryRun, filesRemoved: 0, bytesRemoved: 0, files: [] }));
    } else {
      console.log('\n  No dead code found. Your codebase is clean!\n');
    }
    return { exitCode: 0 };
  }

  const totalBytes = deadFiles.reduce((sum, f) => sum + (f.size || 0), 0);

  // Step 2: Confirmation
  if (!dryRun && !autoYes && !isJSON) {
    console.log('');
    console.log(`  ${deadFiles.length} dead file${deadFiles.length === 1 ? '' : 's'} found (${formatBytes(totalBytes)})`);
    console.log('');

    const showCount = Math.min(5, deadFiles.length);
    for (let i = 0; i < showCount; i++) {
      const f = deadFiles[i];
      console.log(`   ${(f.file || '').padEnd(42)} ${formatBytes(f.size).padStart(10)}`);
    }
    if (deadFiles.length > 5) {
      console.log(`   ... and ${deadFiles.length - 5} more`);
    }
    console.log('');
    console.log(`  Files will be moved to .swynx-quarantine/ (reversible)`);
    console.log('');

    const ok = await confirm(`  Quarantine ${deadFiles.length} file${deadFiles.length === 1 ? '' : 's'}? (y/N) `);
    if (!ok) {
      console.log('  Cancelled.\n');
      return { exitCode: 0 };
    }
  }

  // Step 3: Quarantine
  const quarantinedFiles = [];
  let sessionId = null;
  let bytesRemoved = 0;

  if (!dryRun) {
    const session = createSession(projectPath, 'quarantine');
    sessionId = session.sessionId;

    spinner.start('Quarantining files...');
    for (const f of deadFiles) {
      const filePath = f.file || f.path || '';
      const fullPath = join(projectPath, filePath);
      try {
        quarantineFile(projectPath, sessionId, fullPath);
        quarantinedFiles.push(filePath);
        bytesRemoved += f.size || 0;
      } catch {
        // Skip files that can't be quarantined
      }
    }
    spinner.stop();

    // Auto-add .swynx-quarantine/ to .gitignore
    ensureGitignore(projectPath);
  }

  const result = {
    dryRun,
    filesQuarantined: dryRun ? deadFiles.length : quarantinedFiles.length,
    bytesRemoved: dryRun ? totalBytes : bytesRemoved,
    sessionId,
    files: deadFiles.map(f => ({ file: f.file, size: f.size })),
  };

  if (isJSON) {
    console.log(formatCleanJSON({ ...result, filesRemoved: result.filesQuarantined }));
  } else {
    console.log(renderQuarantineOutput(result, { noColor }));
  }

  return { exitCode: 0, result };
}

/**
 * Add .swynx-quarantine/ to .gitignore if not already there
 */
function ensureGitignore(projectPath) {
  const gitignorePath = join(projectPath, '.gitignore');
  const entry = '.swynx-quarantine/';

  try {
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, 'utf-8');
      if (content.includes(entry)) return;
      appendFileSync(gitignorePath, `\n# Swynx quarantine\n${entry}\n`);
    } else {
      writeFileSync(gitignorePath, `# Swynx quarantine\n${entry}\n`);
    }
  } catch { /* best effort */ }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function confirm(message) {
  return new Promise((resolve) => {
    process.stdout.write(message);
    process.stdin.setEncoding('utf-8');
    process.stdin.resume();
    process.stdin.once('data', (data) => {
      process.stdin.pause();
      resolve(data.trim().toLowerCase() === 'y');
    });
  });
}
