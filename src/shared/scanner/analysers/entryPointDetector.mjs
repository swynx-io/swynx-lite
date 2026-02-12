// src/scanner/analysers/entryPointDetector.mjs
// Unified entry point detection for multi-language dead code analysis

import { readFileSync, existsSync } from 'fs';
import { join, dirname, basename, extname, relative } from 'path';
import { globSync } from 'glob';
import { collectConfigEntryPoints } from './configParsers.mjs';
import { detectBuildSystems, getPackageDirectories } from './buildSystems.mjs';

/**
 * Default entry point file patterns (language-agnostic)
 */
const DEFAULT_ENTRY_PATTERNS = [
  // JavaScript/TypeScript
  /^index\.(m?js|jsx?|tsx?)$/,
  /^main\.(m?js|jsx?|tsx?)$/,
  /^app\.(m?js|jsx?|tsx?)$/,
  /^server\.(m?js|jsx?|tsx?)$/,
  /^cli\.(m?js|jsx?|tsx?)$/,
  /^entry\.(m?js|jsx?|tsx?)$/,
  /src\/index\.(m?js|jsx?|tsx?)$/,
  /src\/main\.(m?js|jsx?|tsx?)$/,
  /src\/app\.(m?js|jsx?|tsx?)$/,

  // Python
  /^__main__\.py$/,
  /^main\.py$/,
  /^app\.py$/,
  /^manage\.py$/,
  /^wsgi\.py$/,
  /^asgi\.py$/,

  // Go
  /^main\.go$/,
  /cmd\/[^/]+\/main\.go$/,

  // Java
  /^Main\.java$/,
  /Application\.java$/,
  /SpringBootApplication/,

  // C#
  /^Program\.cs$/,
  /^Startup\.cs$/,

  // Ruby
  /^Rakefile$/,
  /^config\.ru$/,
  /^application\.rb$/,

  // PHP
  /^index\.php$/,
  /^artisan$/,

  // Rust
  /^main\.rs$/,
  /src\/main\.rs$/,
  /src\/bin\/[^/]+\.rs$/
];

/**
 * DI decorator patterns by language/framework
 */
const DI_DECORATORS_BY_LANGUAGE = {
  javascript: [
    'Service', 'Injectable', 'Controller', 'Module', 'Component',
    'Entity', 'Repository', 'Resolver', 'Guard', 'Pipe',
    'EventSubscriber', 'Subscriber', 'Singleton'
  ],
  java: [
    'Service', 'Component', 'Repository', 'Controller', 'RestController',
    'Configuration', 'Bean', 'Autowired', 'Inject', 'Named', 'Singleton',
    'Entity', 'ManagedBean', 'Stateless', 'Stateful'
  ],
  csharp: [
    'Controller', 'ApiController', 'Service', 'Scoped', 'Singleton', 'Transient',
    'Entity', 'Table', 'DbContext', 'Injectable'
  ],
  python: [
    'app.route', 'router.get', 'router.post', 'router.put', 'router.delete',
    'task', 'shared_task', 'celery.task'
  ]
};

/**
 * Unified entry point detection result
 */
class EntryPointResult {
  constructor() {
    this.entryPoints = new Map();  // filePath -> { reason, source, confidence, isDynamic }
    this.sources = {
      packageJson: [],
      html: [],
      bundlerConfig: [],
      ciConfig: [],
      diAnnotation: [],
      convention: [],
      buildSystem: []
    };
  }

  add(filePath, info) {
    const existing = this.entryPoints.get(filePath);
    if (!existing || info.confidence > (existing.confidence || 0)) {
      this.entryPoints.set(filePath, info);
    }
    if (info.source && this.sources[info.source]) {
      this.sources[info.source].push(filePath);
    }
  }

  has(filePath) {
    return this.entryPoints.has(filePath);
  }

  get(filePath) {
    return this.entryPoints.get(filePath);
  }

  getAll() {
    return [...this.entryPoints.entries()].map(([file, info]) => ({
      file,
      ...info
    }));
  }

  getFiles() {
    return new Set(this.entryPoints.keys());
  }
}

/**
 * Extract entry points from package.json
 */
