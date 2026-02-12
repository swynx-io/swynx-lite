// src/output/json.mjs
// JSON output formatter

/**
 * Format scan results as JSON schema matching the spec
 */
export function formatJSON(results, options = {}) {
  const { projectPath, security } = options;

  const output = {
    version: '1.0.0',
    tool: 'swynx-lite',
    timestamp: new Date().toISOString(),
    project: {
      path: projectPath,
      languages: Object.keys(results.summary.languages || {}),
      framework: results.framework || null,
    },
    summary: {
      totalFiles: results.summary.totalFiles,
      entryPoints: results.summary.entryPoints,
      reachableFiles: results.summary.reachableFiles,
      deadFiles: results.summary.deadFiles,
      deadRate: parseFloat(results.summary.deadRate),
      deadBytes: results.summary.totalDeadBytes,
    },
    deadFiles: (results.deadFiles || []).map(f => ({
      path: f.file,
      language: f.language,
      size: f.size,
      lines: f.lines,
      exports: (f.exports || []).map(e => e.name || e),
    })),
  };

  // Security section
  if (security && security.summary && security.summary.total > 0) {
    output.security = {
      findings: (security.findings || []).map(f => ({
        severity: f.severity,
        cwe: f.cwe,
        cweName: f.cweName,
        file: f.file,
        line: f.line,
        description: f.description,
        inDeadCode: f.isDead || false,
      })),
    };
  }

  return JSON.stringify(output, null, 2);
}

/**
 * Format clean results as JSON
 */
export function formatCleanJSON(results) {
  return JSON.stringify({
    version: '1.0.0',
    tool: 'swynx-lite',
    timestamp: new Date().toISOString(),
    action: results.dryRun ? 'dry-run' : 'clean',
    summary: {
      filesRemoved: results.filesRemoved || 0,
      bytesRemoved: results.bytesRemoved || 0,
      importsRemoved: results.importsRemoved || 0,
      barrelExportsRemoved: results.barrelExportsRemoved || 0,
    },
    quarantine: results.sessionId ? {
      sessionId: results.sessionId,
      restoreCommand: 'swynx-lite restore',
      purgeCommand: 'swynx-lite purge',
    } : null,
    files: results.files || [],
  }, null, 2);
}
