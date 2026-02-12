// src/security/scanner.mjs
// Full-codebase security pattern scanner
// Scans ALL files for dangerous code patterns (CWE) and proximity to security-critical paths
// Flags each finding with whether it's in dead code or live code

import { extname } from 'path';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getPatternsForLanguage } from './patterns.mjs';
import { checkProximity } from './proximity.mjs';

const SEVERITY_RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

/**
 * Check if a line is a comment (basic heuristic)
 */
function isCommentLine(line) {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('"""') ||
    trimmed.startsWith("'''")
  );
}

/**
 * Check if a line contains example/documentation content rather than real code.
 * Prevents false positives in marketing pages, docs, and code examples rendered as UI text.
 */
function isExampleContent(line, prevLine) {
  // Well-known example AWS credentials (explicitly not real secrets)
  if (/AKIAIOSFODNN7EXAMPLE/.test(line)) return true;
  // Lines with JSX className= are UI markup, not executable code
  if (/className\s*=/.test(line)) return true;
  // Text content on the line immediately after an opening JSX/HTML tag
  // e.g. <div className="...">  followed by  eval(userInput) at handler.ts:42
  if (prevLine && /^\s*<[A-Za-z][A-Za-z0-9.]*\b.*[^/]>\s*$/.test(prevLine)) return true;
  // JSON-LD structured data — standard React SEO pattern, not an XSS risk
  if (prevLine && /application\/ld\+json/.test(prevLine)) return true;
  return false;
}

/**
 * Boost severity when file is in a security-critical directory
 */
function boostSeverity(severity, proximityBoost) {
  if (!proximityBoost) return severity;
  const rank = SEVERITY_RANK[severity] || 1;
  const boostRank = SEVERITY_RANK[proximityBoost] || 1;
  // If proximity boost is higher, escalate one level (up to CRITICAL)
  if (boostRank >= rank && severity !== 'CRITICAL') {
    const levels = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
    const idx = levels.indexOf(severity);
    return levels[Math.min(idx + 1, 3)];
  }
  return severity;
}

/**
 * Scan a single file's content for CWE patterns.
 * Returns array of findings for this file.
 */
