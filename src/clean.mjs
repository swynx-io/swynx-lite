// src/clean.mjs
// Clean orchestrator — scan, quarantine, delete, clean imports

import { resolve, join, relative, extname } from 'path';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { glob } from 'glob';
import { loadConfig } from './config.mjs';
import { scanDeadCode } from './shared/scanner/scan-dead-code.mjs';
import { createSession, quarantineFile } from './shared/fixer/quarantine.mjs';
import { cleanDeadImports } from './shared/fixer/import-cleaner.mjs';
import { cleanBarrelExports } from './shared/fixer/barrel-cleaner.mjs';
import { ProgressSpinner } from './output/progress.mjs';
import { renderCleanOutput } from './output/console.mjs';
import { formatCleanJSON } from './output/json.mjs';

/**
 * Run the clean command
 */
export async function runClean(targetPath, cliOptions = {}) {
  const projectPath = resolve(targetPath || '.');

  if (!existsSync(projectPath)) {
    console.error(`  Error: path not found — ${projectPath}`);
    return { exitCode: 2 };
  }

  const config = loadConfig(projectPath, cliOptions);
  const isJSON = cliOptions.json || false;
  const noColor = cliOptions.color === false || !!process.env.NO_COLOR;
  const dryRun = cliOptions.dryRun || false;
  const skipQuarantine = cliOptions.quarantine === false;
  const skipImportClean = cliOptions.importClean === false || !config.clean.importClean;
  const skipBarrelClean = cliOptions.barrelClean === false || !config.clean.barrelClean;
  const autoYes = cliOptions.yes || false;

  // Spinner
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

  const deadFiles = scanResults.deadFiles || [];
  if (deadFiles.length === 0) {
    if (isJSON) {
      console.log(formatCleanJSON({ dryRun, filesRemoved: 0, bytesRemoved: 0, importsRemoved: 0, barrelExportsRemoved: 0, files: [] }));
    } else {
      console.log('\n  No dead code found. Your codebase is clean!\n');
    }
    return { exitCode: 0 };
  }

  const totalBytes = deadFiles.reduce((sum, f) => sum + (f.size || 0), 0);

  // Step 2: Confirmation (unless --yes or --dry-run)
  if (!dryRun && !autoYes && !isJSON) {
    console.log('');
    console.log(`  ${deadFiles.length} dead file${deadFiles.length === 1 ? '' : 's'} found (${formatBytes(totalBytes)})`);
    console.log('');

    // Show top files
    const showCount = Math.min(5, deadFiles.length);
    for (let i = 0; i < showCount; i++) {
      const f = deadFiles[i];
      console.log(`   ${(f.file || '').padEnd(42)} ${formatBytes(f.size).padStart(10)}`);
    }
    if (deadFiles.length > 5) {
      console.log(`   ... and ${deadFiles.length - 5} more`);
    }
    console.log('');

    const ok = await confirm(`  Remove ${deadFiles.length} file${deadFiles.length === 1 ? '' : 's'}? (y/N) `);
    if (!ok) {
      console.log('  Cancelled.\n');
      return { exitCode: 0 };
    }
  }

  // Step 3: Quarantine + delete
  const deletedFiles = [];
  let sessionId = null;
  let bytesRemoved = 0;

  if (!dryRun) {
    if (!skipQuarantine) {
      const session = createSession(projectPath, 'clean');
      sessionId = session.sessionId;

      spinner.start('Quarantining files...');
      for (const f of deadFiles) {
        const filePath = f.file || f.path || '';
        const fullPath = join(projectPath, filePath);
        try {
          quarantineFile(projectPath, sessionId, fullPath);
          deletedFiles.push(filePath);
          bytesRemoved += f.size || 0;
        } catch {
          // Skip files that can't be quarantined
        }
      }
      spinner.stop();
    } else {
      // Direct delete (no quarantine)
      const { unlinkSync } = await import('fs');
      spinner.start('Removing files...');
      for (const f of deadFiles) {
        const filePath = f.file || f.path || '';
        const fullPath = join(projectPath, filePath);
        try {
          if (existsSync(fullPath)) {
            unlinkSync(fullPath);
            deletedFiles.push(filePath);
            bytesRemoved += f.size || 0;
          }
        } catch { /* skip */ }
      }
      spinner.stop();
    }

    // Step 4: Clean dead imports from live files
    let importsRemoved = 0;
    let barrelExportsRemoved = 0;

    if (deletedFiles.length > 0) {
      // Find live JS/TS files
      const livePatterns = join(projectPath, '**/*.{js,jsx,ts,tsx,mjs,cjs}');
      const liveFiles = await glob(livePatterns, {
        ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.swynx-quarantine/**'],
        nodir: true,
      });

      const relativeLiveFiles = liveFiles
        .map(f => relative(projectPath, f))
        .filter(f => !deletedFiles.includes(f));

      if (!skipImportClean) {
        spinner.start('Cleaning dead imports...');
        try {
          const importResult = await cleanDeadImports(projectPath, deletedFiles, relativeLiveFiles);
          importsRemoved = importResult.importsRemoved?.length || 0;
        } catch { /* skip */ }
        spinner.stop();
      }

      if (!skipBarrelClean) {
        spinner.start('Cleaning barrel exports...');
        try {
          const barrelResult = await cleanBarrelExports(projectPath, deletedFiles, relativeLiveFiles);
          barrelExportsRemoved = barrelResult.exportsRemoved?.length || 0;
        } catch { /* skip */ }
        spinner.stop();
      }
    }

    // Step 5: Auto-add .swynx-quarantine/ to .gitignore
    if (sessionId) {
      ensureGitignore(projectPath);
    }

    // Output
    const result = {
      dryRun: false,
      filesRemoved: deletedFiles.length,
      bytesRemoved,
      importsRemoved,
      barrelExportsRemoved,
      sessionId,
      deadCount: deadFiles.length,
      files: deadFiles.map(f => ({ file: f.file, size: f.size })),
    };

    if (isJSON) {
      console.log(formatCleanJSON(result));
    } else {
      console.log(renderCleanOutput(result, { noColor }));
    }

    return { exitCode: 0, result };
  }

  // Dry run output
  let importsWouldRemove = 0;
  let barrelsWouldRemove = 0;

  // Estimate import/barrel cleanups
  const deletedRelPaths = deadFiles.map(f => f.file || f.path || '');
  const livePatterns = join(projectPath, '**/*.{js,jsx,ts,tsx,mjs,cjs}');
  const liveFiles = await glob(livePatterns, {
    ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.swynx-quarantine/**'],
    nodir: true,
  });
  const relativeLiveFiles = liveFiles
    .map(f => relative(projectPath, f))
    .filter(f => !deletedRelPaths.includes(f));

  if (!skipImportClean) {
    try {
      const importResult = await cleanDeadImports(projectPath, deletedRelPaths, relativeLiveFiles, { dryRun: true });
      importsWouldRemove = importResult.importsRemoved?.length || 0;
    } catch { /* skip */ }
  }

  if (!skipBarrelClean) {
    try {
      const barrelResult = await cleanBarrelExports(projectPath, deletedRelPaths, relativeLiveFiles, { dryRun: true });
      barrelsWouldRemove = barrelResult.exportsRemoved?.length || 0;
    } catch { /* skip */ }
  }

  const dryResult = {
    dryRun: true,
    filesRemoved: deadFiles.length,
    bytesRemoved: totalBytes,
    importsRemoved: importsWouldRemove,
    barrelExportsRemoved: barrelsWouldRemove,
    files: deadFiles.map(f => ({ file: f.file, size: f.size })),
  };

  if (isJSON) {
    console.log(formatCleanJSON(dryResult));
  } else {
    console.log(renderCleanOutput(dryResult, { noColor, dryRun: true }));
  }

  return { exitCode: 0 };
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
      appendFileSync(gitignorePath, `\n# Swynx Lite quarantine\n${entry}\n`);
    } else {
      writeFileSync(gitignorePath, `# Swynx Lite quarantine\n${entry}\n`);
    }
  } catch { /* best effort */ }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Simple stdin confirmation prompt
 */
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
