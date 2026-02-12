// src/security.mjs
// Security scan orchestrator — wraps the shared security scanner

import { scanCodePatterns } from './shared/security/scanner.mjs';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';

/**
 * Run security scanning on scan results
 *
 * @param {string} projectPath - Project root
 * @param {object} scanResults - Results from scanDeadCode()
 * @param {object} options
 * @returns {object} Security scan results
 */
export async function runSecurityScan(projectPath, scanResults, options = {}) {
  const { onProgress } = options;

  // Build dead file set
  const deadFileSet = new Set(
    (scanResults.deadFiles || []).map(f => f.file || f.path || '')
  );

  // Build analysis objects with content for security scanning
  // We need to re-read file content since the scanner strips it
  const allFiles = [];
  const deadFiles = scanResults.deadFiles || [];

  // Scan dead files for security patterns
  for (const f of deadFiles) {
    const filePath = f.file || f.path || '';
    if (!filePath) continue;

    const fullPath = join(projectPath, filePath);
    let content = '';
    try {
      if (existsSync(fullPath)) {
        content = readFileSync(fullPath, 'utf-8');
      }
    } catch { continue; }

    if (!content) continue;

    allFiles.push({
      file: filePath,
      relativePath: filePath,
      content,
    });
  }

  if (onProgress) {
    onProgress({ phase: 'security', message: `Scanning ${allFiles.length} files for security patterns...` });
  }

  const results = scanCodePatterns(allFiles, deadFileSet, projectPath, onProgress);

  if (onProgress) {
    onProgress({ phase: 'done', message: 'Security scan complete' });
  }

  return results;
}
