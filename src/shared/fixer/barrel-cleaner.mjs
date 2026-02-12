// src/fixer/barrel-cleaner.mjs
// Clean up barrel/index file re-exports that reference deleted files

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname, basename, extname } from 'path';

/**
 * Find and clean barrel exports that reference deleted files
 * @param {string} projectPath - Project root
 * @param {string[]} deletedFiles - List of deleted file paths (relative)
 * @param {string[]} liveFiles - List of live files to check (relative)
 * @param {object} options - Options
 */
export async function cleanBarrelExports(projectPath, deletedFiles, liveFiles, options = {}) {
  const { dryRun = false } = options;

  const result = {
    filesModified: [],
    exportsRemoved: [],
    errors: []
  };

  // Find potential barrel files (index.js, index.ts, etc.)
  const barrelFiles = liveFiles.filter(f => {
    const base = basename(f);
    return /^index\.(js|ts|mjs|cjs|jsx|tsx)$/.test(base);
  });

  // Build a set of deleted file basenames for matching
  const deletedBasenames = new Set();
  for (const file of deletedFiles) {
    const ext = extname(file);
    const base = basename(file, ext);
    deletedBasenames.add(base);
    deletedBasenames.add(base.toLowerCase());
  }

  // Process each barrel file
  for (const barrelFile of barrelFiles) {
    const fullPath = join(projectPath, barrelFile);
    const barrelDir = dirname(barrelFile);

    if (!existsSync(fullPath)) continue;

    try {
      const content = readFileSync(fullPath, 'utf-8');
      const { modified, changes } = cleanExportsInFile(content, barrelDir, deletedFiles, deletedBasenames);

      if (changes.length > 0) {
        if (!dryRun) {
          writeFileSync(fullPath, modified, 'utf-8');
        }

        result.filesModified.push(barrelFile);
        result.exportsRemoved.push({
          file: barrelFile,
          exports: changes,
          dryRun
        });
      }
    } catch (error) {
      result.errors.push({ file: barrelFile, error: error.message });
    }
  }

  return result;
}

/**
 * Clean exports in a single file's content
 */
function cleanExportsInFile(content, barrelDir, deletedFiles, deletedBasenames) {
  const lines = content.split('\n');
  const changes = [];
  const newLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const exportMatch = matchExportStatement(line);

    if (exportMatch) {
      const { exportPath, fullMatch } = exportMatch;

      // Check if this export references a deleted file
      if (isDeletedExport(barrelDir, exportPath, deletedFiles, deletedBasenames)) {
        changes.push({
          line: i + 1,
          removed: line.trim(),
          exportPath
        });
        // Skip this line
        continue;
      }
    }

    newLines.push(line);
  }

  // Clean up consecutive empty lines
  const cleaned = cleanEmptyLines(newLines);

  return {
    modified: cleaned.join('\n'),
    changes
  };
}

/**
 * Match export statements
 */
function matchExportStatement(line) {
  const trimmed = line.trim();

  // export { X } from 'path'
  // export * from 'path'
  // export { default as X } from 'path'
  const reExportMatch = trimmed.match(/^export\s+(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?)\s+from\s+['"]([^'"]+)['"]/);
  if (reExportMatch) {
    return { exportPath: reExportMatch[1], fullMatch: reExportMatch[0] };
  }

  // Named export with default: export { default } from 'path'
  const defaultExportMatch = trimmed.match(/^export\s+\{\s*default[^}]*\}\s+from\s+['"]([^'"]+)['"]/);
  if (defaultExportMatch) {
    return { exportPath: defaultExportMatch[1], fullMatch: defaultExportMatch[0] };
  }

  return null;
}

/**
 * Check if an export path references a deleted file
 */
function isDeletedExport(barrelDir, exportPath, deletedFiles, deletedBasenames) {
  // Skip non-relative exports
  if (!exportPath.startsWith('.')) {
    return false;
  }

  // Resolve the export path relative to barrel file
  const resolved = join(barrelDir, exportPath).replace(/\\/g, '/').replace(/^\.\//, '');

  // Check against deleted files
  for (const deleted of deletedFiles) {
    const deletedNorm = deleted.replace(/\\/g, '/').replace(/^\.\//, '');

    // Exact match
    if (resolved === deletedNorm) {
      return true;
    }

    // Match without extension
    const deletedNoExt = deletedNorm.replace(/\.[^/.]+$/, '');
    const resolvedNoExt = resolved.replace(/\.[^/.]+$/, '');

    if (resolvedNoExt === deletedNoExt) {
      return true;
    }

    // Match with /index suffix
    if (resolved + '/index' === deletedNoExt || resolvedNoExt + '/index' === deletedNoExt) {
      return true;
    }
  }

  return false;
}

/**
 * Clean up consecutive empty lines
 */
function cleanEmptyLines(lines) {
  const result = [];
  let lastWasEmpty = false;

  for (const line of lines) {
    const isEmpty = line.trim() === '';

    if (isEmpty && lastWasEmpty) {
      continue;
    }

    result.push(line);
    lastWasEmpty = isEmpty;
  }

  return result;
}

export default {
  cleanBarrelExports
};