function extractPackageJsonEntries(packageJson, projectPath = '') {
  const entries = [];

  if (!packageJson) return entries;

  // main field
  if (packageJson.main) {
    entries.push({
      path: packageJson.main.replace(/^\.\//, ''),
      reason: 'Package main entry',
      source: 'packageJson',
      confidence: 0.9
    });
  }

  // module field (ESM entry)
  if (packageJson.module) {
    entries.push({
      path: packageJson.module.replace(/^\.\//, ''),
      reason: 'Package module entry (ESM)',
      source: 'packageJson',
      confidence: 0.9
    });
  }

  // bin field
  if (packageJson.bin) {
    const bins = typeof packageJson.bin === 'string'
      ? [packageJson.bin]
      : Object.values(packageJson.bin);
    for (const bin of bins) {
      entries.push({
        path: bin.replace(/^\.\//, ''),
        reason: 'Package bin entry',
        source: 'packageJson',
        confidence: 0.95
      });
    }
  }

  // exports field
  if (packageJson.exports) {
    const extractExports = (exp, path = '') => {
      if (typeof exp === 'string') {
        entries.push({
          path: exp.replace(/^\.\//, ''),
          reason: `Package exports entry${path ? ` (${path})` : ''}`,
          source: 'packageJson',
          confidence: 0.9
        });
      } else if (typeof exp === 'object' && exp !== null) {
        for (const [key, value] of Object.entries(exp)) {
          extractExports(value, key);
        }
      }
    };
    extractExports(packageJson.exports);
  }

  // scripts (extract referenced files)
  if (packageJson.scripts) {
    for (const [name, script] of Object.entries(packageJson.scripts)) {
      // Match node/npx/ts-node commands
      const matches = script.matchAll(/(?:node|npx|ts-node|tsx)\s+([^\s&|;]+)/g);
      for (const match of matches) {
        const file = match[1].replace(/^\.\//, '');
        if (file.match(/\.(m?js|ts|tsx?)$/)) {
          entries.push({
            path: file,
            reason: `Referenced in npm script "${name}"`,
            source: 'packageJson',
            confidence: 0.85
          });
        }
      }
    }
  }

  return entries;
}

/**
 * Extract entry points from HTML files
 */
function extractHtmlEntries(projectPath) {
  const entries = [];

  if (!projectPath) return entries;

  const htmlPatterns = [
    '*.html',
    'public/*.html',
    'src/*.html',
    'static/*.html',
    'views/**/*.html',
    'templates/**/*.html'
  ];

  for (const pattern of htmlPatterns) {
    try {
      const htmlFiles = globSync(pattern, {
        cwd: projectPath,
        nodir: true,
        ignore: ['node_modules/**', 'dist/**', 'build/**']
      });

      for (const htmlFile of htmlFiles) {
        const fullPath = join(projectPath, htmlFile);
        try {
          const content = readFileSync(fullPath, 'utf-8');
          const htmlDir = dirname(htmlFile);

          // Match script tags with src attribute
          const scriptPattern = /<script[^>]*\ssrc=["']([^"']+)["'][^>]*>/gi;
          let match;
          while ((match = scriptPattern.exec(content)) !== null) {
            let src = match[1];

            // Skip external scripts
            if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//')) {
              continue;
            }

            // Resolve relative paths
            if (src.startsWith('./')) {
              src = join(htmlDir, src.slice(2));
            } else if (src.startsWith('/')) {
              src = src.slice(1);
            } else if (!src.includes('://')) {
              src = join(htmlDir, src);
            }

            src = src.replace(/\\/g, '/').replace(/^\.\//, '');

            entries.push({
              path: src,
              reason: `Referenced in ${htmlFile}`,
              source: 'html',
              confidence: 0.9
            });
          }
        } catch {
          // Ignore read errors
        }
      }
    } catch {
      // Ignore glob errors
    }
  }

  return entries;
}

/**
 * Check if a file matches entry point patterns
 */
function matchesEntryPattern(filePath, customPatterns = []) {
  const allPatterns = [...DEFAULT_ENTRY_PATTERNS, ...customPatterns];

  for (const pattern of allPatterns) {
    if (pattern.test(filePath)) {
      return {
        matches: true,
        pattern: pattern.toString(),
        confidence: 0.7
      };
    }
  }

  return { matches: false };
}

/**
 * Detect entry points from multi-language build systems
 */
function detectBuildSystemEntries(projectPath) {
  const entries = [];

  if (!projectPath) return entries;

  const buildSystems = detectBuildSystems(projectPath);

  for (const system of buildSystems) {
    // Each build system may define entry points differently
    switch (system.type) {
      case 'gradle':
      case 'maven':
        // Java: look for src/main/java/**/Application.java
        try {
          const javaFiles = globSync('src/main/java/**/*Application.java', {
            cwd: projectPath,
            nodir: true
          });
          for (const file of javaFiles) {
            entries.push({
              path: file,
              reason: `Spring Boot application (${system.type})`,
              source: 'buildSystem',
              confidence: 0.9
            });
          }
        } catch { /* ignore */ }
        break;

      case 'cargo':
        // Rust: src/main.rs and src/bin/*.rs
        if (existsSync(join(projectPath, 'src/main.rs'))) {
          entries.push({
            path: 'src/main.rs',
            reason: 'Cargo binary entry',
            source: 'buildSystem',
            confidence: 0.95
          });
        }
        try {
          const binFiles = globSync('src/bin/*.rs', {
            cwd: projectPath,
            nodir: true
          });
          for (const file of binFiles) {
            entries.push({
              path: file,
              reason: 'Cargo binary entry',
              source: 'buildSystem',
              confidence: 0.95
            });
          }
        } catch { /* ignore */ }
        break;

      case 'go':
        // Go: main.go and cmd/*/main.go
        if (existsSync(join(projectPath, 'main.go'))) {
          entries.push({
            path: 'main.go',
            reason: 'Go main entry',
            source: 'buildSystem',
            confidence: 0.95
          });
        }
        try {
          const cmdFiles = globSync('cmd/*/main.go', {
            cwd: projectPath,
            nodir: true
          });
          for (const file of cmdFiles) {
            entries.push({
              path: file,
              reason: 'Go cmd entry',
              source: 'buildSystem',
              confidence: 0.95
            });
          }
        } catch { /* ignore */ }
        break;

      case 'dotnet':
        // C#: Program.cs
        if (existsSync(join(projectPath, 'Program.cs'))) {
          entries.push({
            path: 'Program.cs',
            reason: '.NET Program entry',
            source: 'buildSystem',
            confidence: 0.95
          });
        }
        break;

      case 'python':
        // Python: __main__.py, manage.py
        for (const file of ['__main__.py', 'manage.py', 'app.py', 'main.py']) {
          if (existsSync(join(projectPath, file))) {
            entries.push({
              path: file,
              reason: 'Python entry point',
              source: 'buildSystem',
              confidence: 0.9
            });
          }
        }
        break;
    }
  }

  return entries;
}

/**
 * Unified entry point detector
 */
export class EntryPointDetector {
  constructor(options = {}) {
    this.projectPath = options.projectPath || process.cwd();
    this.packageJson = options.packageJson || {};
    this.customPatterns = options.customPatterns || [];
    this.diDecorators = options.diDecorators || DI_DECORATORS_BY_LANGUAGE.javascript;
    this.result = new EntryPointResult();
    this.initialized = false;
  }

  /**
   * Initialize detection - collect all entry points from various sources
   */
  initialize() {
    if (this.initialized) return this.result;

    // 1. Package.json entries
    const pkgEntries = extractPackageJsonEntries(this.packageJson, this.projectPath);
    for (const entry of pkgEntries) {
      this.result.add(entry.path, entry);
    }

    // 2. HTML entries
    const htmlEntries = extractHtmlEntries(this.projectPath);
    for (const entry of htmlEntries) {
      this.result.add(entry.path, entry);
    }

    // 3. Bundler/CI config entries
    const configData = collectConfigEntryPoints(this.projectPath);
    for (const entryPath of configData.entries) {
      this.result.add(entryPath, {
        reason: 'Bundler/CI config entry',
        source: 'bundlerConfig',
        confidence: 0.85
      });
    }

    // 4. Build system entries
    const buildEntries = detectBuildSystemEntries(this.projectPath);
    for (const entry of buildEntries) {
      this.result.add(entry.path, entry);
    }

    this.initialized = true;
    return this.result;
  }

  /**
   * Check if a file is an entry point
   * @param {string} filePath - Relative file path
   * @param {Object} options - Additional context (classes, decorators, etc.)
   */
  isEntryPoint(filePath, options = {}) {
    this.initialize();

    const normalizedPath = filePath.replace(/^\.\//, '');

    // 1. Check pre-collected entries
    const preCollected = this.result.get(normalizedPath);
    if (preCollected) {
      return { isEntry: true, ...preCollected };
    }

    // 2. Check pattern matches
    const patternMatch = matchesEntryPattern(normalizedPath, this.customPatterns);
    if (patternMatch.matches) {
      return {
        isEntry: true,
        reason: 'Matches entry point pattern',
        source: 'convention',
        confidence: patternMatch.confidence
      };
    }

    // 3. Check DI decorators on classes
    if (options.classes?.length) {
      for (const cls of options.classes) {
        if (cls.decorators?.length) {
          const diMatch = cls.decorators.find(d =>
            this.diDecorators.includes(d.name)
          );
          if (diMatch) {
            return {
              isEntry: true,
              reason: `Class ${cls.name} has DI decorator: @${diMatch.name}`,
              source: 'diAnnotation',
              confidence: 0.9,
              isDynamic: true
            };
          }
        }
      }
    }

    // 4. Check for framework-specific patterns in file metadata
    if (options.metadata) {
      // Python frameworks
      if (options.metadata.hasMainBlock) {
        return {
          isEntry: true,
          reason: 'Has __main__ block',
          source: 'convention',
          confidence: 0.95
        };
      }
      if (options.metadata.isCelery) {
        return {
          isEntry: true,
          reason: 'Celery task file',
          source: 'diAnnotation',
          confidence: 0.9,
          isDynamic: true
        };
      }

      // Go frameworks
      if (options.metadata.hasMainFunction && options.metadata.isMainPackage) {
        return {
          isEntry: true,
          reason: 'Go main package with main()',
          source: 'convention',
          confidence: 0.95
        };
      }
      if (options.metadata.usesWire || options.metadata.usesFx || options.metadata.usesDig) {
        return {
          isEntry: true,
          reason: 'Uses Go DI framework',
          source: 'diAnnotation',
          confidence: 0.9,
          isDynamic: true
        };
      }

      // Java frameworks
      if (options.metadata.isSpringComponent) {
        return {
          isEntry: true,
          reason: 'Spring component',
          source: 'diAnnotation',
          confidence: 0.9,
          isDynamic: true
        };
      }

      // C# frameworks
      if (options.metadata.hasMainMethod || options.metadata.hasTopLevelStatements) {
        return {
          isEntry: true,
          reason: 'C# entry point',
          source: 'convention',
          confidence: 0.95
        };
      }
    }

    return { isEntry: false };
  }

  /**
   * Get all detected entry point files
   */
  getEntryPointFiles() {
    this.initialize();
    return this.result.getFiles();
  }

  /**
   * Get detailed entry point information
   */
  getEntryPointDetails() {
    this.initialize();
    return this.result.getAll();
  }

  /**
   * Get entry points grouped by source
   */
  getEntryPointsBySource() {
    this.initialize();
    return this.result.sources;
  }
}

/**
 * Create a detector with default configuration
 */
export function createEntryPointDetector(projectPath, packageJson = {}, options = {}) {
  return new EntryPointDetector({
    projectPath,
    packageJson,
    ...options
  });
}

/**
 * Quick check if a file is likely an entry point (without full initialization)
 */
export function isLikelyEntryPoint(filePath) {
  return matchesEntryPattern(filePath).matches;
}

export default {
  EntryPointDetector,
  createEntryPointDetector,
  isLikelyEntryPoint,
  DEFAULT_ENTRY_PATTERNS,
  DI_DECORATORS_BY_LANGUAGE
};
