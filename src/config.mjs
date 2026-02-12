// src/config.mjs
// Config file loading: .swynx-lite.json + .swynxignore

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const DEFAULTS = {
  ignore: [],
  ci: {
    threshold: 0,
    failOnSecurity: true,
    securitySeverity: 'HIGH',
  },
  security: {
    enabled: true,
  },
  clean: {
    quarantine: true,
    importClean: true,
    barrelClean: true,
  },
};

/**
 * Load .swynx-lite.json from project root
 */
function loadConfigFile(projectPath) {
  const configPath = join(projectPath, '.swynx-lite.json');
  if (!existsSync(configPath)) return {};

  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (e) {
    console.error(`  Warning: invalid .swynx-lite.json — ${e.message}`);
    return {};
  }
}

/**
 * Load .swynxignore from project root (gitignore-style lines)
 */
function loadIgnoreFile(projectPath) {
  const ignorePath = join(projectPath, '.swynxignore');
  if (!existsSync(ignorePath)) return [];

  try {
    const content = readFileSync(ignorePath, 'utf-8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Load config, merging: defaults < .swynx-lite.json < .swynxignore < CLI options
 */
export function loadConfig(projectPath, cliOptions = {}) {
  const fileConfig = loadConfigFile(projectPath);
  const ignorePatterns = loadIgnoreFile(projectPath);

  // Merge ignore patterns: file config + .swynxignore + CLI --ignore
  const ignore = [
    ...(DEFAULTS.ignore),
    ...(fileConfig.ignore || []),
    ...ignorePatterns,
    ...(cliOptions.ignore || []),
  ];

  const config = {
    ignore,
    ci: {
      ...DEFAULTS.ci,
      ...(fileConfig.ci || {}),
    },
    security: {
      ...DEFAULTS.security,
      ...(fileConfig.security || {}),
    },
    clean: {
      ...DEFAULTS.clean,
      ...(fileConfig.clean || {}),
    },
  };

  // CLI overrides
  if (cliOptions.threshold !== undefined) config.ci.threshold = cliOptions.threshold;
  if (cliOptions.security === false) config.security.enabled = false;

  return config;
}

/**
 * Generate a default .swynx-lite.json template
 */
export function generateConfigTemplate() {
  return JSON.stringify({
    ignore: [
      '**/__tests__/**',
      '**/*.test.*',
      '**/*.spec.*',
      'scripts/**',
      'docs/**',
    ],
    ci: {
      threshold: 5,
      failOnSecurity: true,
      securitySeverity: 'HIGH',
    },
    security: {
      enabled: true,
    },
    clean: {
      quarantine: true,
      importClean: true,
      barrelClean: true,
    },
  }, null, 2);
}
