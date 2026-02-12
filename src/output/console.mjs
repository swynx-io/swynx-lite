// src/output/console.mjs
// Terminal output formatter — raw ANSI codes (no chalk)

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const RED = `${ESC}31m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const CYAN = `${ESC}36m`;
const WHITE = `${ESC}37m`;
const BRIGHT_RED = `${ESC}91m`;
const BRIGHT_GREEN = `${ESC}92m`;
const BRIGHT_YELLOW = `${ESC}93m`;
const BRIGHT_CYAN = `${ESC}96m`;

function c(style, text, noColor) {
  if (noColor) return text;
  return `${style}${text}${RESET}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatNumber(n) {
  return n.toLocaleString('en-US');
}

function pad(str, len) {
  return str + ' '.repeat(Math.max(0, len - str.length));
}

function rpad(str, len) {
  return ' '.repeat(Math.max(0, len - str.length)) + str;
}

/**
 * Render scan results to the console
 */
export function renderScanOutput(results, options = {}) {
  const { noColor = false, verbose = false, ci = false, security = null } = options;
  const lines = [];

  const nc = noColor;
  const hr = '─'.repeat(48);

  // ── Header ──
  lines.push('');
  lines.push(`  ${c(BOLD + BRIGHT_CYAN, 'swynx lite', nc)} ${c(DIM, `v1.0.0`, nc)}`);
  lines.push('');

  // ── Summary ──
  lines.push(`  ${c(DIM, '──', nc)} ${c(BOLD, 'Summary', nc)} ${c(DIM, hr, nc)}`);
  lines.push('');

  const summary = results.summary;

  const summaryRows = [
    ['Files scanned', formatNumber(summary.totalFiles)],
    ['Entry points', formatNumber(summary.entryPoints)],
    ['Reachable', formatNumber(summary.reachableFiles)],
  ];

  // Dead files — highlight red if > 0
  const deadLabel = 'Dead files';
  const deadCount = summary.deadFiles;
  const deadRate = summary.deadRate;
  const deadValue = deadCount > 0
    ? `${c(BRIGHT_RED, formatNumber(deadCount), nc)}  ${c(DIM, `(${deadRate})`, nc)}`
    : `${c(BRIGHT_GREEN, '0', nc)}`;
  summaryRows.push([deadLabel, deadValue]);

  // Partially dead files (unused exports)
  const partialCount = summary.partialFiles || 0;
  if (partialCount > 0) {
    summaryRows.push(['Unused exports', `${c(YELLOW, formatNumber(partialCount) + ' file' + (partialCount === 1 ? '' : 's'), nc)}`]);
  }

  // Dead size
  if (summary.totalDeadBytes > 0) {
    summaryRows.push(['Dead code size', formatBytes(summary.totalDeadBytes)]);
  }

  for (const [label, value] of summaryRows) {
    lines.push(`   ${c(DIM, pad(label, 18), nc)}${value}`);
  }

  lines.push('');

  // ── Dead Files ──
  if (deadCount > 0) {
    lines.push(`  ${c(DIM, '──', nc)} ${c(BOLD, 'Dead Files', nc)} ${c(DIM, hr, nc)}`);
    lines.push('');

    const deadFiles = results.deadFiles || [];
    const showCount = verbose ? deadFiles.length : Math.min(5, deadFiles.length);

    for (let i = 0; i < showCount; i++) {
      const f = deadFiles[i];
      const path = f.file || f.path || '';
      const size = formatBytes(f.size);
      const lineCount = f.lines ? `${formatNumber(f.lines)} lines` : '';
      lines.push(`   ${c(WHITE, pad(path, 42), nc)} ${c(DIM, rpad(size, 10), nc)}   ${c(DIM, lineCount, nc)}`);
    }

    if (!verbose && deadFiles.length > 5) {
      lines.push(`   ${c(DIM, `... and ${deadFiles.length - 5} more (use --verbose to show all)`, nc)}`);
    }

    lines.push('');
  }

  // ── Unused Exports ── (partially dead files)
  const partialFiles = results.partialFiles || [];
  if (partialFiles.length > 0) {
    lines.push(`  ${c(DIM, '──', nc)} ${c(BOLD, 'Unused Exports', nc)} ${c(DIM, hr, nc)}`);
    lines.push('');

    const showPartialCount = verbose ? partialFiles.length : Math.min(5, partialFiles.length);

    for (let i = 0; i < showPartialCount; i++) {
      const f = partialFiles[i];
      const path = f.file || f.path || '';
      const deadExports = f.deadExports || [];
      lines.push(`   ${c(WHITE, pad(path, 42), nc)} ${c(YELLOW, deadExports.join(', '), nc)}`);
    }

    if (!verbose && partialFiles.length > 5) {
      lines.push(`   ${c(DIM, `... and ${partialFiles.length - 5} more (use --verbose to show all)`, nc)}`);
    }

    lines.push('');
  }

  // ── Security ──
  if (security && security.summary && security.summary.total > 0) {
    lines.push(`  ${c(DIM, '──', nc)} ${c(BOLD, 'Security', nc)} ${c(DIM, hr, nc)}`);
    lines.push('');

    const secSummary = security.summary;
    const inDeadLabel = secSummary.inDeadCode > 0
      ? `${secSummary.inDeadCode} finding${secSummary.inDeadCode === 1 ? '' : 's'} in dead code`
      : '';
    const inLiveLabel = secSummary.inLiveCode > 0
      ? `${secSummary.inLiveCode} finding${secSummary.inLiveCode === 1 ? '' : 's'} in live code`
      : '';
    if (inDeadLabel) lines.push(`   ${c(YELLOW, inDeadLabel, nc)}`);
    if (inLiveLabel) lines.push(`   ${c(RED, inLiveLabel, nc)}`);
    lines.push('');

    // Show top findings
    const findings = security.findings || [];
    const showSecCount = verbose ? findings.length : Math.min(5, findings.length);

    for (let i = 0; i < showSecCount; i++) {
      const f = findings[i];
      const sevColor = f.severity === 'CRITICAL' ? BRIGHT_RED
        : f.severity === 'HIGH' ? RED
        : f.severity === 'MEDIUM' ? YELLOW
        : DIM;

      lines.push(`   ${c(BOLD + sevColor, pad(f.severity, 10), nc)}${c(WHITE, f.file, nc)}${c(DIM, `:${f.line}`, nc)}`);
      lines.push(`             ${c(DIM, `${f.cwe} ${f.cweName}`, nc)} ${c(DIM, '—', nc)} ${f.description}`);
      if (f.risk) {
        lines.push(`             ${c(DIM, f.risk, nc)}`);
      }
      lines.push('');
    }

    if (!verbose && findings.length > 5) {
      lines.push(`   ${c(DIM, `... and ${findings.length - 5} more findings`, nc)}`);
      lines.push('');
    }
  }

  // ── What Next ── (interactive only)
  if (!ci) {
    if (deadCount > 0 || partialFiles.length > 0) {
      lines.push(`  ${c(DIM, '──', nc)} ${c(BOLD, 'What Next', nc)} ${c(DIM, hr, nc)}`);
      lines.push('');
      if (deadCount > 0) {
        lines.push(`   Run  ${c(BRIGHT_CYAN, 'swynx-lite clean', nc)}  to remove ${formatNumber(deadCount)} dead file${deadCount === 1 ? '' : 's'} ${c(DIM, `(saves ${formatBytes(summary.totalDeadBytes)})`, nc)}`);
      }
      if (partialFiles.length > 0) {
        const totalDeadExports = partialFiles.reduce((sum, f) => sum + (f.deadExports || []).length, 0);
        lines.push(`   ${c(DIM, `${formatNumber(totalDeadExports)} unused export${totalDeadExports === 1 ? '' : 's'} in ${formatNumber(partialFiles.length)} file${partialFiles.length === 1 ? '' : 's'} — review manually`, nc)}`);
      }
      lines.push(`   Run  ${c(BRIGHT_CYAN, 'swynx-lite scan --json', nc)}  for machine-readable output`);
      lines.push('');
    }

    // Pro footer — dim, unobtrusive
    lines.push(`  ${c(DIM, 'Dashboard, predictions, and more → swynx.io/pro', nc)}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Render clean results to the console
 */
export function renderCleanOutput(results, options = {}) {
  const { noColor = false, dryRun = false } = options;
  const lines = [];
  const nc = noColor;

  lines.push('');
  lines.push(`  ${c(BOLD + BRIGHT_CYAN, 'swynx lite', nc)} ${c(DIM, 'v1.0.0', nc)}${dryRun ? c(DIM, ' — dry run (no files will be modified)', nc) : ''}`);
  lines.push('');

  if (dryRun) {
    lines.push(`  Would remove ${c(BOLD, formatNumber(results.filesRemoved), nc)} file${results.filesRemoved === 1 ? '' : 's'} ${c(DIM, `(${formatBytes(results.bytesRemoved)})`, nc)}:`);
  } else {
    lines.push(`  ${formatNumber(results.deadCount || 0)} dead files found ${c(DIM, `(${formatBytes(results.bytesRemoved)})`, nc)}`);
  }

  lines.push('');

  // File list
  const files = results.files || [];
  const showCount = Math.min(5, files.length);

  for (let i = 0; i < showCount; i++) {
    const f = files[i];
    const path = typeof f === 'string' ? f : (f.file || f.path || '');
    const size = typeof f === 'object' && f.size ? formatBytes(f.size) : '';
    lines.push(`   ${c(WHITE, pad(path, 42), nc)} ${c(DIM, rpad(size, 10), nc)}`);
  }

  if (files.length > 5) {
    lines.push(`   ${c(DIM, `... and ${files.length - 5} more`, nc)}`);
  }

  lines.push('');

  if (results.importsRemoved > 0 || results.barrelExportsRemoved > 0) {
    if (dryRun) {
      lines.push(`  Would clean:`);
    } else {
      lines.push(`  Also cleaned:`);
    }
    if (results.importsRemoved > 0) {
      lines.push(`   ${formatNumber(results.importsRemoved)} dead import${results.importsRemoved === 1 ? '' : 's'} from live files`);
    }
    if (results.barrelExportsRemoved > 0) {
      lines.push(`   ${formatNumber(results.barrelExportsRemoved)} dead re-export${results.barrelExportsRemoved === 1 ? '' : 's'} from barrel files`);
    }
    lines.push('');
  }

  if (!dryRun && results.sessionId) {
    lines.push(`  ${c(BRIGHT_GREEN, '\u2713', nc)} Quarantined ${formatNumber(results.filesRemoved)} file${results.filesRemoved === 1 ? '' : 's'} to .swynx-quarantine/`);
    if (results.importsRemoved > 0 || results.barrelExportsRemoved > 0) {
      lines.push(`  ${c(BRIGHT_GREEN, '\u2713', nc)} Cleaned ${formatNumber(results.importsRemoved)} import${results.importsRemoved === 1 ? '' : 's'}, ${formatNumber(results.barrelExportsRemoved)} barrel export${results.barrelExportsRemoved === 1 ? '' : 's'}`);
    }
    lines.push(`  ${c(BRIGHT_GREEN, '\u2713', nc)} Removed ${formatBytes(results.bytesRemoved)} of dead code`);
    lines.push('');
    lines.push(`  Undo with  ${c(BRIGHT_CYAN, 'swynx-lite restore', nc)}`);
    lines.push(`  Finalise with  ${c(BRIGHT_CYAN, 'swynx-lite purge', nc)}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Render restore result
 */
export function renderRestoreOutput(result, options = {}) {
  const nc = options.noColor || false;
  const lines = [];

  lines.push('');
  if (result.restored && result.restored.length > 0) {
    lines.push(`  ${c(BRIGHT_GREEN, '\u2713', nc)} Restored ${result.restored.length} file${result.restored.length === 1 ? '' : 's'} from quarantine session ${c(DIM, result.sessionId, nc)}`);
    lines.push('');
    lines.push(`  Restored files are back in their original locations.`);
    lines.push(`  Quarantine session kept — run  ${c(BRIGHT_CYAN, 'swynx-lite purge', nc)}  to clean up.`);
  } else {
    lines.push(`  No files to restore.`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Render session list
 */
export function renderSessionList(sessions, options = {}) {
  const nc = options.noColor || false;
  const lines = [];

  lines.push('');
  if (sessions.length === 0) {
    lines.push(`  No quarantine sessions found.`);
  } else {
    lines.push(`  ${sessions.length} quarantine session${sessions.length === 1 ? '' : 's'}:`);
    lines.push('');
    for (const s of sessions) {
      const date = new Date(s.createdAt).toLocaleString();
      const status = s.status === 'restored' ? c(YELLOW, '[restored]', nc) : c(GREEN, '[active]', nc);
      lines.push(`   ${c(DIM, s.sessionId, nc)}  ${pad(date, 22)}  ${formatNumber(s.fileCount)} file${s.fileCount === 1 ? '' : 's'}  ${formatBytes(s.totalSize)}  ${status}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Render purge result
 */
export function renderPurgeOutput(results, options = {}) {
  const nc = options.noColor || false;
  const lines = [];

  lines.push('');
  if (results.purged > 0) {
    lines.push(`  ${c(BRIGHT_GREEN, '\u2713', nc)} Purged ${results.purged} session${results.purged === 1 ? '' : 's'} (${formatNumber(results.totalFiles)} file${results.totalFiles === 1 ? '' : 's'}, ${formatBytes(results.totalSize)})`);
  } else {
    lines.push(`  No quarantine sessions to purge.`);
  }
  lines.push('');

  return lines.join('\n');
}
