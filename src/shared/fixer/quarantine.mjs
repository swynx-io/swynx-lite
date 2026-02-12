// src/fixer/quarantine.mjs
// Quarantine manager for safe file removal

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, rmSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { randomUUID } from 'crypto';

const QUARANTINE_DIR = '.swynx-quarantine';

/**
 * Create a new quarantine session
 */
export function createSession(projectPath, reason = 'manual') {
  const sessionId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const sessionDir = join(projectPath, QUARANTINE_DIR, sessionId);

  mkdirSync(sessionDir, { recursive: true });

  const manifest = {
    sessionId,
    reason,
    createdAt: new Date().toISOString(),
    projectPath,
    files: [],
    status: 'active',
    fileCount: 0,
    totalSize: 0
  };

  writeFileSync(join(sessionDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  return { sessionId, sessionDir, manifest };
}

/**
 * Quarantine a file (move to quarantine directory)
 */
export function quarantineFile(projectPath, sessionId, filePath) {
  const sessionDir = join(projectPath, QUARANTINE_DIR, sessionId);
  const manifestPath = join(sessionDir, 'manifest.json');

  if (!existsSync(manifestPath)) {
    throw new Error(`Quarantine session ${sessionId} not found`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

  // Get relative path from project root
  const relativePath = relative(projectPath, filePath);
  const quarantinePath = join(sessionDir, 'files', relativePath);

  // Ensure directory exists
  mkdirSync(dirname(quarantinePath), { recursive: true });

  // Get file size before moving
  let fileSize = 0;
  if (existsSync(filePath)) {
    fileSize = statSync(filePath).size;
    // Copy file to quarantine
    copyFileSync(filePath, quarantinePath);
    // Delete original
    unlinkSync(filePath);
  }

  // Update manifest
  manifest.files.push({
    originalPath: relativePath,
    quarantinePath: relative(sessionDir, quarantinePath),
    quarantinedAt: new Date().toISOString(),
    size: fileSize
  });
  manifest.fileCount = manifest.files.length;
  manifest.totalSize = manifest.files.reduce((sum, f) => sum + (f.size || 0), 0);

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return { quarantinePath, relativePath };
}

/**
 * List all quarantine sessions for a project
 */
export function listSessions(projectPath) {
  const quarantineDir = join(projectPath, QUARANTINE_DIR);

  if (!existsSync(quarantineDir)) {
    return [];
  }

  const sessions = [];
  const entries = readdirSync(quarantineDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const manifestPath = join(quarantineDir, entry.name, 'manifest.json');
      if (existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
          sessions.push(manifest);
        } catch (e) {
          // Skip invalid sessions
        }
      }
    }
  }

  // Sort by creation date (newest first)
  return sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/**
 * Get a specific session
 */
export function getSession(projectPath, sessionId) {
  const manifestPath = join(projectPath, QUARANTINE_DIR, sessionId, 'manifest.json');

  if (!existsSync(manifestPath)) {
    return null;
  }

  return JSON.parse(readFileSync(manifestPath, 'utf-8'));
}

/**
 * Restore files from quarantine (undo)
 */
export function restoreSession(projectPath, sessionId) {
  const sessionDir = join(projectPath, QUARANTINE_DIR, sessionId);
  const manifestPath = join(sessionDir, 'manifest.json');

  if (!existsSync(manifestPath)) {
    throw new Error(`Quarantine session ${sessionId} not found`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const restored = [];
  const errors = [];

  for (const file of manifest.files) {
    try {
      const quarantinePath = join(sessionDir, file.quarantinePath || join('files', file.originalPath));
      const originalPath = join(projectPath, file.originalPath);

      if (existsSync(quarantinePath)) {
        // Ensure directory exists
        mkdirSync(dirname(originalPath), { recursive: true });
        // Copy back
        copyFileSync(quarantinePath, originalPath);
        restored.push(file.originalPath);
      } else {
        errors.push({ file: file.originalPath, error: 'Quarantine file not found' });
      }
    } catch (error) {
      errors.push({ file: file.originalPath, error: error.message });
    }
  }

  // Update manifest status
  manifest.status = 'restored';
  manifest.restoredAt = new Date().toISOString();
  manifest.restoredFiles = restored.length;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    success: true,
    sessionId,
    restored,
    errors: errors.length > 0 ? errors : undefined,
    message: `Restored ${restored.length} file(s)`
  };
}

/**
 * Permanently delete quarantined files
 */
export function purgeSession(projectPath, sessionId) {
  const sessionDir = join(projectPath, QUARANTINE_DIR, sessionId);

  if (!existsSync(sessionDir)) {
    throw new Error(`Quarantine session ${sessionId} not found`);
  }

  // Read manifest for logging
  const manifestPath = join(sessionDir, 'manifest.json');
  let fileCount = 0;
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    fileCount = manifest.fileCount || manifest.files?.length || 0;
  }

  // Remove entire session directory
  rmSync(sessionDir, { recursive: true, force: true });

  return {
    success: true,
    sessionId,
    purgedFiles: fileCount,
    message: `Permanently deleted quarantine session with ${fileCount} file(s)`
  };
}

/**
 * Get total quarantine size for a project
 */
export function getQuarantineSize(projectPath) {
  const sessions = listSessions(projectPath);
  return sessions.reduce((sum, s) => sum + (s.totalSize || 0), 0);
}

export default {
  createSession,
  quarantineFile,
  listSessions,
  getSession,
  restoreSession,
  purgeSession,
  getQuarantineSize
};
