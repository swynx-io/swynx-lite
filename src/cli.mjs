// src/cli.mjs
// Commander-based CLI for swynx-lite

import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

const VERSION = '1.0.0';

// ── First-run detection ──────────────────────────────────────────────────────

function checkFirstRun() {
  const marker = join(
    process.env.HOME || process.env.USERPROFILE || '/tmp',
    '.swynx-lite-init'
  );
  if (!existsSync(marker)) {
    try { writeFileSync(marker, Date.now().toString()); } catch { /* */ }
    return true;
  }
  return false;
}

// ── CLI Setup ────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('swynx-lite')
  .description('Dead code detection and cleanup for 35 languages')
  .version(VERSION, '-v, --version');

// ── scan ─────────────────────────────────────────────────────────────────────

program
  .command('scan')
  .argument('[path]', 'Path to scan', '.')
  .description('Scan for dead code and security issues')
  .option('--json', 'Output as JSON instead of console')
  .option('--ci', 'CI mode: exit code 1 if dead code found')
  .option('--threshold <n>', 'In CI mode, only fail if dead rate > n%', parseFloat)
  .option('--no-security', 'Skip security scanning')
  .option('--ignore <glob>', 'Additional paths to ignore (repeatable)', collect, [])
  .option('--verbose', 'Show detailed progress')
  .option('--no-color', 'Disable ANSI colours')
  .action(async (path, opts) => {
    if (checkFirstRun() && !opts.json && !opts.ci) {
      console.log(`\n  ${dim('swynx lite — no telemetry, no tracking, fully offline.')}`);
    }

    const { runScan } = await import('./scan.mjs');
    const { exitCode } = await runScan(path, opts);
    process.exit(exitCode);
  });

// ── clean ────────────────────────────────────────────────────────────────────

program
  .command('clean')
  .argument('[path]', 'Path to clean', '.')
  .description('Remove dead code with quarantine safety net')
  .option('--dry-run', 'Preview what would be removed')
  .option('--no-quarantine', 'Delete directly without quarantine backup')
  .option('--no-import-clean', 'Skip cleaning dead imports from live files')
  .option('--no-barrel-clean', 'Skip cleaning dead re-exports from barrel files')
  .option('--yes', 'Skip confirmation prompt')
  .option('--json', 'Output as JSON')
  .option('--no-color', 'Disable ANSI colours')
  .action(async (path, opts) => {
    const { runClean } = await import('./clean.mjs');
    const { exitCode } = await runClean(path, opts);
    process.exit(exitCode);
  });

// ── restore ──────────────────────────────────────────────────────────────────

program
  .command('restore')
  .description('Undo the last clean operation')
  .option('--list', 'List all available restore points')
  .option('--id <id>', 'Restore a specific quarantine session')
  .option('--no-color', 'Disable ANSI colours')
  .action(async (opts) => {
    const { listSessions, restoreSession } = await import('./shared/fixer/quarantine.mjs');
    const { renderRestoreOutput, renderSessionList } = await import('./output/console.mjs');
    const noColor = opts.color === false || !!process.env.NO_COLOR;
    const projectPath = resolve('.');

    if (opts.list) {
      const sessions = listSessions(projectPath);
      console.log(renderSessionList(sessions, { noColor }));
      process.exit(0);
    }

    const sessions = listSessions(projectPath);
    if (sessions.length === 0) {
      console.log('\n  No quarantine sessions found.\n');
      process.exit(0);
    }

    // Restore specific or most recent active session
    const sessionId = opts.id || sessions.find(s => s.status === 'active')?.sessionId || sessions[0].sessionId;

    try {
      const result = restoreSession(projectPath, sessionId);
      console.log(renderRestoreOutput(result, { noColor }));
    } catch (e) {
      console.error(`  Error: ${e.message}\n`);
      process.exit(2);
    }
  });

// ── purge ────────────────────────────────────────────────────────────────────

