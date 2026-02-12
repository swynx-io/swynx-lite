// src/fixer/import-cleaner.mjs
// Clean up import statements in live files that reference deleted files

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname, relative, basename, extname } from 'path';

/**
 * Find and clean imports that reference deleted files
 * @param {string} projectPath - Project root
 * @param {string[]} deletedFiles - List of deleted file paths (relative)
 * @param {string[]} liveFiles - List of live files to check (relative)
 * @param {object} options - Options
 */
export async function cleanDeadImports(projectPath, deletedFiles, liveFiles, options = {}) {
  const { dryRun = false } = options;

  const result = {
    filesModified: [],
    importsRemoved: [],
    errors: []
  };

  // Build a set of deleted file patterns (without extensions for matching)
  const deletedPatterns = new Set();
  for (const file of deletedFiles) {
    // Add full path
    deletedPatterns.add(file);
    // Add without extension
    const ext = extname(file);
    if (ext) {
      deletedPatterns.add(file.slice(0, -ext.length));
    }
    // Add just the basename without extension
    const base = basename(file, ext);
    deletedPatterns.add(base);
  }

  // Process each live file
  for (const liveFile of liveFiles) {
    const fullPath = join(projectPath, liveFile);

    if (!existsSync(fullPath)) continue;

    // Only process JS/TS files
    const ext = extname(liveFile).toLowerCase();
    if (!['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue'].includes(ext)) {
      continue;
    }

    try {
      const content = readFileSync(fullPath, 'utf-8');
      const { modified, changes } = cleanImportsInFile(content, liveFile, deletedFiles, deletedPatterns);

      if (changes.length > 0) {
        if (!dryRun) {
          writeFileSync(fullPath, modified, 'utf-8');
        }

        result.filesModified.push(liveFile);
        result.importsRemoved.push({
          file: liveFile,
          imports: changes,
          dryRun
        });
      }
    } catch (error) {
      result.errors.push({ file: liveFile, error: error.message });
    }
  }

  return result;
}

/**
 * Clean imports in a single file's content
 */
function cleanImportsInFile(content, filePath, deletedFiles, deletedPatterns) {
  const lines = content.split('\n');
  const changes = [];
  const newLines = [];
  const fileDir = dirname(filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const importMatch = matchImportStatement(line);

    if (importMatch) {
      const { importPath, fullMatch } = importMatch;

      // Resolve the import path relative to the file
      const resolvedPath = resolveImportPath(fileDir, importPath, deletedFiles);

      if (resolvedPath && isDeletedImport(resolvedPath, deletedFiles, deletedPatterns)) {
        changes.push({
          line: i + 1,
          removed: line.trim(),
          importPath
        });
        // Skip this line (don't add to newLines)
        // Also skip empty lines that follow import blocks
        continue;
      }
    }

    newLines.push(line);
  }

  // Clean up consecutive empty lines that might be left
  const cleaned = cleanEmptyLines(newLines);

  return {
    modified: cleaned.join('\n'),
    changes
  };
}

/**
 * Match import/require statements
 */
function matchImportStatement(line) {
  const trimmed = line.trim();

  // ES6 import
  // import X from 'path'
  // import { X } from 'path'
  // import * as X from 'path'
  // import 'path'
  const esImportMatch = trimmed.match(/^import\s+(?:.*\s+from\s+)?['"]([^'"]+)['"]/);
  if (esImportMatch) {
    return { importPath: esImportMatch[1], fullMatch: esImportMatch[0] };
  }

  // Dynamic import (inline - harder to remove safely, skip for now)
  // const X = await import('path')

  // CommonJS require
  // const X = require('path')
  // require('path')
  const requireMatch = trimmed.match(/(?:const|let|var)?\s*\w*\s*=?\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
  if (requireMatch) {
    return { importPath: requireMatch[1], fullMatch: requireMatch[0] };
  }

  return null;
}

/**
 * Resolve an import path relative to the importing file
 */
function resolveImportPath(fileDir, importPath, deletedFiles) {
  // Skip node_modules and absolute imports
  if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
    return null;
  }

  // Resolve relative path
  const resolved = join(fileDir, importPath);

  // Try with common extensions
  const extensions = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '/index.js', '/index.ts'];

  for (const ext of extensions) {
    const withExt = resolved + ext;
    // Normalize the path
    const normalized = withExt.replace(/\\/g, '/').replace(/^\.\//, '');

    for (const deleted of deletedFiles) {
      const deletedNorm = deleted.replace(/\\/g, '/').replace(/^\.\//, '');
      if (normalized === deletedNorm) {
        return normalized;
      }
      // Check without extension
      const deletedNoExt = deletedNorm.replace(/\.[^/.]+$/, '');
      const resolvedNoExt = normalized.replace(/\.[^/.]+$/, '');
      if (resolvedNoExt === deletedNoExt) {
        return normalized;
      }
    }
  }

  return resolved;
}

/**
 * Check if an import path matches a deleted file
 */
function isDeletedImport(resolvedPath, deletedFiles, deletedPatterns) {
  const normalized = resolvedPath.replace(/\\/g, '/').replace(/^\.\//, '');

  // Direct match
  if (deletedPatterns.has(normalized)) {
    return true;
  }

  // Without extension match
  const withoutExt = normalized.replace(/\.[^/.]+$/, '');
  if (deletedPatterns.has(withoutExt)) {
    return true;
  }

  // Check against full deleted paths
  for (const deleted of deletedFiles) {
    const deletedNorm = deleted.replace(/\\/g, '/').replace(/^\.\//, '');
    const deletedNoExt = deletedNorm.replace(/\.[^/.]+$/, '');

    if (normalized === deletedNorm || withoutExt === deletedNoExt) {
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
      continue; // Skip consecutive empty lines
    }

    result.push(line);
    lastWasEmpty = isEmpty;
  }

  return result;
}

export default {
  cleanDeadImports
};