function scanFileContent(filePath, content, proximity) {
  const ext = extname(filePath);
  const patterns = getPatternsForLanguage(ext);
  if (patterns.length === 0) return [];

  const lines = content.split('\n');
  const fileFindings = [];

  let inTemplateLiteral = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    if (isCommentLine(line)) continue;

    // Track multi-line template literal state — content inside
    // multi-line backtick strings is string data, not executable code
    const backticks = (line.match(/(?<!\\)`/g) || []).length;
    if (backticks % 2 === 1) inTemplateLiteral = !inTemplateLiteral;

    // Skip lines inside multi-line template literals (code examples, UI text)
    if (inTemplateLiteral && backticks === 0) continue;

    // Skip known example/documentation content
    if (isExampleContent(line, lineIdx > 0 ? lines[lineIdx - 1] : '')) continue;

    for (const pattern of patterns) {
      if (pattern.pattern.test(line)) {
        const severity = boostSeverity(pattern.severity, proximity.highestBoost);

        fileFindings.push({
          id: pattern.id,
          cwe: pattern.cwe,
          cweName: pattern.cweName,
          severity,
          originalSeverity: pattern.severity,
          boosted: severity !== pattern.severity,
          file: filePath,
          line: lineIdx + 1,
          lineContent: line.trim().substring(0, 120),
          description: pattern.description,
          risk: pattern.risk,
          proximity: proximity.matches.length > 0 ? proximity : null
        });

        // Only match each pattern once per line
        break;
      }
    }
  }

  return fileFindings;
}

/**
 * Scan ALL code files for dangerous CWE patterns and proximity alerts.
 * Each finding is flagged with isDead (true = dead code, false = live code).
 *
 * @param {Array} allCodeAnalysis - Combined JS + other language analysis
 * @param {Set<string>} deadFileSet - Set of relative paths that are dead code
 * @param {string} [projectPath] - Project root for re-reading content from disk
 * @param {Function} [onProgress] - Optional progress callback
 * @returns {{ summary, findings, byCWE, byFile, proximityAlerts }}
 */
export function scanCodePatterns(allCodeAnalysis, deadFileSet, projectPath, onProgress) {
  const findings = [];
  const byCWE = {};
  const byFile = {};
  const proximityAlerts = [];

  const severityCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  let inDeadCode = 0;
  let inLiveCode = 0;

  for (let i = 0; i < allCodeAnalysis.length; i++) {
    const file = allCodeAnalysis[i];
    const filePath = file.file?.relativePath || file.file || file.relativePath || file.path || '';
    if (!filePath) continue;

    if (onProgress && i % 200 === 0) {
      onProgress({
        phase: 'Scanning security patterns',
        detail: filePath.split('/').pop(),
        current: i,
        total: allCodeAnalysis.length
      });
    }

    // Check proximity
    const proximity = checkProximity(filePath);
    if (proximity.isCritical || proximity.matches.length > 0) {
      proximityAlerts.push({
        file: filePath,
        isDead: deadFileSet.has(filePath),
        ...proximity
      });
    }

    // Get content — try from analysis object first, then re-read from disk
    let content = file.content || '';
    if (!content && projectPath) {
      try { content = readFileSync(join(projectPath, filePath), 'utf-8'); } catch { /* skip */ }
    }
    if (!content) continue;

    const isDead = deadFileSet.has(filePath);
    const fileFindings = scanFileContent(filePath, content, proximity);

    for (const finding of fileFindings) {
      finding.isDead = isDead;
      finding.recommendation = isDead
        ? 'File is dead code — safe to remove'
        : 'Review and remediate';

      findings.push(finding);
      severityCounts[finding.severity]++;

      if (isDead) inDeadCode++;
      else inLiveCode++;

      // Track by CWE
      if (!byCWE[finding.cwe]) {
        byCWE[finding.cwe] = { cwe: finding.cwe, name: finding.cweName, findings: [] };
      }
      byCWE[finding.cwe].findings.push(finding);
    }

    if (fileFindings.length > 0) {
      byFile[filePath] = fileFindings;
    }
  }

  // Sort findings by severity (CRITICAL first), then dead code last (live findings more urgent)
  findings.sort((a, b) => {
    const sevDiff = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
    if (sevDiff !== 0) return sevDiff;
    // Live code findings first (more urgent)
    return (a.isDead ? 1 : 0) - (b.isDead ? 1 : 0);
  });

  return {
    summary: {
      total: findings.length,
      inDeadCode,
      inLiveCode,
      critical: severityCounts.CRITICAL,
      high: severityCounts.HIGH,
      medium: severityCounts.MEDIUM,
      low: severityCounts.LOW,
      filesWithPatterns: Object.keys(byFile).length,
      proximityAlerts: proximityAlerts.length,
      cweCategories: Object.keys(byCWE).length,
      // Backwards compat
      totalFindings: findings.length
    },
    findings,
    byCWE,
    byFile,
    proximityAlerts
  };
}

/**
 * Backwards-compatible wrapper — scans only dead code files.
 * Used when deadFileSet isn't available (e.g., from older callers).
 */
export function scanDeadCodePatterns(deadCode, allCodeAnalysis, onProgress) {
  const deadFiles = [
    ...(deadCode.fullyDeadFiles || []),
    ...(deadCode.partiallyDeadFiles || [])
  ];
  const deadFileSet = new Set(deadFiles.map(f => f.relativePath || f.file || f.path || ''));

  // Scan only dead files for backwards compatibility
  const deadAnalysis = allCodeAnalysis.filter(f => {
    const fp = f.file?.relativePath || f.file || f.relativePath || f.path || '';
    return deadFileSet.has(fp);
  });

  return scanCodePatterns(deadAnalysis, deadFileSet, null, onProgress);
}

/**
 * Enrich a dead file object with its security pattern findings.
 * Adds `securityPatterns` field for per-file drill-down.
 */
export function enrichDeadFileWithPatterns(deadFile, byFile) {
  const filePath = deadFile.relativePath || deadFile.file || deadFile.path || '';
  const fileFindings = byFile[filePath];

  if (!fileFindings || fileFindings.length === 0) {
    return deadFile;
  }

  const proximity = checkProximity(filePath);

  return {
    ...deadFile,
    securityPatterns: {
      count: fileFindings.length,
      findings: fileFindings,
      proximity: proximity.matches.length > 0 ? proximity : null
    }
  };
}