program
  .command('purge')
  .description('Permanently delete quarantined files')
  .option('--id <id>', 'Purge a specific session only')
  .option('--yes', 'Skip confirmation')
  .option('--no-color', 'Disable ANSI colours')
  .action(async (opts) => {
    const { listSessions, purgeSession } = await import('./shared/fixer/quarantine.mjs');
    const { renderPurgeOutput } = await import('./output/console.mjs');
    const noColor = opts.color === false || !!process.env.NO_COLOR;
    const projectPath = resolve('.');

    const sessions = listSessions(projectPath);
    if (sessions.length === 0) {
      console.log('\n  No quarantine sessions to purge.\n');
      process.exit(0);
    }

    const autoYes = opts.yes || false;

    if (!autoYes) {
      const totalSize = sessions.reduce((sum, s) => sum + (s.totalSize || 0), 0);
      const totalFiles = sessions.reduce((sum, s) => sum + (s.fileCount || 0), 0);
      console.log(`\n  ${sessions.length} quarantine session${sessions.length === 1 ? '' : 's'} found (${formatBytes(totalSize)} total)\n`);

      const ok = await confirmPrompt(`  Permanently delete all quarantined files? (y/N) `);
      if (!ok) {
        console.log('  Cancelled.\n');
        process.exit(0);
      }
    }

    let purged = 0;
    let totalFiles = 0;
    let totalSize = 0;

    if (opts.id) {
      const result = purgeSession(projectPath, opts.id);
      purged = 1;
      totalFiles = result.purgedFiles;
    } else {
      for (const s of sessions) {
        try {
          purgeSession(projectPath, s.sessionId);
          purged++;
          totalFiles += s.fileCount || 0;
          totalSize += s.totalSize || 0;
        } catch { /* skip */ }
      }
    }

    console.log(renderPurgeOutput({ purged, totalFiles, totalSize }, { noColor }));
  });

// ── init ─────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Create a .swynx-lite.json config file')
  .action(async () => {
    const configPath = join(resolve('.'), '.swynx-lite.json');
    if (existsSync(configPath)) {
      console.log('\n  .swynx-lite.json already exists.\n');
      process.exit(0);
    }

    const { generateConfigTemplate } = await import('./config.mjs');
    writeFileSync(configPath, generateConfigTemplate() + '\n');

    console.log('\n  Created .swynx-lite.json');
    console.log('');
    console.log('  Edit this file to:');
    console.log('   \u2022 Ignore specific paths or patterns');
    console.log('   \u2022 Set CI thresholds');
    console.log('   \u2022 Configure security scanning');
    console.log('');
  });

// ── --pro flag ───────────────────────────────────────────────────────────────

program.option('--pro', 'Show Swynx Pro features');

program.on('option:pro', () => {
  const d = process.env.NO_COLOR ? (t) => t : (t) => `\x1b[2m${t}\x1b[0m`;
  const b = process.env.NO_COLOR ? (t) => t : (t) => `\x1b[1m${t}\x1b[0m`;
  const c = process.env.NO_COLOR ? (t) => t : (t) => `\x1b[1;96m${t}\x1b[0m`;

  console.log('');
  console.log(`  ${c('swynx lite')} ${d(`v${VERSION}`)} — Free forever`);
  console.log('');
  console.log(`  ${b('Swynx Pro')} is built for engineering teams:`);
  console.log('   \u2022 Web dashboard with historical trends');
  console.log('   \u2022 Predictive intelligence (decay signals)');
  console.log('   \u2022 Per-export dead code detection');
  console.log('   \u2022 Emissions and waste analysis');
  console.log('   \u2022 Dependency and license scanning');
  console.log('   \u2022 SARIF, Markdown, and PDF reports');
  console.log('   \u2022 Enterprise reporting suite');
  console.log('   \u2022 Air-gapped deployment');
  console.log('   \u2022 Priority support');
  console.log('');
  console.log(`  From \u00a32,000/year \u00b7 https://swynx.io/pro`);
  console.log('');
  process.exit(0);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function collect(val, arr) {
  arr.push(val);
  return arr;
}

function dim(text) {
  return process.env.NO_COLOR ? text : `\x1b[2m${text}\x1b[0m`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function confirmPrompt(message) {
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

// ── Default action: scan when no command given ──────────────────────────────

// If no command provided, default to `scan .`
// This makes `npx swynx-lite` work like `npx knip`
const args = process.argv.slice(2);
const commands = ['scan', 'clean', 'restore', 'purge', 'init', 'help'];
const hasCommand = args.some(a => commands.includes(a));
const hasHelpOrVersion = args.some(a => ['-h', '--help', '-v', '--version', '--pro'].includes(a));

if (args.length === 0 || (!hasCommand && !hasHelpOrVersion)) {
  // Inject 'scan' as default command, pass remaining args as flags
  process.argv.splice(2, 0, 'scan');
}

program.parse();
