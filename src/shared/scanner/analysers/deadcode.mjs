// src/scanner/analysers/deadcode.mjs
// Deep dead code detection with export-level analysis

import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { relative, dirname, basename, join, resolve, normalize } from 'path';
import { globSync } from 'glob';
import { getConfigDirsFromBuildSystems } from './buildSystems.mjs';
import { isGeneratedFile, filterGeneratedFiles } from './generatedCode.mjs';
import { collectConfigEntryPoints, isConfigEntry } from './configParsers.mjs';
import { createEntryPointDetector } from './entryPointDetector.mjs';

// Cache for nested package.json discoveries
let _nestedPackageCache = null;
let _nestedPackageCacheProjectPath = null;
let _dependedPackagesCache = null;

// Cache for extractPathAliases results (keyed by projectPath)
let _pathAliasesCache = null;
let _pathAliasesCacheProjectPath = null;

/**
 * Find all nested package.json files in a project (for monorepo support)
 * Returns a map of package directory -> package.json contents
 */
function findNestedPackageJsons(projectPath) {
  if (!projectPath) return new Map();

  // Use cached results if available for same project
  if (_nestedPackageCacheProjectPath === projectPath && _nestedPackageCache) {
    return _nestedPackageCache;
  }

  const packages = new Map();

  try {
    // 1. Look in common monorepo directories (hardcoded patterns)
    const monorepoPatterns = [
      'packages/*/package.json',
      'apps/*/package.json',
      'libs/*/package.json',
      'modules/*/package.json',
      'services/*/package.json',
      'plugins/*/package.json',
      // Nested packages (e.g., packages/scope/name)
      'packages/*/*/package.json',
      'apps/*/*/package.json',
      // General depth-2 discovery for collection repos (e.g., vercel/examples)
      // where each top-level dir has independent sub-projects with their own package.json
      '*/*/package.json'
    ];

    // Collect workspace exclusion patterns (e.g., "!apps/api" in pnpm-workspace.yaml)
    const wsExclusions = [];

    // 2. Read workspace configuration to discover ALL workspace packages
    // This covers AWS SDK (clients/), Azure SDK (sdk/**), etc.
    try {
      const rootPkgPath = join(projectPath, 'package.json');
      if (existsSync(rootPkgPath)) {
        const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
        const wsConfig = rootPkg.workspaces;
        const wsPatterns = Array.isArray(wsConfig) ? wsConfig : (wsConfig?.packages || []);
        for (const wp of wsPatterns) {
          const clean = wp.replace(/\/$/, '');
          if (clean.startsWith('!')) {
            wsExclusions.push(clean.slice(1)); // collect negation patterns
            continue;
          }
          monorepoPatterns.push(clean.endsWith('/package.json') ? clean : clean + '/package.json');
        }
      }
    } catch { /* ignore */ }

    // 3. Read pnpm-workspace.yaml
    try {
      const pnpmWsPath = join(projectPath, 'pnpm-workspace.yaml');
      if (existsSync(pnpmWsPath)) {
        const wsContent = readFileSync(pnpmWsPath, 'utf-8');
        const wsPatternRe = /^\s*-\s*['"]?([^'"#\n]+?)['"]?\s*$/gm;
        let wsMatch;
        while ((wsMatch = wsPatternRe.exec(wsContent)) !== null) {
          const clean = wsMatch[1].trim().replace(/\/$/, '');
          if (!clean) continue;
          if (clean.startsWith('!')) {
            wsExclusions.push(clean.slice(1)); // collect negation patterns
            continue;
          }
          monorepoPatterns.push(clean.endsWith('/package.json') ? clean : clean + '/package.json');
        }
      }
    } catch { /* ignore */ }

    // 4. Read lerna.json
    try {
      const lernaPath = join(projectPath, 'lerna.json');
      if (existsSync(lernaPath)) {
        const lerna = JSON.parse(readFileSync(lernaPath, 'utf-8'));
        for (const lp of (lerna.packages || [])) {
          const clean = lp.replace(/\/$/, '');
          monorepoPatterns.push(clean.endsWith('/package.json') ? clean : clean + '/package.json');
        }
      }
    } catch { /* ignore */ }

    // Deduplicate patterns
    const uniquePatterns = [...new Set(monorepoPatterns)];

    // Build exclusion matchers from workspace negation patterns (e.g., "!apps/api")
    const exclusionMatchers = wsExclusions.map(ex => {
      // Convert glob pattern to regex: apps/api → exact match, apps/* → wildcard
      const regexStr = ex.replace(/\./g, '\\.').replace(/\*\*/g, '<<<GLOBSTAR>>>').replace(/\*/g, '[^/]*').replace(/<<<GLOBSTAR>>>/g, '.*');
      return new RegExp('^' + regexStr + '$');
    });

    for (const pattern of uniquePatterns) {
      try {
        const matches = globSync(pattern, { cwd: projectPath, nodir: true, ignore: ['**/node_modules/**'] });
        for (const match of matches) {
          try {
            const pkgPath = join(projectPath, match);
            const pkgContent = JSON.parse(readFileSync(pkgPath, 'utf-8'));
            const pkgDir = dirname(match);
            // Skip packages excluded by workspace negation patterns (e.g., "!apps/api")
            if (exclusionMatchers.some(re => re.test(pkgDir))) continue;
            if (!packages.has(pkgDir)) {
              packages.set(pkgDir, pkgContent);
            }
          } catch {
            // Ignore individual package.json parse errors
          }
        }
      } catch {
        // Ignore glob errors
      }
    }
  } catch {
    // Ignore errors
  }

  _nestedPackageCache = packages;
  _nestedPackageCacheProjectPath = projectPath;

  // Also compute which packages are depended upon
  _dependedPackagesCache = new Set();
  for (const [, pkgJson] of packages) {
    const allDeps = {
      ...pkgJson.dependencies,
      ...pkgJson.devDependencies,
      ...pkgJson.peerDependencies
    };
    for (const depName of Object.keys(allDeps)) {
      _dependedPackagesCache.add(depName);
    }
  }
  // Also check root package.json
  try {
    const rootPkgPath = join(projectPath, 'package.json');
    if (existsSync(rootPkgPath)) {
      const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
      const rootDeps = {
        ...rootPkg.dependencies,
        ...rootPkg.devDependencies,
        ...rootPkg.peerDependencies
      };
      for (const depName of Object.keys(rootDeps)) {
        _dependedPackagesCache.add(depName);
      }
    }
  } catch {
    // Ignore root package.json errors
  }

  return packages;
}

/**
 * Check if a file is the main entry for a nested monorepo package
 * Only returns true if the package is depended upon by another package in the workspace
 * @param {string} filePath - Relative file path
 * @param {string} projectPath - Project root path
 * @returns {{ isMain: boolean, packageDir?: string, packageName?: string }}
 */
function isNestedPackageMain(filePath, projectPath) {
  if (!projectPath) return { isMain: false };

  const nestedPackages = findNestedPackageJsons(projectPath);

  for (const [pkgDir, pkgJson] of nestedPackages) {
    if (!filePath.startsWith(pkgDir + '/')) continue;

    // Check if this package is part of the ecosystem:
    // 1. It's depended upon by another package, OR
    // 2. It has dependencies on other internal packages (showing it's integrated)
    const pkgName = pkgJson.name;
    const pkgDeps = {
      ...pkgJson.dependencies,
      ...pkgJson.devDependencies,
      ...pkgJson.peerDependencies
    };

    // Check if any of this package's dependencies are internal packages
    const hasInternalDeps = Object.keys(pkgDeps).some(dep => {
      // Check if this dep is another package in the monorepo
      for (const [, otherPkg] of _nestedPackageCache || []) {
        if (otherPkg.name === dep) return true;
      }
      return false;
    });

    // If package is neither depended upon NOR has internal dependencies, it's potentially abandoned.
    // BUT: packages with main/module/source fields are likely published independently (e.g., Alpine plugins),
    // so only flag truly empty packages as abandoned.
    if (pkgName && !_dependedPackagesCache?.has(pkgName) && !hasInternalDeps) {
      const hasPublishableFields = pkgJson.main || pkgJson.module || pkgJson.source || pkgJson.exports;
      // Framework apps (Ember, Angular, etc.) are valid even without main/module/exports
      const isFrameworkApp = pkgJson.ember || pkgJson['ember-addon'] ||
        pkgJson.angular || pkgJson['ng-package'] ||
        (pkgJson.scripts && (pkgJson.scripts.start || pkgJson.scripts.dev || pkgJson.scripts.build));
      // Non-JS projects (Python, Go, Rust, etc.) with a minimal package.json for tooling
      const pkgAbsDir = join(projectPath, pkgDir);
      const isNonJsProject = ['pyproject.toml', 'setup.py', 'setup.cfg', 'go.mod', 'Cargo.toml',
        'build.gradle', 'pom.xml', 'Gemfile', 'mix.exs', 'Package.swift'].some(
        f => existsSync(join(pkgAbsDir, f)));
      if (!hasPublishableFields && !isFrameworkApp && !isNonJsProject) {
        return { isMain: false, isAbandoned: true };
      }
    }

    // Check if this file is the package's main entry
    if (pkgJson.main) {
      const mainPath = join(pkgDir, pkgJson.main.replace(/^\.\//, ''));
      if (filePath === mainPath) {
        return { isMain: true, packageDir: pkgDir, packageName: pkgName };
      }
      // When main points to a directory (e.g., "./lib"), resolve to dir/index.{js,ts,...}
      if (!mainPath.match(/\.\w+$/)) {
        for (const ext of ['.js', '.ts', '.tsx', '.mjs', '.jsx']) {
          if (filePath === mainPath + '/index' + ext) {
            return { isMain: true, packageDir: pkgDir, packageName: pkgName };
          }
        }
      }
    }

    // Check source field (explicit source entry point)
    if (pkgJson.source) {
      const sourcePath = join(pkgDir, pkgJson.source.replace(/^\.\//, ''));
      if (filePath === sourcePath) {
        return { isMain: true, packageDir: pkgDir, packageName: pkgName };
      }
    }

    // Check module field (ESM entry)
    if (pkgJson.module) {
      const modulePath = join(pkgDir, pkgJson.module.replace(/^\.\//, ''));
      if (filePath === modulePath) {
        return { isMain: true, packageDir: pkgDir, packageName: pkgName };
      }
    }

    // Check types/typings field (.d.ts declaration entry)
    for (const typesField of [pkgJson.types, pkgJson.typings].filter(Boolean)) {
      const typesPath = join(pkgDir, typesField.replace(/^\.\//, ''));
      if (filePath === typesPath) {
        return { isMain: true, packageDir: pkgDir, packageName: pkgName };
      }
    }

    // When main/module points to build output (lib/, dist/, build/, out/),
    // map back to source (src/) since we analyze source files, not build output
    const _buildDirRe = /^(lib|dist|dist-\w+|build|out)\//;
    // Known build output format subdirs (tshy, tsup, etc.) — dist/commonjs/ → src/, dist/esm/ → src/
    const _formatSubdirRe = /^(dist|dist-\w+)\/(commonjs|cjs|esm|browser|react-native|workerd|node|default|types)\//;
    const _srcExts = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx'];
    let hasBuildDirFields = false;
    for (const field of [pkgJson.main, pkgJson.module].filter(Boolean)) {
      const fieldPath = field.replace(/^\.\//, '');
      if (_buildDirRe.test(fieldPath)) {
        hasBuildDirFields = true;
        // Map lib/framework.js → src/framework.ts etc.
        // Also handle dist/commonjs/index.js → src/index.ts (strip format subdir)
        const stems = [fieldPath.replace(_buildDirRe, 'src/').replace(/\.[mc]?[jt]sx?$/, '')];
        if (_formatSubdirRe.test(fieldPath)) {
          stems.push(fieldPath.replace(_formatSubdirRe, 'src/').replace(/\.[mc]?[jt]sx?$/, ''));
        }
        for (const stem of stems) {
          for (const ext of _srcExts) {
            const candidate = join(pkgDir, stem + ext);
            if (filePath === candidate) {
              return { isMain: true, packageDir: pkgDir, packageName: pkgName };
            }
          }
        }
      }
    }

    // When main/module points to build output, check ALL common src entry points as entries.
    // Multiple build entries are common (e.g., framework.ts + entry-bundler.ts in vuetify).
    if (hasBuildDirFields) {
      for (const entry of ['src/index', 'src/main', 'src/entry-bundler', 'src/entry']) {
        for (const ext of _srcExts) {
          const candidate = join(pkgDir, entry + ext);
          if (filePath === candidate) {
            return { isMain: true, packageDir: pkgDir, packageName: pkgName };
          }
        }
      }
    }

    // Workspace fallback: when no main/module field exists, treat src/index.{ts,tsx,js} as entry
    if (!pkgJson.main && !pkgJson.module) {
      for (const entry of ['src/index', 'src/main', 'src/app', 'index', 'main', 'app']) {
        for (const ext of _srcExts) {
          const candidate = join(pkgDir, entry + ext);
          if (filePath === candidate) {
            return { isMain: true, packageDir: pkgDir, packageName: pkgName };
          }
        }
      }
    }

    // Check exports field
    if (pkgJson.exports) {
      const checkExport = (exp, key) => {
        if (typeof exp === 'string') {
          // Handle wildcard exports: "./icons/*" → "./lib/icons/*.mjs"
          if (key && key.includes('*') && exp.includes('*')) {
            return _checkWildcardExport(filePath, pkgDir, key, exp, _buildDirRe, _srcExts);
          }
          const expPath = join(pkgDir, exp.replace(/^\.\//, ''));
          if (filePath === expPath) return true;
          // Also check source equivalent for build-dir exports
          const cleanExp = exp.replace(/^\.\//, '');
          if (_buildDirRe.test(cleanExp)) {
            const stems = [cleanExp.replace(_buildDirRe, 'src/').replace(/\.[mc]?[jt]sx?$/, '')];
            // Also strip format subdir: dist/commonjs/index.js → src/index.ts
            if (_formatSubdirRe.test(cleanExp)) {
              stems.push(cleanExp.replace(_formatSubdirRe, 'src/').replace(/\.[mc]?[jt]sx?$/, ''));
            }
            for (const stem of stems) {
              for (const ext of _srcExts) {
                if (filePath === join(pkgDir, stem + ext)) return true;
              }
            }
          }
        } else if (exp && typeof exp === 'object') {
          for (const [k, value] of Object.entries(exp)) {
            if (checkExport(value, key || k)) return true;
          }
        }
        return false;
      };
      for (const [key, value] of Object.entries(pkgJson.exports)) {
        if (checkExport(value, key)) {
          return { isMain: true, packageDir: pkgDir, packageName: pkgName };
        }
      }
    }

    // File is in this package but not its main entry — still return the packageDir
    // so callers can check entry point patterns relative to the package root
    return { isMain: false, packageDir: pkgDir, packageName: pkgName };
  }

  return { isMain: false };
}

/**
 * Check if a file matches a wildcard export pattern.
 * e.g., key="./icons/*", value="./lib/icons/*.mjs" → match src/icons/Home.tsx
 */
function _checkWildcardExport(filePath, pkgDir, key, value, _buildDirRe, _srcExts) {
  // Extract the directory part from the value pattern
  const cleanValue = value.replace(/^\.\//, '');
  // Convert wildcard pattern to a directory prefix: "lib/icons/*.mjs" → "lib/icons/"
  const starIdx = cleanValue.indexOf('*');
  if (starIdx < 0) return false;
  const valuePrefix = cleanValue.substring(0, starIdx);
  const valueSuffix = cleanValue.substring(starIdx + 1);
  // Map build dir to src dir
  const srcPrefix = _buildDirRe.test(valuePrefix)
    ? valuePrefix.replace(_buildDirRe, 'src/')
    : valuePrefix;
  // Check if filePath matches: pkgDir/srcPrefix + name + srcExt
  const relPath = filePath.startsWith(pkgDir + '/') ? filePath.slice(pkgDir.length + 1) : null;
  if (!relPath) return false;
  if (!relPath.startsWith(srcPrefix)) {
    // Also try the original (non-mapped) prefix for non-build-dir exports
    if (!relPath.startsWith(valuePrefix)) return false;
  }
  // Extract the file name part after the prefix, check extension
  const afterPrefix = relPath.startsWith(srcPrefix) ? relPath.slice(srcPrefix.length) : relPath.slice(valuePrefix.length);
  // It should be a single filename (no deeper nesting) with a source extension
  if (afterPrefix.includes('/')) return false;
  const extMatch = afterPrefix.match(/\.[^.]+$/);
  if (!extMatch) return false;
  const ext = extMatch[0];
  // Accept any source extension
  if (_srcExts.includes(ext) || ext === '.mjs' || ext === '.cjs' || ext === '.js') return true;
  return false;
}

/**
 * Extract path aliases from tsconfig.json and vite.config.ts
 * Returns a map of package directory -> Map of alias prefix -> resolved path
 * For monorepos, each package can have its own @/ alias
 * e.g., { '': { '@/': 'src/' }, 'packages/cli': { '@/': 'packages/cli/src/' } }
 */
// Recursively resolve export targets from conditional exports
// Handles nested conditions like { browser: { import: "./dist/solid.js" }, node: { import: "./dist/server.js" } }
// and direct source pointers like { code: "./src/index.ts", default: "./dist/index.js" }
function _resolveExportTarget(target) {
  if (typeof target === 'string') return target;
  if (typeof target !== 'object' || target === null) return null;
  // Priority: code/source (direct source pointers), then import, require, module, default
  for (const key of ['code', 'source', 'import', 'require', 'module', 'default']) {
    const val = target[key];
    if (typeof val === 'string') return val;
    if (typeof val === 'object' && val !== null) {
      const resolved = _resolveExportTarget(val);
      if (resolved) return resolved;
    }
  }
  // Try any other keys (browser, node, worker, deno, development, etc.)
  for (const [key, val] of Object.entries(target)) {
    if (key === 'types') continue; // Skip type-only fields
    const resolved = _resolveExportTarget(val);
    if (resolved) return resolved;
  }
  return null;
}

// Collect ALL unique export paths from conditional exports (for entry point marking)
// Different conditions may point to different source files (e.g., browser vs node)
function _collectAllExportPaths(target, paths = new Set()) {
  if (typeof target === 'string') { paths.add(target); return paths; }
  if (typeof target !== 'object' || target === null) return paths;
  for (const [key, val] of Object.entries(target)) {
    if (key === 'types') continue;
    _collectAllExportPaths(val, paths);
  }
  return paths;
}

function extractPathAliases(projectPath) {
  // Return cached result if available for same projectPath
  if (_pathAliasesCacheProjectPath === projectPath && _pathAliasesCache) {
    return _pathAliasesCache;
  }

  const aliases = new Map();  // Global aliases (from root)
  const packageAliases = new Map();  // Per-package aliases: packageDir -> Map<alias, target>

  if (!projectPath) return { aliases, packageAliases, packageBaseUrls: new Map(), workspacePackages: new Map(), goModulePath: null, javaSourceRoots: [] };

  // Check for config files in root and common subdirectories
  // For monorepos like client/server structure
  const configDirs = [
    { dir: '', prefix: '' },
    { dir: 'client', prefix: 'client/' },
    { dir: 'app', prefix: 'app/' },
    { dir: 'web', prefix: 'web/' },
    { dir: 'frontend', prefix: 'frontend/' },
    { dir: 'server', prefix: 'server/' },
    { dir: 'api', prefix: 'api/' },
    { dir: 'backend', prefix: 'backend/' },
    { dir: 'core', prefix: 'core/' },
    { dir: 'shared', prefix: 'shared/' },
    { dir: 'common', prefix: 'common/' },
  ];

  // Detect workspace directories from monorepo config files
  const workspaceDirs = new Set();

  // Resolve a workspace glob pattern like "packages/*", "packages/*/*",
  // "examples/*/src/plugins/*", or "libs/**" by walking the filesystem
  const resolveWorkspaceGlob = (pattern) => {
    const segments = pattern.split('/');
    const walk = (currentPath, segIndex) => {
      if (segIndex >= segments.length) {
        workspaceDirs.add(currentPath);
        return;
      }
      const seg = segments[segIndex];
      if (seg === '**') {
        // Recursive glob: add current + all nested subdirectories
        if (currentPath) workspaceDirs.add(currentPath);
        const addRecursive = (dir, depth) => {
          if (depth > 5) return;
          const fullPath = join(projectPath, dir);
          try {
            const entries = readdirSync(fullPath, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                const subDir = `${dir}/${entry.name}`;
                workspaceDirs.add(subDir);
                addRecursive(subDir, depth + 1);
              }
            }
          } catch {}
        };
        addRecursive(currentPath || '.', 0);
      } else if (seg === '*') {
        // Single-level glob: enumerate subdirectories and continue with remaining segments
        const dirToRead = currentPath || '.';
        const fullPath = join(projectPath, dirToRead);
        try {
          const entries = readdirSync(fullPath, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
              const subDir = currentPath ? `${currentPath}/${entry.name}` : entry.name;
              walk(subDir, segIndex + 1);
            }
          }
        } catch {}
      } else {
        // Fixed segment: append and continue
        const next = currentPath ? `${currentPath}/${seg}` : seg;
        walk(next, segIndex + 1);
      }
    };
    walk('', 0);
  };

  // 1. Check package.json workspaces (npm/yarn workspaces)
  const rootPkgPath = join(projectPath, 'package.json');
  if (existsSync(rootPkgPath)) {
    try {
      const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
      const workspaces = rootPkg.workspaces;
      if (workspaces) {
        // Workspaces can be array or object with packages property
        const patterns = Array.isArray(workspaces) ? workspaces : (workspaces.packages || []);
        for (const pattern of patterns) {
          if (pattern.includes('*')) {
            resolveWorkspaceGlob(pattern);
          } else {
            // Direct workspace path (no glob) like "www", "www/og-image"
            const dir = pattern.replace(/\/$/, '');
            if (dir) {
              workspaceDirs.add(dir);
            }
          }
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  // 2. Check pnpm-workspace.yaml (pnpm workspaces)
  const pnpmWorkspacePath = join(projectPath, 'pnpm-workspace.yaml');
  if (existsSync(pnpmWorkspacePath)) {
    try {
      const content = readFileSync(pnpmWorkspacePath, 'utf-8');
      // Simple YAML parsing for packages array
      const packagesMatch = content.match(/packages:\s*\n((?:\s+-\s+[^\n]+\n?)*)/);
      if (packagesMatch) {
        const lines = packagesMatch[1].split('\n');
        for (const line of lines) {
          const match = line.match(/^\s*-\s+['"]?([^'"#\n]+)['"]?/);
          if (match) {
            const pattern = match[1].trim();
            if (pattern.includes('*')) {
              resolveWorkspaceGlob(pattern);
            } else {
              // Direct workspace path (no glob) like "www", "www/og-image"
              const dir = pattern.replace(/\/$/, '');
              if (dir) {
                workspaceDirs.add(dir);
              }
            }
          }
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  // 3. Check lerna.json (Lerna monorepos)
  const lernaPath = join(projectPath, 'lerna.json');
  if (existsSync(lernaPath)) {
    try {
      const lerna = JSON.parse(readFileSync(lernaPath, 'utf-8'));
      for (const pattern of lerna.packages || ['packages/*']) {
        if (pattern.includes('*')) {
          resolveWorkspaceGlob(pattern);
        } else {
          const dir = pattern.replace(/\/$/, '');
          if (dir) workspaceDirs.add(dir);
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  // 4. Check nx.json / workspace.json (Nx monorepos)
  const nxPath = join(projectPath, 'nx.json');
  const workspaceJsonPath = join(projectPath, 'workspace.json');
  if (existsSync(nxPath) || existsSync(workspaceJsonPath)) {
    // Nx typically uses apps/, libs/, packages/, tools/
    for (const dir of ['apps', 'libs', 'packages', 'tools', 'services']) {
      resolveWorkspaceGlob(dir + '/*');
    }
  }

  // 5. Check rush.json (Rush monorepos - Microsoft)
  const rushPath = join(projectPath, 'rush.json');
  if (existsSync(rushPath)) {
    try {
      // Rush JSON has comments, strip them
      const content = readFileSync(rushPath, 'utf-8');
      const cleaned = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
      const rush = JSON.parse(cleaned);
      for (const project of rush.projects || []) {
        if (project.projectFolder) {
          const dir = dirname(project.projectFolder);
          if (dir && dir !== '.') {
            resolveWorkspaceGlob(dir + '/*');
          }
          workspaceDirs.add(project.projectFolder);
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  // 6. Common monorepo directory patterns (fallback)
  const commonDirs = ['packages', 'libs', 'apps', 'modules', 'services', 'tools', 'plugins', 'extensions'];
  for (const dir of commonDirs) {
    resolveWorkspaceGlob(dir + '/*');
  }

  // 7. Auto-detect standalone sub-projects with their own tsconfig.json/package.json
  // These are directories like companion/, admin/, dashboard/ that aren't in workspace config
  // but have their own TypeScript configuration with path aliases
  try {
    const topLevelEntries = readdirSync(projectPath, { withFileTypes: true });
    for (const entry of topLevelEntries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        const dirName = entry.name;
        // Skip directories we already handle
        if (workspaceDirs.has(dirName) || commonDirs.includes(dirName)) continue;
        // Check if this directory has its own tsconfig.json (indicating it's a sub-project)
        const hasTsconfig = existsSync(join(projectPath, dirName, 'tsconfig.json'));
        const hasPkgJson = existsSync(join(projectPath, dirName, 'package.json'));
        if (hasTsconfig || hasPkgJson) {
          workspaceDirs.add(dirName);
        }
      }
    }
  } catch {
    // Ignore errors
  }

  // 8. Enterprise build systems (Gradle, Maven, Bazel, Cargo, Go, .NET, etc.)
  try {
    const buildSystemDirs = getConfigDirsFromBuildSystems(projectPath);
    for (const { dir } of buildSystemDirs) {
      if (dir && !workspaceDirs.has(dir)) {
        workspaceDirs.add(dir);
      }
    }
  } catch {
    // Ignore build system detection errors
  }

  // 9. Nested workspace discovery — sub-projects may define their own workspaces
  // e.g., streamlit's frontend/package.json has workspaces: ["app", "lib", "connection", ...]
  // which resolve to frontend/app, frontend/lib, frontend/connection, etc.
  const nestedQueue = [...workspaceDirs];
  for (const parentDir of nestedQueue) {
    const nestedPkgPath = join(projectPath, parentDir, 'package.json');
    if (!existsSync(nestedPkgPath)) continue;
    try {
      const nestedPkg = JSON.parse(readFileSync(nestedPkgPath, 'utf-8'));
      const nestedWs = nestedPkg.workspaces;
      if (!nestedWs) continue;
      const patterns = Array.isArray(nestedWs) ? nestedWs : (nestedWs.packages || []);
      for (const pattern of patterns) {
        // Resolve workspace paths relative to the parent directory
        const fullPattern = `${parentDir}/${pattern.replace(/\/$/, '')}`;
        if (fullPattern.includes('*')) {
          resolveWorkspaceGlob(fullPattern);
        } else if (!workspaceDirs.has(fullPattern)) {
          workspaceDirs.add(fullPattern);
          nestedQueue.push(fullPattern);
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Add all discovered workspace directories
  for (const wsDir of workspaceDirs) {
    configDirs.push({ dir: wsDir, prefix: `${wsDir}/` });
  }

  // Build workspace package map: package name -> { dir, entryPoint }
  // This allows resolving imports like '@n8n/rest-api-client' to local workspace packages
  const workspacePackages = new Map();
  for (const wsDir of workspaceDirs) {
    const pkgJsonPath = join(projectPath, wsDir, 'package.json');
    if (existsSync(pkgJsonPath)) {
      try {
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
        if (pkgJson.name) {
          // Determine entry point - check various fields
          let entryPoint = 'src/index';

          // Check exports field first (modern packages)
          if (pkgJson.exports) {
            const mainExport = pkgJson.exports['.'];
            if (mainExport) {
              const exportPath = _resolveExportTarget(mainExport);
              if (exportPath) {
                // Convert dist path to src path (handles dist/, dist-cjs/, dist-es/, dist/commonjs/, etc.)
                entryPoint = exportPath
                  .replace(/^\.\//, '')
                  .replace(/^(dist-\w+|dist)\/(commonjs|cjs|esm|browser|react-native|workerd|node|default|types)\//, 'src/')
                  .replace(/^(dist-\w+|dist|lib|build|out)\//, 'src/')
                  .replace(/\.(c|m)?js$/, '')
                  .replace(/\.d\.(c|m)?ts$/, '');
              }
            }
          }
          // Fallback to module/main fields
          else if (pkgJson.module) {
            entryPoint = pkgJson.module.replace(/^\.\//, '')
              .replace(/^(dist-\w+|dist)\/(commonjs|cjs|esm|browser|react-native|workerd|node|default|types)\//, 'src/')
              .replace(/^(dist-\w+|dist|lib|build|out)\//, 'src/')
              .replace(/\.(c|m)?js$/, '');
          } else if (pkgJson.main) {
            entryPoint = pkgJson.main.replace(/^\.\//, '')
              .replace(/^(dist-\w+|dist)\/(commonjs|cjs|esm|browser|react-native|workerd|node|default|types)\//, 'src/')
              .replace(/^(dist-\w+|dist|lib|build|out)\//, 'src/')
              .replace(/\.(c|m)?js$/, '');
          }

          // Build subpath exports map from package.json exports field
          // Maps subpath (e.g., "strapi-server") to raw dist path for later resolution
          // Uses _resolveExportTarget to handle nested conditional exports
          const exportsMap = new Map();
          if (pkgJson.exports && typeof pkgJson.exports === 'object') {
            for (const [subpath, target] of Object.entries(pkgJson.exports)) {
              if (subpath === '.' || subpath === './package.json') continue;
              const exportTarget = _resolveExportTarget(target);
              if (typeof exportTarget === 'string') {
                const rawPath = exportTarget.replace(/^\.\//, '').replace(/\.(c|m)?js$/, '').replace(/\.d\.(c|m)?ts$/, '');
                exportsMap.set(subpath.replace(/^\.\//, ''), rawPath);
              }
            }
          }

          workspacePackages.set(pkgJson.name, {
            dir: wsDir,
            entryPoint: entryPoint,
            exportsMap: exportsMap
          });
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  // Store baseUrl per directory for resolving bare imports
  const packageBaseUrls = new Map();

  for (const { dir, prefix } of configDirs) {
    const configDir = dir ? join(projectPath, dir) : projectPath;
    if (dir && !existsSync(configDir)) continue;

    // Create a map for this package's aliases
    const dirAliases = new Map();

    // Try tsconfig.json in this directory
    // Include tsconfig.base.json which Nx uses for workspace-wide path aliases
    const tsconfigFiles = ['tsconfig.json', 'tsconfig.base.json', 'tsconfig.app.json', 'jsconfig.json'];

    /**
     * Recursively read tsconfig and follow extends chain.
     * Returns paths with targets already resolved to project-relative form,
     * so callers don't need to apply directory prefix or baseUrl.
     * @param {string} tsconfigPath - Path to tsconfig file
     * @param {Set} visited - Set of already visited configs to prevent cycles
     * @returns {{ resolvedPaths: Map<string, string>, rawPaths: Object, baseUrl: string }}
     */
    const readTsconfigWithExtends = (tsconfigPath, visited = new Set()) => {
      if (visited.has(tsconfigPath) || !existsSync(tsconfigPath)) {
        return { resolvedPaths: new Map(), rawPaths: {}, baseUrl: '.' };
      }
      visited.add(tsconfigPath);

      try {
        const content = readFileSync(tsconfigPath, 'utf-8');
        // Remove comments (tsconfig allows them) but NOT inside strings
        // First, temporarily replace string contents to protect them
        const stringPlaceholders = [];
        const contentWithPlaceholders = content.replace(/"(?:[^"\\]|\\.)*"/g, (match) => {
          stringPlaceholders.push(match);
          return `"__STRING_${stringPlaceholders.length - 1}__"`;
        });
        // Now remove comments
        const withoutComments = contentWithPlaceholders.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
        // Restore strings
        const cleaned = withoutComments.replace(/"__STRING_(\d+)__"/g, (_, idx) => stringPlaceholders[parseInt(idx)]);
        const tsconfig = JSON.parse(cleaned);

        // Compute project-relative prefix for this tsconfig's directory
        const tsconfigDir = dirname(tsconfigPath);
        let relDir = relative(projectPath, tsconfigDir).replace(/\\/g, '/');
        const tsconfigPrefix = relDir ? relDir + '/' : '';

        // Start with inherited resolved paths from extends
        let inheritedResolvedPaths = new Map();

        if (tsconfig.extends) {
          // TypeScript 5.0+ supports array extends - process each one
          const extendsArray = Array.isArray(tsconfig.extends) ? tsconfig.extends : [tsconfig.extends];

          for (const extendsValue of extendsArray) {
            if (typeof extendsValue !== 'string') continue;

            let extendsPath;

            if (extendsValue.startsWith('.')) {
              // Relative path - resolve from current tsconfig's directory
              extendsPath = join(dirname(tsconfigPath), extendsValue);
              // Add .json if not present
              if (!extendsPath.endsWith('.json')) {
                extendsPath += '.json';
              }
            } else if (extendsValue.startsWith('@') || !extendsValue.includes('/')) {
              // Package reference like "@tsconfig/node20" or "tsconfig/recommended"
              // Try to resolve from node_modules
              const nodeModulesPath = join(projectPath, 'node_modules', extendsValue);
              if (existsSync(nodeModulesPath)) {
                extendsPath = existsSync(join(nodeModulesPath, 'tsconfig.json'))
                  ? join(nodeModulesPath, 'tsconfig.json')
                  : nodeModulesPath;
              }
            } else {
              // Absolute-ish path
              extendsPath = join(dirname(tsconfigPath), extendsValue);
              if (!extendsPath.endsWith('.json')) {
                extendsPath += '.json';
              }
            }

            if (extendsPath && existsSync(extendsPath)) {
              const inherited = readTsconfigWithExtends(extendsPath, visited);
              // Merge inherited resolved paths (later extends override earlier)
              // Inherited paths are already project-relative from the recursive call
              for (const [alias, target] of inherited.resolvedPaths) {
                inheritedResolvedPaths.set(alias, target);
              }
            }
          }
        }

        // Resolve current config's paths to project-relative form
        const currentPaths = tsconfig.compilerOptions?.paths || {};
        const currentBaseUrl = tsconfig.compilerOptions?.baseUrl;

        for (const [alias, targets] of Object.entries(currentPaths)) {
          if (targets && targets.length > 0) {
            const aliasPrefix = alias.replace(/\*$/, '');
            let targetPath = targets[0].replace(/\*$/, '').replace(/^\.\//, '');

            // Combine with baseUrl if not absolute
            if (currentBaseUrl && currentBaseUrl !== '.') {
              targetPath = join(currentBaseUrl.replace(/^\.\//, ''), targetPath);
            }

            // Apply this tsconfig's project-relative prefix
            targetPath = tsconfigPrefix + targetPath;

            // Normalize paths with ../
            if (targetPath.includes('..')) {
              targetPath = normalize(targetPath).replace(/\\/g, '/');
            }

            // Only add trailing slash for directory-style aliases (those that had *)
            // But not for empty targetPath (maps to project root, e.g. "@/*": ["./*"])
            const isDirectoryAlias = alias.endsWith('*') || targets[0].endsWith('*');
            if (isDirectoryAlias && targetPath && !targetPath.endsWith('/')) targetPath += '/';

            // Current config overrides inherited
            inheritedResolvedPaths.set(aliasPrefix, targetPath);
          }
        }

        return {
          resolvedPaths: inheritedResolvedPaths,
          rawPaths: { ...Object.fromEntries([...inheritedResolvedPaths]), ...currentPaths },
          baseUrl: currentBaseUrl || '.'
        };
      } catch (e) {
        return { resolvedPaths: new Map(), rawPaths: {}, baseUrl: '.' };
      }
    };

    for (const tsconfigFile of tsconfigFiles) {
      const tsconfigPath = join(configDir, tsconfigFile);
      if (existsSync(tsconfigPath)) {
        try {
          const { resolvedPaths, baseUrl } = readTsconfigWithExtends(tsconfigPath);

          // resolvedPaths are already project-relative (prefix and baseUrl applied
          // at each level of the extends chain)
          for (const [aliasPrefix, targetPath] of resolvedPaths) {
            dirAliases.set(aliasPrefix, targetPath);
            // Also add to global aliases for backwards compatibility
            if (!aliases.has(aliasPrefix)) {
              aliases.set(aliasPrefix, targetPath);
            }
          }

          // Store baseUrl for this directory (project-relative)
          // e.g., baseUrl: "." in apps/studio/tsconfig.json -> "apps/studio/"
          // For root tsconfig (dir=''), baseUrl: "." means project root -> prefix ""
          if (baseUrl) {
            const baseUrlPrefix = baseUrl === '.'
              ? prefix
              : prefix + baseUrl.replace(/^\.\//, '').replace(/\/$/, '') + '/';
            // Use dir or empty string for root
            packageBaseUrls.set(dir || '', baseUrlPrefix);
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
    }

    // Also try vite.config.ts/js in this directory
    const viteConfigFiles = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs'];

    for (const viteConfigFile of viteConfigFiles) {
      const viteConfigPath = join(configDir, viteConfigFile);
      if (existsSync(viteConfigPath)) {
        try {
          const content = readFileSync(viteConfigPath, 'utf-8');

          // Look for resolve.alias patterns
          // Common patterns:
          // '@': path.resolve(__dirname, './src')
          // '@/': '/src/'
          // alias: { '@': ... }

          const aliasPatterns = [
            // '@': path.resolve(..., './src') or '@': './src'
            /['"](@[^'"]*)['"]\s*:\s*(?:path\.resolve\s*\([^)]*,\s*)?['"]\.?\/?(src[^'"]*)['"]/g,
            // alias: { '@': ... }
            /['"](@\/?)['"].*?['"]\.?\/?([^'"]+)['"]/g
          ];

          for (const pattern of aliasPatterns) {
            let match;
            while ((match = pattern.exec(content)) !== null) {
              let alias = match[1];
              let target = match[2];

              // Normalize alias to end with /
              if (!alias.endsWith('/')) alias += '/';
              // Normalize target and add prefix
              target = prefix + target.replace(/^\.\//, '').replace(/\/$/, '') + '/';

              if (!dirAliases.has(alias)) {
                dirAliases.set(alias, target);
              }
              if (!aliases.has(alias)) {
                aliases.set(alias, target);
              }
            }
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
    }

    // Store per-package aliases if any were found
    if (dirAliases.size > 0 && dir) {
      packageAliases.set(dir, dirAliases);
    }
  }

  // Common defaults if nothing found
  if (aliases.size === 0) {
    // Check for client/src pattern first (more specific)
    if (existsSync(join(projectPath, 'client', 'src'))) {
      aliases.set('@/', 'client/src/');
    }
    // Check if src/ directory exists, assume @/ -> src/
    else if (existsSync(join(projectPath, 'src'))) {
      aliases.set('@/', 'src/');
    }
  }

  // Detect Docusaurus @site alias
  // Docusaurus injects @site as an alias to the documentation root (where docusaurus.config.* lives)
  // Check both workspace dirs and common documentation directory names
  const docusaurusFiles = ['docusaurus.config.js', 'docusaurus.config.ts', 'docusaurus.config.mjs'];
  const docDirsToCheck = new Set(configDirs.map(d => d.dir));
  // Also check common documentation directories that may not be workspace packages
  for (const docDir of ['docs', 'documentation', 'website', 'doc']) {
    if (existsSync(join(projectPath, docDir))) {
      docDirsToCheck.add(docDir);
    }
  }
  for (const dir of docDirsToCheck) {
    const configDir = dir ? join(projectPath, dir) : projectPath;
    const hasDocusaurus = docusaurusFiles.some(f => existsSync(join(configDir, f)));
    if (hasDocusaurus) {
      const prefix = dir ? dir + '/' : '';
      const siteAlias = '@site/';
      if (dir) {
        if (!packageAliases.has(dir)) {
          packageAliases.set(dir, new Map());
        }
        packageAliases.get(dir).set(siteAlias, prefix);
      } else {
        aliases.set(siteAlias, '');
      }
      // Ensure this dir is in configDirs so its tsconfig gets read too
      if (!configDirs.some(d => d.dir === dir)) {
        configDirs.push({ dir, prefix });
      }
    }
  }

  // Parse go.mod for Go module path (used for import resolution)
  let goModulePath = null;
  const goModPath = join(projectPath, 'go.mod');
  if (existsSync(goModPath)) {
    try {
      const goModContent = readFileSync(goModPath, 'utf8');
      const moduleMatch = goModContent.match(/^module\s+(\S+)/m);
      if (moduleMatch) {
        goModulePath = moduleMatch[1];
      }
    } catch {
      // Ignore read errors
    }
  }

  // Detect Java/Kotlin source roots (Maven/Gradle conventions)
  // These help resolve package imports like com.example.Service -> src/main/java/com/example/Service.java
  const javaSourceRoots = [];
  const javaSourceRootCandidates = [
    'src/main/java',
    'src/test/java',
    'src/main/kotlin',
    'src/test/kotlin',
  ];

  // Check for source roots in the project root and in submodules/subprojects
  const checkJavaDir = (baseDir, prefix) => {
    for (const candidate of javaSourceRootCandidates) {
      const fullCandidate = join(baseDir, candidate);
      try {
        if (statSync(fullCandidate).isDirectory()) {
          javaSourceRoots.push(prefix ? prefix + '/' + candidate : candidate);
        }
      } catch {}
    }
  };
  // Check root
  checkJavaDir(projectPath, '');
  // Check subdirectories up to 3 levels deep (for multi-module Maven/Gradle projects)
  // e.g. spring-boot-project/spring-boot/src/main/java
  try {
    for (const entry of readdirSync(projectPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      checkJavaDir(join(projectPath, entry.name), entry.name);
      try {
        for (const subEntry of readdirSync(join(projectPath, entry.name), { withFileTypes: true })) {
          if (!subEntry.isDirectory() || subEntry.name.startsWith('.')) continue;
          checkJavaDir(join(projectPath, entry.name, subEntry.name), entry.name + '/' + subEntry.name);
          try {
            for (const sub2Entry of readdirSync(join(projectPath, entry.name, subEntry.name), { withFileTypes: true })) {
              if (!sub2Entry.isDirectory() || sub2Entry.name.startsWith('.')) continue;
              checkJavaDir(join(projectPath, entry.name, subEntry.name, sub2Entry.name), entry.name + '/' + subEntry.name + '/' + sub2Entry.name);
            }
          } catch {}
        }
      } catch {}
    }
  } catch {}

  const result = { aliases, packageAliases, packageBaseUrls, workspacePackages, goModulePath, javaSourceRoots };
  _pathAliasesCache = result;
  _pathAliasesCacheProjectPath = projectPath;
  return result;
}

// Handle both ESM and CJS default exports from @babel/traverse
const traverse = _traverse.default || _traverse;

// Dynamic patterns from config - files matching these are NOT dead (dynamically loaded)
let DYNAMIC_PATTERNS = [];
let DYNAMIC_PATTERN_SOURCES = [];

/**
 * Set dynamic patterns from config
 * @param {string[]} patterns - Glob patterns for dynamically loaded files
 */
export function setDynamicPatterns(patterns) {
  DYNAMIC_PATTERN_SOURCES = patterns;
  DYNAMIC_PATTERNS = patterns.map(p => {
    // Convert glob to regex
    const regex = p
      .replace(/\*\*/g, '<<<GLOBSTAR>>>')
      .replace(/\*/g, '[^/]*')
      .replace(/<<<GLOBSTAR>>>/g, '.*')
      .replace(/\./g, '\\.')
      .replace(/\?/g, '.');
    return new RegExp(regex);
  });
}

// DI (Dependency Injection) patterns for detecting framework-injected classes
let DI_DECORATORS = new Set();
let DI_CONTAINER_PATTERNS = [];

/**
 * Set DI patterns from config
 * @param {string[]} decorators - Decorator names that mark classes as DI entry points
 * @param {string[]} containerPatterns - Regex patterns for DI container access
 */
export function setDIPatterns(decorators = [], containerPatterns = []) {
  DI_DECORATORS = new Set(decorators);
  DI_CONTAINER_PATTERNS = containerPatterns.map(p => new RegExp(p));
}

/**
 * Check if a class has DI decorators that make it an entry point
 * @param {Object} classInfo - Parsed class info with decorators array
 * @returns {{ hasDI: boolean, decorators: string[] }}
 */
function hasDIDecorators(classInfo) {
  if (!classInfo?.decorators?.length) return { hasDI: false, decorators: [] };

  const matched = [];

  for (const decorator of classInfo.decorators) {
    const name = decorator.name;

    // Standard DI decorators (NestJS @Controller, @Module, etc.)
    if (DI_DECORATORS.has(name)) {
      matched.push(name);
      continue;
    }

    // Special case: Angular @Injectable({ providedIn: 'root' }) or providedIn: 'any'
    // These are tree-shakeable singletons that are auto-registered
    if (name === 'Injectable' && decorator.args) {
      const providedIn = decorator.args.providedIn;
      if (providedIn === 'root' || providedIn === 'any' || providedIn === 'platform') {
        matched.push(`Injectable(providedIn: '${providedIn}')`);
        continue;
      }
    }

    // Special case: NestJS @Injectable() with useFactory/useClass in module
    // Note: Basic @Injectable() without providedIn is NOT an entry point
    // It requires registration in a module's providers array
  }

  return { hasDI: matched.length > 0, decorators: matched };
}

/**
 * Extract class names referenced via DI container access patterns
 * e.g., Container.get(MyService), container.resolve<IService>(ServiceImpl)
 * @param {string} content - File content to scan
 * @returns {string[]} - Array of class names found
 */
function extractDIContainerReferences(content) {
  if (!content || DI_CONTAINER_PATTERNS.length === 0) return [];

  const classNames = new Set();

  for (const pattern of DI_CONTAINER_PATTERNS) {
    // Find all matches of the container pattern
    const matches = content.matchAll(new RegExp(pattern.source, 'g'));
    for (const match of matches) {
      // Get the text after the match to find the class name
      const afterMatch = content.slice(match.index + match[0].length);

      // Pattern 1: Container.get<Generic>(ClassName) - extract ClassName from after generic
      // Pattern 2: Container.get(ClassName) - extract ClassName directly
      // Class names are PascalCase identifiers
      const classMatch = afterMatch.match(/^(?:<[^>]+>\s*\(?\s*)?([A-Z][a-zA-Z0-9_]*)/);
      if (classMatch && classMatch[1]) {
        classNames.add(classMatch[1]);
      }
    }
  }

  return [...classNames];
}

/**
 * Extract C# class references from file content
 * Detects: new ClassName, typeof(ClassName), ClassName variable, generic types <ClassName>
 * @param {string} content - File content to scan
 * @param {Set<string>} knownClasses - Set of known class names to match against
 * @returns {string[]} - Array of class names found
 */
function extractCSharpClassReferences(content, knownClasses) {
  if (!content || !knownClasses || knownClasses.size === 0) return [];

  const classNames = new Set();

  // Pattern 1: new ClassName (instantiation)
  const newPattern = /new\s+([A-Z][a-zA-Z0-9_]*)\s*[({<]/g;
  let match;
  while ((match = newPattern.exec(content)) !== null) {
    if (knownClasses.has(match[1])) {
      classNames.add(match[1]);
    }
  }

  // Pattern 2: typeof(ClassName)
  const typeofPattern = /typeof\s*\(\s*([A-Z][a-zA-Z0-9_]*)\s*\)/g;
  while ((match = typeofPattern.exec(content)) !== null) {
    if (knownClasses.has(match[1])) {
      classNames.add(match[1]);
    }
  }

  // Pattern 3: Generic type arguments <ClassName> or <ClassName, OtherClass>
  const genericPattern = /<\s*([A-Z][a-zA-Z0-9_]*)\s*(?:[,>])/g;
  while ((match = genericPattern.exec(content)) !== null) {
    if (knownClasses.has(match[1])) {
      classNames.add(match[1]);
    }
  }

  // Pattern 4: ActionResult<ClassName>, IEnumerable<ClassName>, etc.
  const wrappedGenericPattern = /<[A-Za-z]+<\s*([A-Z][a-zA-Z0-9_]*)\s*>/g;
  while ((match = wrappedGenericPattern.exec(content)) !== null) {
    if (knownClasses.has(match[1])) {
      classNames.add(match[1]);
    }
  }

  return [...classNames];
}

/**
 * Extract C# extension method names from a file's content
 * Extension methods have 'this' as the first parameter modifier
 * @param {Object} file - Parsed file with content
 * @returns {string[]} - Array of extension method names
 */
function extractCSharpExtensionMethods(file) {
  const content = file.content || '';
  if (!content) return [];

  const methodNames = [];

  // Look for static methods with 'this' parameter (extension methods)
  // Pattern matches: public static ReturnType MethodName(this Type param, ...)
  // Handles multi-line signatures by using [\s\S]*? for the parameter list
  const extensionMethodPattern = /public\s+static\s+[\w<>\[\],\s?]+\s+(\w+)\s*\([^)]*\bthis\s+/g;

  let match;
  while ((match = extensionMethodPattern.exec(content)) !== null) {
    methodNames.push(match[1]);
  }

  return methodNames;
}

/**
 * Check if a method call in content matches any known extension method
 * @param {string} content - File content to scan
 * @param {Map<string, string>} methodToFile - Map of method names to file paths
 * @returns {string[]} - Array of file paths that define called extension methods
 */
function findCalledExtensionMethods(content, methodToFile) {
  if (!content || methodToFile.size === 0) return [];

  const calledFiles = new Set();

  for (const [methodName, filePath] of methodToFile) {
    // Look for method call: .MethodName( or .MethodName<
    const pattern = new RegExp(`\\.${methodName}\\s*[(<]`, 'g');
    if (pattern.test(content)) {
      calledFiles.add(filePath);
    }
  }

  return [...calledFiles];
}

/**
 * Parse .csproj files to build a project dependency graph via ProjectReferences.
 * Returns a Set of project directories that are transitively referenced by any "app" project
 * (a project containing Program.cs or Startup.cs).
 * All .cs files in these directories should be treated as entry points.
 * @param {string} projectPath - Root path of the repository
 * @returns {Set<string>} - Set of project directory prefixes (relative to projectPath)
 */
function parseCsprojReferences(projectPath) {
  const referencedDirs = new Set();
  if (!projectPath) return referencedDirs;

  let csprojFiles;
  try {
    csprojFiles = globSync('**/*.csproj', {
      cwd: projectPath,
      ignore: ['**/bin/**', '**/obj/**', '**/node_modules/**']
    });
  } catch { return referencedDirs; }

  if (csprojFiles.length === 0) return referencedDirs;

  // Build dependency graph: projectDir -> Set<referencedProjectDirs>
  const graph = new Map();
  const projectDirs = new Set();

  for (const csprojFile of csprojFiles) {
    const projDir = dirname(csprojFile);
    projectDirs.add(projDir);

    try {
      const content = readFileSync(join(projectPath, csprojFile), 'utf-8');
      const refs = new Set();

      // Extract <ProjectReference Include="..\..\OtherProject\OtherProject.csproj" />
      const refPattern = /<ProjectReference\s+Include="([^"]+)"/gi;
      let match;
      while ((match = refPattern.exec(content)) !== null) {
        // Normalize Windows backslash paths to forward slash
        const refPath = match[1].replace(/\\/g, '/');
        // Resolve relative to the .csproj directory
        const resolvedRef = normalize(join(projDir, refPath));
        const refDir = dirname(resolvedRef);
        refs.add(refDir);
      }

      graph.set(projDir, refs);
    } catch {
      graph.set(projDir, new Set());
    }
  }

  // Find "app" projects (contain Program.cs or Startup.cs)
  const appProjects = new Set();
  for (const projDir of projectDirs) {
    try {
      const dirPath = join(projectPath, projDir);
      const entries = readdirSync(dirPath);
      if (entries.some(e => /^(Program|Startup)\.cs$/i.test(e))) {
        appProjects.add(projDir);
      }
    } catch { /* skip */ }
  }

  // If no app projects found, treat ALL project dirs as potentially referenced
  // (library repos where everything is public API)
  if (appProjects.size === 0) {
    for (const projDir of projectDirs) {
      referencedDirs.add(projDir);
    }
    return referencedDirs;
  }

  // BFS from each app project to find all transitively referenced project dirs
  for (const appProj of appProjects) {
    referencedDirs.add(appProj);
    const visited = new Set([appProj]);
    const queue = [appProj];
    let qi = 0;
    while (qi < queue.length) {
      const current = queue[qi++];
      const refs = graph.get(current);
      if (refs) {
        for (const ref of refs) {
          if (!visited.has(ref)) {
            visited.add(ref);
            referencedDirs.add(ref);
            queue.push(ref);
          }
        }
      }
    }
  }

  return referencedDirs;
}

// Package.json fields that contain dynamically loaded file paths
let DYNAMIC_PACKAGE_FIELDS = ['nodes', 'plugins', 'credentials', 'extensions', 'adapters', 'connectors'];

/**
 * Set package.json fields to search for dynamic entry points
 * @param {string[]} fields - Field names to search
 */
export function setDynamicPackageFields(fields) {
  DYNAMIC_PACKAGE_FIELDS = fields;
}

/**
 * Extract dynamic file paths from package.json object recursively
 * @param {Object} obj - Object to search (package.json or nested object)
 * @param {number} depth - Current recursion depth (max 3)
 * @returns {string[]} - Array of file paths found
 */
function extractDynamicPaths(obj, depth = 0) {
  if (depth > 3 || !obj || typeof obj !== 'object') return [];
  const paths = [];

  // Check for configured field names at this level
  for (const field of DYNAMIC_PACKAGE_FIELDS) {
    if (Array.isArray(obj[field])) {
      paths.push(...obj[field].filter(p => typeof p === 'string'));
    }
  }

  // Recurse into nested objects (but not arrays)
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      paths.push(...extractDynamicPaths(value, depth + 1));
    }
  }

  return paths;
}

// Config entry points from bundler/CI configs
let CONFIG_ENTRY_DATA = { entries: [], npmScripts: [] };

/**
 * Set config entry data from bundler/CI config parsing
 * @param {Object} data - Result from collectConfigEntryPoints
 */
export function setConfigEntryData(data) {
  CONFIG_ENTRY_DATA = data || { entries: [], npmScripts: [] };
}

/**
 * Check if a file is a config-defined entry point
 * @param {string} filePath - Relative file path
 * @returns {{ isConfigEntry: boolean, source: string|null }}
 */
function checkConfigEntry(filePath) {
  const normalizedPath = filePath.replace(/^\.\//, '');

  for (const entry of CONFIG_ENTRY_DATA.entries) {
    // Direct match
    if (normalizedPath === entry || normalizedPath.endsWith('/' + entry) || entry.endsWith('/' + normalizedPath)) {
      return { isConfigEntry: true, source: 'bundler/ci-config' };
    }

    // Match without extension
    const withoutExt = entry.replace(/\.[^.]+$/, '');
    const fileWithoutExt = normalizedPath.replace(/\.[^.]+$/, '');
    if (fileWithoutExt === withoutExt || fileWithoutExt.endsWith('/' + withoutExt) || withoutExt.endsWith('/' + fileWithoutExt)) {
      return { isConfigEntry: true, source: 'bundler/ci-config' };
    }
  }

  return { isConfigEntry: false, source: null };
}

// Detected frameworks cache
let DETECTED_FRAMEWORKS = new Set();

/**
 * Detect frameworks from package.json dependencies
 * @param {Object} packageJson - Parsed package.json
 */
// Internal: add frameworks from a single package.json (accumulates, does not reset)
function _addFrameworks(packageJson) {
  if (!packageJson) return;
  const allDeps = {
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {}),
    ...(packageJson.peerDependencies || {})
  };

  // CLI frameworks
  if (allDeps['@oclif/core'] || allDeps['oclif']) DETECTED_FRAMEWORKS.add('oclif');
  if (allDeps['commander']) DETECTED_FRAMEWORKS.add('commander');
  if (allDeps['yargs']) DETECTED_FRAMEWORKS.add('yargs');

  // NestJS
  if (allDeps['@nestjs/core'] || allDeps['@nestjs/common']) DETECTED_FRAMEWORKS.add('nestjs');

  // Vue ecosystem
  if (allDeps['vue'] || allDeps['vue-router']) DETECTED_FRAMEWORKS.add('vue');
  if (allDeps['nuxt'] || allDeps['nuxt3'] || allDeps['@nuxt/kit']) DETECTED_FRAMEWORKS.add('nuxt');
  if (allDeps['pinia']) DETECTED_FRAMEWORKS.add('pinia');
  if (allDeps['vuex']) DETECTED_FRAMEWORKS.add('vuex');

  // React ecosystem
  if (allDeps['react'] || allDeps['react-dom']) DETECTED_FRAMEWORKS.add('react');
  if (allDeps['react-router'] || allDeps['react-router-dom']) DETECTED_FRAMEWORKS.add('react-router');
  if (allDeps['redux'] || allDeps['@reduxjs/toolkit']) DETECTED_FRAMEWORKS.add('redux');

  // Angular
  if (allDeps['@angular/core']) DETECTED_FRAMEWORKS.add('angular');

  // Express/Fastify
  if (allDeps['express']) DETECTED_FRAMEWORKS.add('express');
  if (allDeps['fastify']) DETECTED_FRAMEWORKS.add('fastify');

  // ESLint config
  if (packageJson.name?.includes('eslint-config')) DETECTED_FRAMEWORKS.add('eslint-config');
}

export function detectFrameworks(packageJson) {
  DETECTED_FRAMEWORKS = new Set();
  _addFrameworks(packageJson);
  return DETECTED_FRAMEWORKS;
}

/**
 * Check if a file is a framework-specific entry point
 * @param {string} filePath - Relative file path
 * @returns {{ isEntry: boolean, reason: string|null }}
 */
function checkFrameworkEntry(filePath) {
  // CLI frameworks - commands directory
  if (DETECTED_FRAMEWORKS.has('oclif') || DETECTED_FRAMEWORKS.has('commander') || DETECTED_FRAMEWORKS.has('yargs')) {
    if (/\/commands\//.test(filePath) || /^commands\//.test(filePath)) {
      return { isEntry: true, reason: 'CLI command file (oclif/commander/yargs)' };
    }
  }

  // NestJS - controllers and handlers (modules are detected via import analysis)
  if (DETECTED_FRAMEWORKS.has('nestjs')) {
    if (/\.controller\.([mc]?[jt]s|tsx)$/.test(filePath)) {
      return { isEntry: true, reason: 'NestJS controller' };
    }
    // Note: .module. files removed - non-root modules need import analysis to be considered live
    if (/\.handler\.([mc]?[jt]s|tsx)$/.test(filePath)) {
      return { isEntry: true, reason: 'NestJS/API handler' };
    }
  }

  // Vue - router, stores
  if (DETECTED_FRAMEWORKS.has('vue')) {
    if (/router\.([mc]?[jt]s|tsx)$/.test(filePath)) {
      return { isEntry: true, reason: 'Vue router file' };
    }
    if (/init\.([mc]?[jt]s|tsx)$/.test(filePath) || /\/app\/init\.([mc]?[jt]s|tsx)$/.test(filePath)) {
      return { isEntry: true, reason: 'Vue app initialization' };
    }
  }

  // Nuxt auto-imports — Nuxt 3 automatically imports from these directories (recursively)
  // Files in these dirs are used without explicit import statements
  if (DETECTED_FRAMEWORKS.has('nuxt')) {
    if (/\/(?:utils|helpers|lib|context)\/.*\.[mc]?[jt]sx?$/.test(filePath)) {
      return { isEntry: true, reason: 'Nuxt auto-imported utility' };
    }
    if (/\/(?:store|stores)\/.*\.[mc]?[jt]sx?$/.test(filePath)) {
      return { isEntry: true, reason: 'Nuxt/Pinia auto-imported store' };
    }
    if (/\/middleware\/[^/]+\.[mc]?[jt]sx?$/.test(filePath)) {
      return { isEntry: true, reason: 'Nuxt route middleware' };
    }
    if (/\/components\/.*\.(vue|[mc]?[jt]sx?)$/.test(filePath)) {
      return { isEntry: true, reason: 'Nuxt auto-imported component' };
    }
    if (/\/error\/.*\.[mc]?[jt]sx?$/.test(filePath)) {
      return { isEntry: true, reason: 'Nuxt error handler' };
    }
  }

  // Pinia stores
  if (DETECTED_FRAMEWORKS.has('pinia')) {
    if (/\.store\.([mc]?[jt]s|tsx)$/.test(filePath) || /use\w+Store\.([mc]?[jt]s|tsx)$/.test(filePath)) {
      return { isEntry: true, reason: 'Pinia store' };
    }
  }

  // Vuex stores
  if (DETECTED_FRAMEWORKS.has('vuex')) {
    if (/\.store\.([mc]?[jt]s|tsx)$/.test(filePath) || /\/stores?\//.test(filePath)) {
      return { isEntry: true, reason: 'Vuex store' };
    }
  }

  // ESLint config packages
  if (DETECTED_FRAMEWORKS.has('eslint-config')) {
    if (/\/configs?\//.test(filePath)) {
      return { isEntry: true, reason: 'ESLint config export' };
    }
  }

  return { isEntry: false, reason: null };
}

/**
 * Convert a glob pattern to a regex for matching file paths
 */
function globToRegex(pattern) {
  const regexStr = pattern
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*')
    .replace(/\./g, '\\.')
    .replace(/\?/g, '.');
  return new RegExp(regexStr);
}

/**
 * Match files against a glob pattern
 */
function matchGlobPattern(pattern, filePaths, baseDir = '') {
  // Resolve relative paths (../ and ./) against baseDir first (before regex conversion)
  let resolved = pattern;
  if (resolved.startsWith('./') || resolved.startsWith('../')) {
    if (baseDir) {
      const parts = baseDir.split('/');
      let rel = resolved;
      while (rel.startsWith('../')) {
        parts.pop();
        rel = rel.slice(3);
      }
      if (rel.startsWith('./')) rel = rel.slice(2);
      resolved = parts.length > 0 ? parts.join('/') + '/' + rel : rel;
    } else {
      resolved = resolved.replace(/^\.\//, '');
    }
  }

  // Escape dots, then convert glob syntax to regex
  let regexStr = resolved
    .replace(/\./g, '\\.')                    // Escape all dots first
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*')
    .replace(/\?/g, '.')
    .replace(/\{([^}]+)\}/g, (_, content) => {   // Expand braces last (dots already escaped)
      const parts = content.split(',').map(p => p.trim());
      return `(?:${parts.join('|')})`;
    });

  try {
    const regex = new RegExp(regexStr);
    return filePaths.filter(fp => regex.test(fp));
  } catch {
    return [];
  }
}

// Entry point patterns - files matching these are NOT dead code even if not imported
// NOTE: These now match ANYWHERE in the path, not just at root
const ENTRY_POINT_PATTERNS = [
  // === CLI Commands (oclif/commander/yargs) ===
  // These are loaded dynamically by CLI frameworks based on directory structure
  /src\/cli\/commands\//,
  /\/commands\//,  // Generic commands directory
  /^commands\//,
  /\/bin\//,
  /^bin\//,

  // Scripts (run directly with node)
  /\/scripts?\//,
  /^scripts?\//,

  // Main entry files - only root or src-level, NOT nested directories
  // This prevents treating all index.ts files in packages/libs as entry points
  /^(index|main|server|app|init|router)\.([mc]?[jt]s|[jt]sx)$/,
  /^src\/(index|main|server|app|init|router)\.([mc]?[jt]s|[jt]sx)$/,
  // Client/server split - flat structure (server/index.ts, api/index.ts, functions/index.ts)
  /^(client|server|api|backend|functions|lambda|worker|workers|services|core|lib|app|web|middleware|source)\/(?:index|main|app|handler)\.([mc]?[jt]s|[jt]sx)$/,
  // Client/server split - with src subdirectory (server/src/index.ts)
  /^(client|server|api|backend|functions|lambda|services|core|lib|app|web|source)\/src\/(index|main|server|app|handler)\.([mc]?[jt]s|[jt]sx)$/,
  // CLI and scripts (bin/cli.ts, cli/index.ts, commands/serve.ts)
  /^(bin|cli|commands|scripts)\/[^/]+\.([mc]?[jt]s|[jt]sx)$/,
  // Background jobs and tasks (jobs/cleanup.ts, cron/daily.ts, queues/email.ts)
  /^(jobs|tasks|cron|queues)\/[^/]+\.([mc]?[jt]s|[jt]sx)$/,
  // Serverless platforms (netlify/functions/*.ts, vercel/api/*.ts, supabase/functions/*.ts)
  /^netlify\/functions\/[^/]+\.([mc]?[jt]s|[jt]sx)$/,
  /^vercel\/api\/[^/]+\.([mc]?[jt]s|[jt]sx)$/,
  /^supabase\/functions\/[^/]+\/index\.([mc]?[jt]s|[jt]sx)$/,
  /^edge-functions?\/[^/]+\.([mc]?[jt]s|[jt]sx)$/,
  /^deno\/[^/]+\.([mc]?[jt]s|[jt]sx)$/,
  // GraphQL (graphql/resolvers.ts, resolvers/user.ts)
  /^(graphql|resolvers|schema)\/[^/]+\.([mc]?[jt]s|[jt]sx)$/,
  // Monorepo app entry points (apps/*/src/index.tsx or apps/*/src/main.ts)
  /^apps\/[^/]+\/src\/(index|main|server|app)\.([mc]?[jt]s|[jt]sx)$/,
  /^apps\/[^/]+\/(index|main|server|app)\.([mc]?[jt]s|[jt]sx)$/,
  // Nested workspace entry points (apps/api/v2/src/main.ts, apps/api/v1/src/index.ts)
  /^apps\/[^/]+\/[^/]+\/src\/(index|main|server|app)\.([mc]?[jt]s|[jt]sx)$/,
  /^apps\/[^/]+\/[^/]+\/(index|main|server|app)\.([mc]?[jt]s|[jt]sx)$/,
  // Monorepo packages entry points (packages/*/src/main.ts, packages/*/*/src/main.ts)
  /^packages\/[^/]+\/src\/(index|main|server|app|init)\.([mc]?[jt]s|[jt]sx)$/,
  /^packages\/[^/]+\/[^/]+\/src\/(index|main|server|app|init)\.([mc]?[jt]s|[jt]sx)$/,
  /^packages\/[^/]+\/(index|main|server|app)\.([mc]?[jt]s|[jt]sx)$/,
  // Libs directory pattern (libs/*/src/index.ts)
  /^libs\/[^/]+\/src\/(index|main)\.([mc]?[jt]s|[jt]sx)$/,

  // Config files (vite.config.ts, postcss.config.cjs, jest.config.mjs, jest.config.cli.js, karma.conf.js etc.)
  /\.(config|rc|conf)(\.\w+)*\.([mc]?[jt]s|json)$/,
  /^\..*rc\.[mc]?js$/,

  // TypeScript declaration files (.d.ts/.d.cts/.d.mts) - ambient type definitions used by compiler
  /\.d\.ts$/, /\.d\.cts$/, /\.d\.mts$/,
  /shims-.*\.d\.ts$/,    // Vue shims (shims-vue.d.ts, shims-modules.d.ts)
  /env\.d\.ts$/,         // Vite environment declarations
  // Flow type stubs (ambient type definitions for Flow, not imported)
  /flow-typed\//,

  // Template/scaffold directories (copied at runtime, not imported)
  /\/templates?\//,
  /^templates?\//,
  /[-_]template\//,       // app-template/, test-template/ directories

  // CLI bin entry points (src/bin.ts, cli/bin.mjs)
  /\/bin\.([mc]?[jt]s|[jt]sx)$/,

  // Plopfile generators
  /plopfile\.([mc]?[jt]s|[jt]sx)$/,

  // Jest transform files (fileTransformer.js etc.)
  /[Tt]ransformer\.([mc]?[jt]s|[jt]sx)$/,

  // Gulpfile and Gruntfile (task runner entry points)
  /gulpfile\.([mc]?[jt]s|[jt]sx|js)$/,
  /[Gg]runtfile\.([mc]?[jt]s|[jt]sx|js|coffee)$/,

  // === Test Files and Utilities ===
  // Match test/spec files by suffix (actual test files)
  // Also matches multi-part test suffixes like .test.api.ts, .test.cli.js
  /\.(test|spec)(\.\w+)*\.([mc]?[jt]s|[jt]sx)$/,
  // Hyphenated test files: *-test.ts, *-spec.ts (Deno, QUnit, Ember convention)
  /[-_](test|spec)\.([mc]?[jt]s|[jt]sx)$/,
  // Type test files (.test-d.ts, .test-d.tsx) used by tsd/vitest typecheck
  /\.test-d\.([mc]?[jt]s|[jt]sx)$/,
  // Type checking test files (*.type-tests.ts, *.typecheck.ts) used by expect-type/tsd
  /\.type-tests?\.([mc]?[jt]s|[jt]sx)$/,
  /\.typecheck\.([mc]?[jt]s|[jt]sx)$/,
  // Standalone test entry files (tests.ts/tests.js - Prisma functional test pattern)
  /\/tests\.([mc]?[jt]s|[jt]sx)$/,
  // Benchmark files (*.bench.ts, *.benchmark.ts) loaded by vitest bench / benchmark runners
  /\.bench(mark)?\.([mc]?[jt]s|[jt]sx)$/,
  // E2E test files (.e2e.ts, .e2e-spec.ts, .e2e.tsx)
  /\.e2e(-spec)?\.([mc]?[jt]s|[jt]sx)$/,
  // Files in e2e/ directories (loaded by test runner)
  /\/e2e\//,
  // Integration test files (.integration-test.ts, .integration.test.ts)
  /\.integration[.-]test\.([mc]?[jt]s|[jt]sx)$/,
  // Match files directly in __tests__ directories (Jest convention)
  /__tests__\/[^/]+\.([mc]?[jt]s|[jt]sx)$/,
  // Match files directly in __mocks__ directories (Jest mock convention)
  /__mocks__\//,
  // Match test files in package-level test/ directories (common pattern in monorepos)
  /\/test\/test-[^/]+\.([mc]?[jt]s|[jt]sx)$/,
  /\/tests?\/[^/]+\.test\.([mc]?[jt]s|[jt]sx)$/,
  // All files inside test/tests directories at depth >1 (loaded by test runners)
  // Test runners like Jest/Vitest match all files in these directories
  // Uses depth >1 (test/subdir/file.ts) to avoid over-matching single-level test/ dirs
  /\/tests?\/[^/]+\/.*\.([mc]?[jt]s|[jt]sx)$/,
  /^tests?\/[^/]+\/.*\.([mc]?[jt]s|[jt]sx)$/,
  // All files directly in tests/ directories (with 's' - more likely to be test runner dirs)
  /\/tests\/[^/]+\.([mc]?[jt]s|[jt]sx)$/,
  /^tests\/[^/]+\.([mc]?[jt]s|[jt]sx)$/,
  // Root-level test/ (singular) at depth 1 — many libraries (express, ky, etc.)
  // put test files directly in test/ without nesting
  /^test\/[^/]+\.([mc]?[jt]s|[jt]sx)$/,
  // Standalone test.ts/test.js files (Prisma functional test pattern)
  /\/test\.([mc]?[jt]s|[jt]sx)$/,
  // test-utils files (test helper modules loaded by test runners)
  /test-utils\.([mc]?[jt]s|[jt]sx)$/,
  // Root-level vitest/jest setup files (vitest.setup.ts, jest.setup.js)
  /^(vitest|jest)\.setup\.([mc]?[jt]s|[jt]sx)$/,
  // Package-level jest/vitest setup files (any nesting level, various naming conventions)
  /(vitest|jest)[.\-]setup[^/]*\.([mc]?[jt]s|[jt]sx)$/,
  // Vitest setup with custom names (vitest-setup-client.ts, tests-setup.ts)
  /[.\-]setup[.\-](client|server|env|dom|after-env)\.([mc]?[jt]s|[jt]sx)$/,
  // API test utility packages (test helpers loaded by test runners)
  /api-tests?\//,
  // Playwright test directories (loaded by playwright.config.ts)
  /\/playwright\//,
  /^playwright\//,
  // Storybook stories and test storybooks
  /\.stories\.([mc]?[jt]s|[jt]sx)$/,
  /\.story\.([mc]?[jt]s|[jt]sx)$/,    // Alternative .story. extension (mantine, tinymce)
  /^test-storybooks\//,   // Storybook test storybook projects
  // stories/ directories (loaded by .storybook/main.js glob patterns)
  /\/stories\//,
  /^stories\//,
  // Test asset directories (vendor libraries/files served in test pages)
  /\/tests?\/assets\//,
  /^tests?\/assets\//,
  // Test utility directories (monorepo test packages)
  // These contain test helpers, fixtures, and harnesses loaded by test runners
  /^testing\//,           // Root testing/ directory
  /\/testing\//,          // Nested testing/ directories
  /-testing\//,           // Packages like core/nodes-testing/
  /\/fixtures\//,         // Test fixtures directories
  /^fixtures\//,          // Root fixtures directory
  /__fixtures__\//,       // Jest/codemod fixtures convention
  /__testfixtures__\//,   // Storybook/codemod test fixtures
  // Test setup/teardown files (loaded by vitest/jest config, not imported)
  /\/test\/setup\.ts$/,
  /\/test\/teardown\.ts$/,
  /\/test\/extend-expect\.ts$/,
  /\/test\/setup-test-folder\.ts$/,
  /\/test\/setup-mocks\.ts$/,
  /\/test\/globalSetup\.ts$/,
  /\.test\.constants\.([mc]?[jt]s|tsx)$/,
  // Root-level test setup files (setupVitest.ts, jest.setup.ts, etc.)
  /^setup(Vitest|Jest|Tests?)\.([mc]?[jt]s|[jt]sx)$/,
  // Test setup files with underscore prefix (__setupTests.ts convention)
  /\/__?setup\w*\.([mc]?[jt]s|[jt]sx)$/,
  // setupTests.ts in test/ directories (loaded by vitest/jest setupFiles config)
  /\/tests?\/setupTests\.([mc]?[jt]s|[jt]sx)$/,
  // test/setup/ or tests/setup/ directories (jest/vitest setup files)
  /\/tests?\/setup\//,
  /^tests?\/setup\//,
  // Vitest/Jest config packages (loaded by test runner config)
  /vitest-config\/.*\.([mc]?[jt]s|tsx)$/,
  /jest-config\/.*\.([mc]?[jt]s|tsx)$/,
  // Jest preset files (referenced in jest config by name)
  /jest-preset[^/]*\.[mc]?js$/,
  /vitest\.workspace\.([mc]?[jt]s)$/,
  /vitest\.config\.([mc]?[jt]s)$/,
  // Test utilities in monorepo packages
  /\/test-utils\/.*\.([mc]?[jt]s|tsx)$/,
  // Monitoring/synthetic checks (Checkly, Datadog, etc.)
  /__checks__\//,
  /^__checks__\//,

  // Workers (often loaded dynamically via new Worker())
  /workers?\//,
  /\.worker\.([mc]?[jt]s|[jt]sx)$/,
  /-worker\.([mc]?[jt]s|[jt]sx)$/,   // message-event-bus-log-writer-worker.ts pattern

  // Build outputs
  /\/dist\//,
  /^dist\//,
  /\/build\//,
  /^build\//,
  /\/out\//,
  /^out\//,
  /\.min\.js$/,

  // Platform build entry points (Cloudflare Workers, browser builds, etc.)
  // builds/browser.ts, builds/node.ts, builds/worker.ts - compiled separately by build tool
  /\/builds\/[^/]+\.[mc]?[jt]sx?$/,

  // Polyfill/shim directories (loaded via build config, not imports)
  /\/polyfills?\//,
  /^polyfills?\//,
  /\/shims?\//,
  /^shims?\//,
  /__shims__\//,

  // Middleware convention (Next.js middleware.ts at root or app level)
  /^(src\/)?middleware\.[mc]?[jt]sx?$/,
  /^apps\/[^/]+\/(src\/)?middleware\.[mc]?[jt]sx?$/,

  // Protobuf/gRPC generated files
  /\.(pb|pb2|proto)\.(go|py|js|ts)$/,
  /_grpc_pb\.(js|ts|d\.ts)$/,    // gRPC generated JS/TS stubs
  /_pb2_grpc\.py$/,               // gRPC generated Python stubs
  /_pb2\.pyi?$/,                  // protobuf generated Python type stubs
  /\.grpc-server\.(ts|js)$/,     // gRPC generated server stubs (teleport)
  /\.grpc-client\.(ts|js)$/,     // gRPC generated client stubs
  /_pb\.(js|ts|d\.ts)$/,         // protobuf generated JS/TS files

  // Next.js / Remix / etc - file-based routing
  // Match pages/app/routes at project root, under src/, or in monorepo workspace packages
  /^pages\//,
  /^src\/pages\//,
  // Monorepo workspace pages (apps/web/pages/, apps/*/pages/, apps/api/v1/pages/)
  /^apps\/[^/]+\/pages\//,
  /^apps\/[^/]+\/src\/pages\//,
  /^apps\/[^/]+\/[^/]+\/pages\//,  // Nested workspace: apps/api/v1/pages/
  /^packages\/[^/]+\/pages\//,
  // App Router - match all files under app/ directory (they form a routing tree)
  // Includes special files (page, layout, route, loading, error, etc.) and
  // co-located components imported by them
  /^app\//,
  /^src\/app\//,
  // Monorepo workspace App Router (apps/web/app/, apps/*/app/, apps/*/src/app/)
  /^apps\/[^/]+\/app\//,
  /^apps\/[^/]+\/src\/app\//,
  /^packages\/[^/]+\/app\//,
  // Standalone sub-projects with file-based routing (companion/app/, admin/app/, etc.)
  // Any top-level directory with its own app/ or pages/ routing
  /^[^/]+\/app\/.*\.(tsx?|jsx?)$/,
  /^[^/]+\/pages\/.*\.(tsx?|jsx?)$/,
  // Workspace dirs with src/ prefix (www/src/pages/, www/src/app/)
  /^[^/]+\/src\/pages\//,
  /^[^/]+\/src\/app\//,
  // Nested workspace sub-projects (www/og-image/pages/, tools/admin/app/)
  /^[^/]+\/[^/]+\/pages\//,
  /^[^/]+\/[^/]+\/app\//,
  /^[^/]+\/[^/]+\/src\/pages\//,
  /^[^/]+\/[^/]+\/src\/app\//,
  // Remix/SvelteKit/etc routes
  /^routes\//,
  /^src\/routes\//,
  // Monorepo workspace routes
  /^apps\/[^/]+\/routes\//,
  /^apps\/[^/]+\/src\/routes\//,
  // SvelteKit convention files (file-based routing, loaded by framework at runtime)
  /\+(?:page|layout|server|error)(?:\.server)?\.([mc]?[jt]s|[jt]sx|svelte)$/,
  // Framework build entry points (Qwik, Vite, etc. — loaded by build system)
  /entry\.(?:ssr|dev|preview|express|cloudflare|vercel|deno|bun|fastify|node)\.([mc]?[jt]sx?)$/,
  // Next.js instrumentation files (loaded by Next.js at startup)
  /instrumentation(-client)?\.([mc]?[jt]s|[jt]sx)$/,

  // Component registries (shadcn-style, loaded dynamically)
  /\/registry\//,

  // Docusaurus - theme overrides (swizzled components loaded by framework)
  /\/src\/theme\//,
  // Docusaurus config files (sidebars.ts, docusaurus.*.js plugins)
  /sidebars\.([mc]?[jt]s|[jt]sx)$/,
  /docusaurus\.[^/]+\.([mc]?[jt]s|[jt]sx|js)$/,
  // Docusaurus docs/ components (MDX-loaded, not imported via JS)
  /\/docs\/.*\.([jt]sx)$/,
  // Docusaurus versioned docs (version-X.xx.xx/ directories with JSX components)
  /versioned_docs\/.*\.([jt]sx)$/,
  // Docusaurus tutorial TSX/JSX files (loaded by MDX)
  /\/tutorial\/.*\.([jt]sx)$/,
  /^tutorial\/.*\.([jt]sx)$/,

  // Public/static assets (public/ for Node, static/ for Django/Flask/Rails)
  /\/public\//,
  /^public\//,
  /\/static\//,
  /^static\//,

  // Dashboard/UI entry points
  /dashboard\/public\//,

  // === NestJS/Express Controllers ===
  // Controllers are registered in @Module({ controllers: [...] })
  // Only match files with .controller. suffix (actual controllers), not /controllers/ directory
  /\.controller\.([mc]?[jt]s|tsx)$/,
  // API handlers - only match files with .handler. suffix
  // The /handlers/ directory pattern is removed - serverless.yml parsing handles that
  /\.handler\.([mc]?[jt]s|tsx)$/,
  // Note: .module. pattern removed - modules need import analysis (non-root modules are not entry points)

  // === Pinia/Vuex Stores ===
  // Stores are accessed via useStore() pattern, not direct imports
  /\.store\.([mc]?[jt]s|tsx)$/,
  /\/stores\//,
  /use\w+Store\.([mc]?[jt]s|tsx)$/,  // useRootStore.ts pattern

  // === Schema Files (loaded at runtime) ===
  // XML schema files for validation (SAML, SOAP, etc.)
  /\.xsd\.([mc]?[jt]s|tsx)$/,
  /\/schema\//,
  /\/schemas\//,

  // Database migrations (loaded dynamically by ORMs like TypeORM, Prisma)
  /\/migrations\//,
  /\/seeds?\//,
  // Database seed files (named seed-*.ts, *-seed.ts, *.seed.ts)
  /seed[.-][^/]+\.([mc]?[jt]s|[jt]sx)$/,

  // Locale/i18n files (loaded dynamically by locale name)
  /\/locale\//, /^locale\//, /\/locales\//, /^locales\//,
  /\/i18n\//, /^i18n\//, /\/l10n\//, /^l10n\//,

  // Type-checking test files (tsd, vitest typecheck, type-fest test-d/)
  /\/test-d\//, /^test-d\//,

  // ESM build outputs (parallel to src/, compiled by build tool)
  /^esm\//, /\/esm\//,

  // Example/demo/sample/sandbox directories (reference implementations, not imported)
  /\/examples?\//,
  /^examples?\//,
  /^example-apps?\//,
  /\/example-apps?\//,
  /\/sandbox\//,
  /^sandbox\//,
  /\/demos?\//,
  /^demos?\//,
  /\/samples?(-\w+)?\//,
  /^samples?(-\w+)?\//,
  // Starter/template apps (standalone reference implementations)
  /\/starters?\//,
  /^starters?\//,

  // Benchmark scripts (standalone performance tests)
  /\/bench(marks?)?\//,
  /^bench(marks?)?\//,

  // Scanner/CLI utilities (often package bin entries)
  /\/scanner\//,

  // Error classes (often auto-exported or dynamically loaded)
  /\/errors\/.*\.error\.([mc]?[jt]s|tsx)$/,

  // Grammar/parser files (CodeMirror, PEG.js, etc.)
  /\.terms\.([mc]?[jt]s|tsx)$/,
  /grammar\.([mc]?[jt]s|tsx)$/,

  // === RPC/API Router files (tRPC, GraphQL, etc.) ===
  // tRPC router files (_router.ts, _app.ts in routers/ directories)
  /\/routers?\//,

  // === ESLint/Config Packages ===
  // Config packages referenced by string in .eslintrc
  /eslint-config/,
  // Local ESLint rules (loaded dynamically by eslint config)
  /eslint[_-]?(local[_-])?rules?\//,
  /\/configs?\//,

  // === Enterprise/Premium Modules ===
  // Often loaded conditionally at runtime based on license
  /\/ee\//,
  /\/enterprise\//,
  /\/premium\//,

  // === Experiments and Workflows ===
  // Often loaded dynamically at runtime
  /\/experiments?\//,
  /\/workflows\//,

  // === Codemods and Code Generators ===
  // Loaded dynamically by migration/upgrade tools
  /\/codemods?\//,
  /\/plops?\//,

  // === Plugin Systems (dynamically loaded at runtime) ===
  // Common plugin file naming conventions (*.node.ts, *.plugin.ts, etc.)
  /\.node\.([mc]?[jt]s|tsx)$/,
  /\.plugin\.([mc]?[jt]s|tsx)$/,
  /\.credentials\.([mc]?[jt]s|tsx)$/,
  /\.connector\.([mc]?[jt]s|tsx)$/,
  /\.adapter\.([mc]?[jt]s|tsx)$/,
  // Plugin/extension directories (loaded dynamically by runtime)
  /\/plugins?\//,
  /\/extensions?\//,
  /\/addons?\//,
  /^addons?\//,
  /\/integrations?\//,
  /^integrations?\//,
  /\/connectors?\//,
  /\/adapters?\//,
  /\/providers?\//,
  // Nodes directory pattern (common for workflow engines like n8n)
  /\/nodes\//,
  // Vue/Nuxt composables (often auto-imported by framework)
  /\/composables?\//,
  // Note: /hooks/ removed - React hooks should be detected via import analysis
  // Files in hooks/ that are actually used will be reachable from entry points

  // Vue mixins (imported dynamically or via plugin system)
  /\/mixins?\//,

  // Utility barrel exports (commonly re-exported and tree-shaken)
  /\/utils\/index\.([mc]?[jt]s|tsx)$/,

  // === Public API directories ===
  /\/public-api\//,

  // === Browser patches (applied to browser source, not JS modules) ===
  /browser[_-]?patches\//,

  // === Injected/bundled scripts (bundled separately by esbuild/rollup, not via imports) ===
  // Packages named "injected" contain scripts injected into browser contexts
  /\/injected\/src\//,

  // ═══════════════════════════════════════════════════════════════════════════
  // MULTI-LANGUAGE ENTRY POINTS
  // ═══════════════════════════════════════════════════════════════════════════

  // === Python Entry Points ===
  // Django - Core files that are loaded by convention
  // Note: This may miss dead apps (not in INSTALLED_APPS), but we prefer
  // false negatives over false positives (safer to not flag live code)
  /manage\.py$/,
  /wsgi\.py$/,
  /asgi\.py$/,
  /settings\.py$/,
  /urls\.py$/,
  /admin\.py$/,
  /models\.py$/,      // Django ORM convention
  /views\.py$/,       // Django routing convention
  // Django directory-based organization (views/issue.py, urls/api.py, models/user.py)
  /\/views\/.*\.py$/,
  /\/urls\/.*\.py$/,
  /\/models\/.*\.py$/,
  /\/serializers?\/.*\.py$/,
  // Note: forms.py removed - forms are only used when imported by views
  /serializers\.py$/, // DRF serializers
  /signals\.py$/,     // Django signals
  /apps\.py$/,        // Django AppConfig
  /conftest\.py$/,    // Pytest config
  /test_[^/]+\.py$/,  // Pytest test files (test_something.py)
  /[^/]+_test\.py$/,  // Pytest test files (something_test.py)
  /\/tests\.py$/,     // Django test convention (app/tests.py)
  // Python files in test/tests directories (pytest auto-discovers all .py files in test dirs,
  // not just test_*.py — includes functional tests, regression data, input fixtures)
  /\/tests?\/.*\.py$/,
  /^tests?\/.*\.py$/,
  /__init__\.py$/,    // Package init files
  /\/management\/commands\//,  // Django management commands
  // Django settings directory (loaded dynamically via DJANGO_SETTINGS_MODULE)
  /\/settings\/.*\.py$/,
  // Django middleware directory (loaded dynamically via MIDDLEWARE setting)
  /\/middleware\/.*\.py$/,
  // Django authentication backends (loaded via AUTHENTICATION_BACKENDS setting)
  /\/authentication\/.*\.py$/,
  // Django - dynamically loaded modules
  /\/templatetags\/[^/]+\.py$/,  // Template tags loaded via {% load tag %}
  /\/locale\/[^/]+\/formats\.py$/,  // Locale format files loaded via import_module()
  /\/backends\/.*\.py$/,  // DB/cache/email/auth backends loaded via settings (import_module)
  /\/context_processors\.py$/,  // TEMPLATES setting context processors
  // FastAPI/Flask
  /main\.py$/,
  /app\.py$/,
  /__main__\.py$/,
  /router\.py$/,
  /routes\.py$/,
  /endpoints\.py$/,
  /config\.py$/,
  /conf\.py$/,         // Sphinx/Python config files loaded dynamically
  /deps\.py$/,         // FastAPI dependencies
  /schemas\.py$/,      // Pydantic schemas
  // FastAPI/Python-specific directories (only .py files)
  /\/api\/[^/]+\.py$/,       // FastAPI API endpoints (app/api/users.py)
  /\/routers?\/[^/]+\.py$/,  // FastAPI routers
  /\/services?\/[^/]+\.py$/, // Python service layer
  /\/models?\/[^/]+\.py$/,   // Python database models
  /\/schemas?\/[^/]+\.py$/,  // Pydantic schemas
  /\/core\/[^/]+\.py$/,      // Python core modules
  // Celery tasks
  /tasks\.py$/,
  /celery\.py$/,
  /celeryconfig\.py$/,
  // Python type stubs (.pyi) - declarations consumed by type checkers, not via imports
  /\.pyi$/,
  // Typeshed directory (Python type stubs collection used by mypy, pyright, etc.)
  /typeshed\//,
  // Top-level Python package __init__.py files (e.g., rllib/__init__.py, src/mypackage/__init__.py)
  // These are package roots that may not be imported by anything else in the repo
  /^[^/]+\/__init__\.py$/,            // depth 1: rllib/__init__.py
  /^[^/]+\/[^/]+\/__init__\.py$/,     // depth 2: python/ray/__init__.py, src/mypackage/__init__.py

  // Python package setup (build entry points, not imported)
  /setup\.py$/,
  /setup\.cfg$/,

  // === Java/Kotlin Entry Points ===
  // Java/Kotlin files in test/ directories (test fixtures, resources, transformation tests)
  /\/test\/.*\.(java|kt)$/,
  /^test\/.*\.(java|kt)$/,
  // Spring Boot - only definitive entry points by file name
  /Application\.(java|kt)$/,
  /.*Application\.(java|kt)$/,
  // Test files are entry points
  /.*Test\.(java|kt)$/,
  /.*Tests\.(java|kt)$/,
  /.*Spec\.(java|kt)$/,
  /.*IT\.(java|kt)$/,          // Integration tests
  /.*ITCase\.(java|kt)$/,     // Integration test cases
  // Resource/config files that trigger class loading
  /package-info\.java$/,
  // Java/Kotlin test case input dirs (compiled test inputs, not imported - e.g. spotbugs testCases/)
  /[Tt]est[Cc]ases?\/.*\.(java|kt)$/,
  /[Pp]lugin-test\/.*\.(java|kt)$/,
  // Java integration test resource dirs (Maven/Gradle resources dirs with .java/.kt files)
  /src\/(it|test)\/resources\/.*\.(java|kt)$/,
  // SPI service files (META-INF/services)
  /META-INF\/services\//,
  /META-INF\/.*\.xml$/,
  // GraalVM substitution files (loaded by native-image)
  /Substitutions?\.(java|kt)$/,
  // Note: Controller/Service/Repository/Config files are detected via @annotations
  // in hasDIDecorators, not by file name pattern (to avoid false positives)

  // === C#/.NET Entry Points ===
  /Program\.cs$/,
  /Startup\.cs$/,
  // ASP.NET Controllers
  /.*Controller\.cs$/,
  // Tests (name-based: FooTest.cs, FooTests.cs, FooTest.Platform.cs)
  /.*Tests?\.\w*\.?cs$/,
  // C# files in test directories (loaded by dotnet test runner, not imported)
  /\/tests?\/.*\.cs$/,
  /^tests?\/.*\.cs$/,
  // Extension methods / DI registration
  /.*Extensions?\.cs$/,
  // ASP.NET middleware
  /.*Middleware\.cs$/,
  // DI modules (Autofac, etc.)
  /.*Module\.cs$/,
  // MediatR/CQRS handlers
  /.*Handler\.cs$/,
  // Custom attributes (loaded by reflection)
  /.*Attribute\.cs$/,
  // SignalR hubs
  /.*Hub\.cs$/,
  // ASP.NET action/result filters
  /.*Filter\.cs$/,
  // JSON/XML converters
  /.*Converter\.cs$/,
  // C# 10 global usings
  /GlobalUsings\.cs$/,
  // Assembly metadata
  /AssemblyInfo\.cs$/,

  // === Go Entry Points ===
  // main.go in any package (includes cmd/*/main.go)
  /main\.go$/,
  // Test files
  /_test\.go$/,
  // Wire providers (DI code generation)
  /wire\.go$/,
  /wire_gen\.go$/,
  // Package documentation (always compiled into package)
  /doc\.go$/,
  // Go generate targets and generated code
  /.*_generated?\.go$/,
  // Plugin entry points
  /plugin\.go$/,

  // === Rust Entry Points ===
  /main\.rs$/,
  /lib\.rs$/,
  /mod\.rs$/,
  // Rust build/config files
  /Cargo\.toml$/, /build\.rs$/,
  // Rust bench/example/fuzz targets
  /benches\/.*\.rs$/, /examples\/.*\.rs$/,
  /\/fuzz_targets\/[^/]+\.rs$/, /\/fuzz\/targets\/[^/]+\.rs$/,
  // Rust inline module submodule directories (loaded via mod declarations)
  /\/handlers\/[^/]+\.rs$/,
  /\/imports\/[^/]+\.rs$/,
  /\/syntax_helpers\/[^/]+\.rs$/,
  /\/completions\/[^/]+\.rs$/,
  /\/tracing\/[^/]+\.rs$/,
  /\/toolchain_info\/[^/]+\.rs$/,

  // === PHP Entry Points ===
  /index\.php$/, /artisan$/,
  /composer\.json$/,
  /app\/Http\/Controllers\//, /app\/Models\//, /app\/Providers\//,
  /routes\/web\.php$/, /routes\/api\.php$/,
  /database\/migrations\//, /database\/seeders\//,
  /config\/.*\.php$/, /resources\/views\//,

  // === Ruby Entry Points ===
  /config\.ru$/, /Rakefile$/, /Gemfile$/,
  /\/homebrew\//, /^homebrew\//,
  /config\/initializers\//, /config\/environments\//,
  /db\/post_migrate\//, /db\/migrate\//,
  /app\/controllers\//, /app\/models\//, /app\/helpers\//,
  /app\/jobs\//, /app\/mailers\//, /app\/views\//,
  /config\/routes\.rb$/, /config\/application\.rb$/,
  /db\/seeds\.rb$/,
  /lib\/tasks\/.*\.rake$/,
  /spec\/.*_spec\.rb$/, /test\/.*_test\.rb$/,

  // === Elixir Entry Points ===
  /mix\.exs$/, /config\/.*\.exs$/,

  // === Haskell Entry Points ===
  /\.cabal$/, /stack\.yaml$/, /Setup\.hs$/,

  // === Nim Entry Points ===
  /\.nimble$/,

  // === Zig Entry Points ===
  /build\.zig$/, /\.zig$/,

  // === Build Config Files ===
  /build\.gradle(\.kts)?$/, /settings\.gradle(\.kts)?$/,
  /\/buildSrc\//, /^buildSrc\//,
  /gradle\/.*\.gradle(\.kts)?$/,
  /Jenkinsfile$/,
  /Makefile$/, /makefile$/, /CMakeLists\.txt$/,

  // === C/C++ Native Extension Sources ===
  /\/src\/.*\.(c|cpp|h|hpp)$/, /\/_core\/.*\.(c|cpp|h|hpp)$/,
  /\/code_generators\//, /\/include\/.*\.(h|hpp)$/,

  // === CI Config Files ===
  /dangerfile\.[jt]s$/,

  // === Cypress Component Tests ===
  /\.cy\.[jt]sx?$/,

  // === Unit Test Files ===
  /\.unit\.([mc]?[jt]s|[jt]sx)$/,

  // === Visual Testing ===
  /\/chromatic\//, /^chromatic\//,

  // === Kubernetes/Deployment Patterns ===
  /\/hack\//, /^hack\//,
  /\/cluster\//, /^cluster\//,
  /\/staging\//, /^staging\//,

  // === Performance/Smoke Testing ===
  /smoke-test/, /performance-test/,

  // === Deprecated Packages ===
  /deprecated-packages?\//, /\/deprecated\//,

  // === Additional Test Directories ===
  /e2e-tests?\//, /\/intTest\//, /^intTest\//,
  /\/specs?\//, /^specs?\//,

  // === Broader Serverless Patterns ===
  /\/netlify\//, /^netlify\//,
  /\/vercel\//, /^vercel\//,
  /\/lambda\//, /^lambda\//,
  /\/functions\//, /^functions\//,

  // === Broader Codemod Patterns ===
  /-codemod\//, /codemod/,

  // === Internal Build Directories ===
  /\/cache-dir\//, /\/internal-plugins\//,

  // === Frontend Static/App Directories (Webpack/Vite) ===
  /\/static\/app\//, /^static\/app\//,
  /\/static\/gs/, /^static\/gs/,

  // === Ember.js Frontend Convention ===
  /frontend\/[^/]+\/app\//, /frontend\/discourse/,
  // Ember plugins with assets/javascripts (Discourse plugins, ember-addon plugins)
  /\/plugins\/[^/]+\/assets\/javascripts\//,
  /^plugins\/[^/]+\/assets\/javascripts\//,
  // Ember plugin admin assets (plugins/*/admin/assets/javascripts/)
  /\/plugins\/[^/]+\/admin\/assets\/javascripts\//,
  /^plugins\/[^/]+\/admin\/assets\/javascripts\//,
  // Discourse markdown engine extensions (loaded dynamically by discourse-markdown)
  /\/lib\/discourse-markdown\//,
  /^lib\/discourse-markdown\//,

  // === Icon and Illustration Libraries ===
  /\/icons?\//, /-icons-/, /icons-material/,
  /\/illustrations?\//, /spectrum-illustrations/,

  // === Recipe/Documentation Directories ===
  /\/recipes\//, /^recipes\//,

  // === Scoped Package Entries ===
  /^packages\/@[^/]+\/[^/]+\/src\/(index|main)\.([mc]?[jt]s|[jt]sx)$/,

  // === Dynamic Module Loaders (CodeMirror, Editors, Syntax Highlighters) ===
  /\/mode\/[^/]+\.js$/, /\/modes?\//, /^modes?\//,
  /\/languages?\/[^/]+\.(js|ts)$/, /\/lang\//, /^lang\//,
  /\/themes?\//, /^themes?\//,
  /\/grammars?\//, /^grammars?\//,
  /\/keymaps?\//, /^keymaps?\//,
  // Lunr search language plugins (loaded dynamically by lunr.js)
  /\/lunr-languages?\//, /^lunr-languages?\//,

  // === Documentation/Debug/Tools ===
  /\/docs?\//, /^docs?\//, /-docs\//, /_docs\//,
  /\/docs_src\//, /^docs_src\//,
  /\/documentation\//, /^documentation\//,
  /\/debug\//, /^debug\//,
  /\/tools\//, /^tools\//,

  // === Modules Directory ===
  /\/modules?\//,

  // === Generated Code ===
  /\/@generated\//, /\/_generated\//, /\/generated\//,

  // === Containers (Docker/test infrastructure) ===
  /\/containers\//,

  // === Meteor Package Files ===
  /\/meteor\//, /^meteor\//,

  // === Post-Build Scripts ===
  /^post[a-z]+\.(c|m)?js$/, /\/post[a-z]+\.(c|m)?js$/,

  // === Test Data ===
  /\/test_data\//, /\/test-data\//, /\/testdata\//,

  // === Reporters ===
  /\/reporters\//,

  // === Editor/IDE plugin dirs (snippets, extensions loaded dynamically at runtime) ===
  /\/snippets\/[^/]+\.[mc]?[jt]sx?$/,
  /\/ext\/[^/]+\.[mc]?[jt]sx?$/,

  // === Server-side Rendering ===
  /\/server\//, /^server\//,

  // === E2E test directories with tool-name suffix (e2e_playwright/, e2e_cypress/, etc.) ===
  /^e2e[_-]\w+\//, /\/e2e[_-]\w+\//,

  // === Files directly inside any /test/ directory (catches test files without .test. suffix) ===
  /\/test\/[^/]+\.([mc]?[jt]s|[jt]sx|py|rb|go|rs|java|kt|php)$/,

  // === Scoped package root entry points (packages/@scope/name/index.ts) ===
  /^packages\/@[^/]+\/[^/]+\/(index|main|server|app)\.([mc]?[jt]s|[jt]sx)$/,

  // === Deep nested pages/ for file-based routing (packages/dev/docs/pages/) ===
  /^packages\/[^/]+\/[^/]+\/pages\//,
  /^packages\/@[^/]+\/[^/]+\/pages\//,

  // === Rust integration tests (tests/*.rs auto-compiled by cargo test) ===
  /\/tests\/[^/]+\.rs$/,
  /^tests\/[^/]+\.rs$/,

  // === Rust trybuild/compile-test files ===
  // Includes ui/, trybuild/, compile-fail/, fail/, pass/, and macro test dirs
  /\/tests?\/(ui|ui-fail[^/]*|trybuild|compile-fail|compile-test|fail|pass|macros?|markup)\//, /^tests?\/(ui|ui-fail[^/]*|trybuild|compile-fail|compile-test|fail|pass|macros?|markup)\//,
  /\/tests?\/[^/]+\/(pass|fail)\//, /^tests?\/[^/]+\/(pass|fail)\//,
  // Rust formatting tool fixtures — .rs files used as test input/expected-output data (rustfmt, rustfix)
  /\/tests?\/(source|target)\/.*\.rs$/, /^tests?\/(source|target)\//,
  // Deep test fixture subdirectories — .rs files nested in named subdirs under tests/
  // e.g., tests/generate_migrations/diff_add_table/schema.rs, tests/print_schema/*/expected.rs
  /\/tests?\/.+\/.+\/.*\.rs$/, /^tests?\/.+\/.+\/.*\.rs$/,

  // === Rust crate resource directories (test fixtures, corpus data, benchmark inputs) ===
  // Files loaded via include_str!, include_bytes!, or std::fs at runtime
  // e.g., crates/ruff_python_parser/resources/valid/statement/match.py
  /\/resources\/(valid|invalid|corpus|inline|fixtures?|data|expected|err|ok)\//,
  // Resources/ dir inside crates/ (Rust workspace convention for test data)
  /crates\/[^/]+\/resources\//, /^crates\/[^/]+\/resources\//,

  // === Playground/dev directories (development environments) ===
  /\/playgrounds?\//, /^playgrounds?\//,
  /^[^/]+\/dev\//, /\/dev\/src\//,

  // === Codemod transform files (standalone CLI entry points for jscodeshift) ===
  /\/codemods?\/.*\/(transform|codemod)\.([mc]?[jt]s|[jt]sx)$/,

  // === Parcel plugins (loaded via .parcelrc config, not imports) ===
  /parcel-(transformer|resolver|namer|packager|optimizer|reporter|compressor|validator)\b/,

  // === setupTests files at any depth (loaded by jest/vitest setupFiles config) ===
  /setupTests\.([mc]?[jt]s|[jt]sx)$/,

  // === Root-level ESLint local rules file ===
  /^eslint[_-]?(local[_-])?rules?\.(c|m)?js$/,

  // === Rust tasks directory (build/codegen scripts) ===
  /^tasks\//, /\/tasks\/[^/]+\.(mjs|js|ts)$/,

  // === lib/ directory root (compiled package output consumed externally) ===
  /^lib\/[^/]+\.([mc]?[jt]s|[jt]sx)$/,

  // === modules/ npm sub-packages ===
  /^modules\/[^/]+\/[^/]+\.([mc]?[jt]s|[jt]sx)$/,

  // === Browser extension entry points (loaded via manifest.json) ===
  /(?:^|\/)(?:background|content[_-]?script|popup|options|devtools|sidebar|panel)\.[mc]?[jt]sx?$/,

  // === ESLint test fixtures (compiled but not imported — used as lint rule test cases) ===
  /\.test-lint\./,
  /eslint.*\/tests?\/.*fixtures?\//,

  // === Static assets embedded in packages (not imported, loaded at runtime as data) ===
  // Theme/package static JS assets (Sphinx themes, docs tooling)
  /\/themes?\/[^/]+\/static\//,
  // Minified/non-minified JS asset directories (stemmer JS files etc.)
  /\/(minified|non-minified)-js\//,

  // === E2E test app files (standalone applications used by test runners) ===
  /\/e2e\/.*\/src\//,
  /^e2e\/.*\/src\//,

  // === Vendored runtime patches (injected into node_modules, not imported) ===
  /\/extra\/[^/]+\/gen-[^/]+\.js$/,

  // === React JSX runtime files (loaded by JSX transform, not imported explicitly) ===
  /jsx-runtime\.([mc]?[jt]s|[jt]sx)$/,
  /jsx-dev-runtime\.([mc]?[jt]s|[jt]sx)$/,

  // === Gatsby convention files (loaded by Gatsby framework at build time) ===
  /gatsby-node\.([mc]?[jt]s|[jt]sx)$/,
  /gatsby-config\.([mc]?[jt]s|[jt]sx)$/,
  /gatsby-browser\.([mc]?[jt]s|[jt]sx)$/,
  /gatsby-ssr\.([mc]?[jt]s|[jt]sx)$/,

  // === Ember.js convention files (auto-discovered by Ember CLI at runtime) ===
  /ember-cli-build\.js$/,
  // Ember auto-resolved directories (any depth): controllers, models, routes, components, helpers, etc.
  /\/app\/(services|serializers|initializers|instance-initializers|adapters|transforms)\//,
  /\/app\/(controllers|models|routes|components|helpers|mixins|modifiers|machines|abilities)\//,
  // Mirage test fixtures (loaded by ember-cli-mirage)
  /\/mirage\/(config|scenarios|factories|fixtures|models|serializers|identity-managers)\//,
  /\/mirage\/config\.js$/,

  // === Generated Go mock files (mockery, gomock, etc.) ===
  /\/grpcmocks?\//, /^grpcmocks?\//,
  /\/mock_[^/]+\.go$/,
  /\/mocks?\/[^/]+\.go$/,

  // === Go generated code (detected by go generate convention) ===
  /zz_generated[_.].*\.go$/,

  // === Generated TypeScript/JavaScript (OpenAPI, GraphQL codegen, etc.) ===
  /\.gen\.([mc]?[jt]s|[jt]sx)$/,
  /\/openapi-gen\//, /^openapi-gen\//,
  /\/__generated__\//, /^__generated__\//,

  // === Preconstruct/build-time conditional modules ===
  /\/conditions\/(true|false|browser|worker|node)\.[mc]?[jt]sx?$/,

  // === Website/site directories (documentation sites, not library code) ===
  /\/website\//, /^website\//,
  /\/site\/src\//, /^site\/src\//,
];


/**
 * Extract JS/TS file references from npm scripts
 * @param {Object} packageJson - Package.json object
 * @param {string} packageDir - Directory of the package (for nested packages)
 * @returns {Set<string>} - Set of entry point paths
 */
function extractScriptEntryPoints(packageJson = {}, packageDir = '') {
  const entryPoints = new Set();
  const scripts = packageJson.scripts || {};

  for (const [scriptName, scriptCmd] of Object.entries(scripts)) {
    if (!scriptCmd) continue;

    // Match patterns like: node script.js, tsx script/build.ts, ts-node file.ts
    // Also handles: npx tsx file.ts, npm exec -- node file.js, cm-buildhelper src/html.ts
    const patterns = [
      // Direct node/tsx/ts-node execution: node file.js, tsx file.ts, node postcjs.cjs
      /(?:node|tsx|ts-node|npx\s+tsx|npx\s+ts-node)\s+([^\s&|;]+\.(?:[mc]?[jt]s|[jt]sx))/gi,
      // Build tools that take source file as argument: cm-buildhelper src/html.ts, lezer-generator src/grammar.ts
      /(?:cm-buildhelper|lezer-generator|esbuild|swc|rollup\s+-c|vite\s+build)\s+([^\s&|;]+\.(?:[mc]?[jt]s|[jt]sx))/gi,
      // Script paths without runner: ./scripts/foo.js
      /(?:^|\s)(\.?\.?\/[^\s&|;]+\.(?:[mc]?[jt]s|[jt]sx))/gi,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(scriptCmd)) !== null) {
        let entry = match[1];
        // Normalize path
        entry = entry.replace(/^\.\//, '');
        // Add package directory prefix for nested packages
        if (packageDir) {
          entry = join(packageDir, entry);
        }
        entryPoints.add(entry);
      }
    }
  }

  return entryPoints;
}

/**
 * Extract glob-based entry points from npm scripts.
 * Test runners like tape, mocha, ava, jest, jasmine, and generic node scripts
 * use glob patterns (e.g. tape test/glob.js, mocha src/glob.spec.js).
 * This function extracts those globs and expands them to actual files.
 * @param {Object} packageJson - Parsed package.json
 * @param {string} projectPath - Absolute path to project root
 * @param {string} [packageDir=''] - Relative dir of this package within the monorepo
 * @returns {Set<string>} - Set of matched file paths (relative to projectPath)
 */
function extractScriptGlobEntryPoints(packageJson = {}, projectPath, packageDir = '') {
  const entryPoints = new Set();
  if (!projectPath) return entryPoints;
  const scripts = packageJson.scripts || {};

  // Test runner commands that take glob arguments
  const testRunners = /(?:tape|faucet|mocha|ava|jest|jasmine|nyc\s+(?:mocha|ava|tape)|c8\s+(?:mocha|ava|tape)|node\s+-e\s+.*require|tap)/;

  for (const [scriptName, scriptCmd] of Object.entries(scripts)) {
    if (!scriptCmd) continue;

    // Only look in test/build-related scripts for glob patterns
    if (!testRunners.test(scriptCmd)) continue;

    // Extract glob patterns: quoted or unquoted args that contain * or **
    // e.g. tape 'test/**/*.js'  or  mocha test/**/*.spec.js
    const globPattern = /(?:['"]([^'"]*\*[^'"]*)['"]\s*|(?:\s)((?:[^\s&|;'"]*\*[^\s&|;'"]*))\s*)/g;
    let match;
    while ((match = globPattern.exec(scriptCmd)) !== null) {
      let pattern = match[1] || match[2];
      if (!pattern) continue;
      // Skip patterns that don't look like file paths
      if (pattern.startsWith('-') || pattern.includes('=')) continue;

      // Prefix with package directory for nested packages
      const resolvedPattern = packageDir ? join(packageDir, pattern) : pattern;

      try {
        const matched = globSync(resolvedPattern, {
          cwd: projectPath,
          nodir: true,
          ignore: ['node_modules/**', 'dist/**', 'build/**', '.git/**']
        });
        for (const f of matched) {
          entryPoints.add(f.replace(/\\/g, '/'));
        }
      } catch { /* skip invalid globs */ }
    }
  }

  return entryPoints;
}

/**
 * Extract script entry points from all nested packages in a monorepo
 * @param {string} projectPath - Project root path
 * @returns {Set<string>} - Set of all script entry point paths
 */
function extractAllScriptEntryPoints(projectPath) {
  const allEntryPoints = new Set();
  const nestedPackages = findNestedPackageJsons(projectPath);

  for (const [pkgDir, pkgJson] of nestedPackages) {
    const entries = extractScriptEntryPoints(pkgJson, pkgDir);
    for (const entry of entries) {
      allEntryPoints.add(entry);
    }
    // Also expand glob patterns from npm scripts
    const globEntries = extractScriptGlobEntryPoints(pkgJson, projectPath, pkgDir);
    for (const entry of globEntries) {
      allEntryPoints.add(entry);
    }
  }

  return allEntryPoints;
}

/**
 * Find entry points referenced by HTML files
 */
function extractHtmlEntryPoints(projectPath) {
  const entryPoints = new Set();

  if (!projectPath) return entryPoints;

  try {
    // Find HTML files in common locations (including deeply nested workspaces)
    const htmlPatterns = [
      'index.html',
      'public/index.html',
      'client/index.html',
      'src/index.html',
      '*/index.html',
      '*/*/index.html',
      '**/index.html'
    ];

    for (const pattern of htmlPatterns) {
      try {
        const htmlFiles = globSync(pattern, {
          cwd: projectPath,
          nodir: true,
          ignore: ['node_modules/**', 'dist/**', 'build/**', '.git/**', 'vendor/**', 'coverage/**', '__fixtures__/**', 'test-fixtures/**']
        });

        for (const htmlFile of htmlFiles) {
          try {
            const htmlPath = join(projectPath, htmlFile);
            const htmlContent = readFileSync(htmlPath, 'utf-8');
            const htmlDir = dirname(htmlFile);

            // Match <script src="..."> and <script type="module" src="...">
            const scriptPattern = /<script[^>]*\ssrc=["']([^"']+\.(?:[mc]?[jt]s|[jt]sx))["'][^>]*>/gi;
            let match;
            while ((match = scriptPattern.exec(htmlContent)) !== null) {
              let src = match[1];
              // Handle relative paths from HTML file location
              if (src.startsWith('./')) {
                src = join(htmlDir, src.slice(2));
              } else if (src.startsWith('/')) {
                // Absolute paths in Vite are relative to the directory containing index.html
                // (the Vite project root), not the monorepo root
                src = join(htmlDir, src.slice(1));
              } else if (!src.startsWith('http')) {
                src = join(htmlDir, src);
              }
              // Normalize
              src = src.replace(/\\/g, '/').replace(/^\.\//, '');
              entryPoints.add(src);
            }
          } catch {
            // Ignore read errors for individual HTML files
          }
        }
      } catch {
        // Ignore glob errors
      }
    }
  } catch {
    // Ignore errors
  }

  return entryPoints;
}

/**
 * Extract source files from Gruntfile.js/Gulpfile.js concat/uglify tasks.
 * Concatenation-based builds (RxJS v4, older jQuery plugins) stitch files together
 * without import/require, so the scanner can't trace them via the import graph.
 * @param {string} projectPath - Project root path
 * @returns {Set<string>} - Set of source file paths referenced by concat tasks
 */
function extractGruntConcatSources(projectPath) {
  const entryPoints = new Set();
  if (!projectPath) return entryPoints;

  const gruntFiles = ['Gruntfile.js', 'Gruntfile.coffee', 'gruntfile.js'];
  const gulpFiles = ['gulpfile.js', 'gulpfile.mjs', 'Gulpfile.js'];

  for (const file of [...gruntFiles, ...gulpFiles]) {
    try {
      const filePath = join(projectPath, file);
      if (!existsSync(filePath)) continue;
      const content = readFileSync(filePath, 'utf-8');

      // Extract glob patterns from concat/uglify src arrays
      // Matches patterns like: src: ['src/**/*.js'], files: { 'dest': ['src/core/*.js'] }
      const srcPatterns = [];

      // Match src array patterns: src: ['pattern1', 'pattern2']
      const srcArrayRe = /src\s*:\s*\[([^\]]+)\]/g;
      let match;
      while ((match = srcArrayRe.exec(content)) !== null) {
        const items = match[1].match(/['"]([^'"]+)['"]/g);
        if (items) {
          for (const item of items) {
            srcPatterns.push(item.replace(/['"]/g, ''));
          }
        }
      }

      // Match files object: files: { 'output.js': ['src/**/*.js'] }
      const filesObjRe = /['"][^'"]+['"]\s*:\s*\[([^\]]+)\]/g;
      while ((match = filesObjRe.exec(content)) !== null) {
        const items = match[1].match(/['"]([^'"]+)['"]/g);
        if (items) {
          for (const item of items) {
            srcPatterns.push(item.replace(/['"]/g, ''));
          }
        }
      }

      // Also match gulp.src('pattern') or gulp.src(['pattern1', 'pattern2'])
      const gulpSrcRe = /\.src\s*\(\s*(?:\[([^\]]+)\]|['"]([^'"]+)['"])/g;
      while ((match = gulpSrcRe.exec(content)) !== null) {
        if (match[1]) {
          const items = match[1].match(/['"]([^'"]+)['"]/g);
          if (items) {
            for (const item of items) {
              srcPatterns.push(item.replace(/['"]/g, ''));
            }
          }
        } else if (match[2]) {
          srcPatterns.push(match[2]);
        }
      }

      // Expand globs to actual files
      for (const pattern of srcPatterns) {
        // Skip non-JS patterns and negation patterns
        if (pattern.startsWith('!')) continue;
        if (!pattern.match(/\.(js|ts|mjs|cjs|jsx|tsx|coffee)$/i) && !pattern.includes('*')) continue;

        try {
          const matched = globSync(pattern, {
            cwd: projectPath,
            nodir: true,
            ignore: ['node_modules/**', 'dist/**', 'build/**', '.git/**']
          });
          for (const f of matched) {
            entryPoints.add(f.replace(/\\/g, '/'));
          }
        } catch { /* skip invalid globs */ }
      }
    } catch { /* skip read errors */ }
  }

  return entryPoints;
}

/**
 * Extract entry points from tsconfig.json `files` and `include` arrays.
 * TypeScript projects often use `/// <reference>` directives and tsconfig `files` arrays
 * to link files without import/require statements (e.g., RxJS ts/core/).
 * Also handles `include` glob patterns.
 * @param {string} projectPath - Project root path
 * @returns {Set<string>} - Set of file paths declared in tsconfig files/include
 */
function extractTsconfigFileEntries(projectPath) {
  const entryPoints = new Set();
  if (!projectPath) return entryPoints;

  try {
    // Find all tsconfig*.json files (root + packages)
    const tsconfigPatterns = [
      'tsconfig.json', 'tsconfig.*.json',
      '**/tsconfig.json', '**/tsconfig.*.json',
    ];

    const tsconfigFiles = new Set();
    for (const pattern of tsconfigPatterns) {
      try {
        const matches = globSync(pattern, {
          cwd: projectPath,
          nodir: true,
          ignore: ['node_modules/**', 'dist/**', 'build/**', '.git/**']
        });
        for (const m of matches) tsconfigFiles.add(m);
      } catch { /* skip */ }
    }

    for (const tsconfigFile of tsconfigFiles) {
      try {
        const tsconfigPath = join(projectPath, tsconfigFile);
        const raw = readFileSync(tsconfigPath, 'utf-8');
        // Strip comments (tsconfig allows // and /* */ comments)
        const cleaned = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const tsconfig = JSON.parse(cleaned);
        const tsconfigDir = dirname(tsconfigFile);

        // Process `files` array — explicit file list
        if (Array.isArray(tsconfig.files)) {
          for (const f of tsconfig.files) {
            if (typeof f !== 'string') continue;
            // Resolve relative to tsconfig's directory
            let resolved = join(tsconfigDir, f).replace(/\\/g, '/');
            resolved = resolved.replace(/^\.\//, '');
            entryPoints.add(resolved);
          }
        }

        // Process `include` array — glob patterns
        if (Array.isArray(tsconfig.include)) {
          for (const pattern of tsconfig.include) {
            if (typeof pattern !== 'string') continue;
            // Resolve the glob relative to tsconfig's directory
            const resolvedPattern = tsconfigDir ? join(tsconfigDir, pattern) : pattern;
            try {
              const matched = globSync(resolvedPattern, {
                cwd: projectPath,
                nodir: true,
                ignore: ['node_modules/**', 'dist/**', 'build/**', '.git/**']
              });
              for (const f of matched) {
                entryPoints.add(f.replace(/\\/g, '/'));
              }
            } catch { /* skip invalid globs */ }
          }
        }
      } catch { /* skip unreadable/malformed tsconfig */ }
    }
  } catch { /* skip */ }

  return entryPoints;
}

/**
 * Extract Vite alias replacement files as entry points
 * These are files used as module replacements in vite.config resolve.alias
 * Pattern: { find: 'module-name', replacement: resolve(__dirname, 'path/to/replacement') }
 * @param {string} projectPath - Project root path
 * @returns {Set<string>} - Set of replacement file paths
 */
function extractViteReplacementEntryPoints(projectPath) {
  const entryPoints = new Set();
  if (!projectPath) return entryPoints;

  try {
    // Find vite config files in all packages
    const viteConfigPatterns = [
      'vite.config.ts',
      'vite.config.mts',
      'vite.config.js',
      'vite.config.mjs',
      'packages/**/vite.config.ts',
      'packages/**/vite.config.mts',
      'packages/**/vite.config.js',
      'packages/**/vite.config.mjs'
    ];

    for (const pattern of viteConfigPatterns) {
      try {
        const configFiles = globSync(pattern, {
          cwd: projectPath,
          nodir: true,
          ignore: ['node_modules/**', 'dist/**', 'build/**']
        });

        for (const configFile of configFiles) {
          try {
            const configPath = join(projectPath, configFile);
            const configContent = readFileSync(configPath, 'utf-8');
            const configDir = dirname(configFile);

            // Match replacement patterns in resolve.alias configurations
            // Pattern 1: replacement: resolve(__dirname, 'path/to/file')
            const replacementPattern1 = /replacement:\s*resolve\s*\(\s*__dirname\s*,\s*['"]([^'"]+)['"]\s*\)/gi;
            // Pattern 2: replacement: './path/to/file' or replacement: "/path/to/file"
            const replacementPattern2 = /replacement:\s*['"]([^'"]+)['"]/gi;

            const patterns = [replacementPattern1, replacementPattern2];
            for (const pattern of patterns) {
              let match;
              while ((match = pattern.exec(configContent)) !== null) {
                let replacementPath = match[1];
                // Normalize path
                replacementPath = replacementPath.replace(/^\.\//, '');
                // Combine with config directory
                const fullPath = join(configDir, replacementPath);
                // Add common extensions if no extension
                if (!/\.[mc]?[jt]sx?$/.test(fullPath)) {
                  entryPoints.add(fullPath + '.ts');
                  entryPoints.add(fullPath + '.mts');
                  entryPoints.add(fullPath + '.js');
                  entryPoints.add(fullPath + '.mjs');
                } else {
                  entryPoints.add(fullPath);
                }
              }
            }
          } catch {
            // Ignore read errors for individual config files
          }
        }
      } catch {
        // Ignore glob errors
      }
    }
  } catch {
    // Ignore errors
  }

  return entryPoints;
}

/**
 * Check if a file is an entry point (should not be flagged as dead)
 * @param {string} filePath - Relative file path
 * @param {Object} packageJson - Parsed package.json
 * @param {string} projectPath - Project root path
 * @param {Set} htmlEntryPoints - Entry points from HTML files
 * @param {Set} scriptEntryPoints - Entry points from npm scripts
 * @param {Array} fileClasses - Parsed class info with decorators (for DI detection)
 */
function isEntryPoint(filePath, packageJson = {}, projectPath = null, htmlEntryPoints = null, scriptEntryPoints = null, fileClasses = null) {
  // Heuristic: Files in directories with "dead", "deprecated", "legacy", "old", "unused"
  // in the name are likely not active code - don't treat as entry points
  // Also check file names containing these words, or files named exactly "dead.ext"
  const deadDirPatterns = /(^|\/)(dead[-_]|deprecated[-_]|legacy[-_]|old[-_]|unused[-_])/i;
  const deadFilePatterns = /(^|\/)(dead[-_]|deprecated[-_]|legacy[-_]|old[-_]|unused[-_])[^/]*\.[^/]+$/i;
  const deadFileExact = /(^|\/)dead\.[^/]+$/i;  // matches dead.go, dead.py, etc.
  if (deadDirPatterns.test(filePath) || deadFilePatterns.test(filePath) || deadFileExact.test(filePath)) {
    return { isEntry: false, reason: 'In dead/deprecated/legacy directory or file name' };
  }

  // Check if file is main entry for a nested monorepo package
  // This MUST run before ENTRY_POINT_PATTERNS because abandoned workspace packages
  // would otherwise match generic patterns like packages/*/src/index.js
  const nestedPkgCheck = isNestedPackageMain(filePath, projectPath);
  if (nestedPkgCheck.isMain) {
    return { isEntry: true, reason: `Main entry for package ${nestedPkgCheck.packageName || nestedPkgCheck.packageDir}` };
  }
  // If file is in an abandoned workspace package, don't let it match generic patterns
  // EXCEPTION: playground/example/demo directories are inherently test/dev directories
  // and should still be treated as entry points even if they're in abandoned packages
  if (nestedPkgCheck.isAbandoned) {
    const isDevDirectory = /(?:^|\/)(playgrounds?|examples?|demos?|samples?|fixtures?|templates?|starters?|__tests__|tests?)(?:\/|$)/i.test(filePath);
    if (!isDevDirectory) {
      return { isEntry: false, reason: 'In abandoned workspace package' };
    }
  }

  // Check against patterns (using full path relative to project root)
  if (ENTRY_POINT_PATTERNS.some(p => p.test(filePath))) {
    return { isEntry: true, reason: 'Matches entry point pattern' };
  }

  // For files inside nested packages (independent sub-projects), also check patterns
  // against the path relative to the package root. This handles "collection" repos
  // (e.g., vercel/examples) where each sub-dir has its own package.json and conventions.
  // Example: framework-boilerplates/hydrogen/src/routes/page.tsx
  //   → checked as "src/routes/page.tsx" relative to hydrogen package root
  //   → matches ^src/routes/ pattern
  if (nestedPkgCheck.packageDir) {
    const relToPackage = filePath.slice(nestedPkgCheck.packageDir.length + 1);
    if (relToPackage && ENTRY_POINT_PATTERNS.some(p => p.test(relToPackage))) {
      return { isEntry: true, reason: 'Matches entry point pattern (relative to package root)' };
    }
  }

  // Check for DI-decorated classes (@Service, @Injectable, etc.)
  if (fileClasses?.length) {
    for (const cls of fileClasses) {
      const diCheck = hasDIDecorators(cls);
      if (diCheck.hasDI) {
        return {
          isEntry: true,
          reason: `Class ${cls.name} has DI decorator: @${diCheck.decorators[0]}`,
          isDynamic: true
        };
      }
    }
  }

  // Check framework-specific entry points (NestJS, Vue, Pinia, etc.)
  const frameworkCheck = checkFrameworkEntry(filePath);
  if (frameworkCheck.isEntry) {
    return { isEntry: true, reason: frameworkCheck.reason, isDynamic: true };
  }

  // Check package.json main
  if (packageJson.main) {
    const main = packageJson.main.replace(/^\.\//, '');
    if (filePath === main || filePath.endsWith(main)) {
      return { isEntry: true, reason: 'Package main entry' };
    }
  }

  // Check package.json source field (used by some packages to point to source entry)
  if (packageJson.source) {
    const source = packageJson.source.replace(/^\.\//, '');
    if (filePath === source || filePath.endsWith(source)) {
      return { isEntry: true, reason: 'Package source entry' };
    }
  }

  // When main/module/exports points to a build directory (lib/, dist/, build/, out/),
  // map back to source equivalents (src/) since we analyze source, not build output.
  // e.g., main: "lib/framework.js" → check src/framework.ts, src/index.ts, etc.
  const buildDirPattern = /^(lib|dist|build|out)(\/|$)/;
  const sourceExtensions = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx'];
  const buildEntries = [
    packageJson.main,
    packageJson.module,
    ...(packageJson.source ? [] : []) // skip if source field exists (handled above)
  ].filter(Boolean);

  for (const entry of buildEntries) {
    const entryPath = entry.replace(/^\.\//, '');
    if (buildDirPattern.test(entryPath)) {
      // Map lib/framework.js → src/framework, then try extensions
      const sourceStem = entryPath
        .replace(buildDirPattern, 'src/')
        .replace(/\.[mc]?[jt]sx?$/, '');
      for (const ext of sourceExtensions) {
        const sourcePath = sourceStem + ext;
        if (filePath === sourcePath || filePath.endsWith('/' + sourcePath)) {
          return { isEntry: true, reason: 'Package main (source equivalent)' };
        }
      }
      // Also check src/index.ts, src/main.ts as common fallback entry points
      const buildDir = entryPath.match(buildDirPattern)[1];
      const commonEntries = ['src/index', 'src/main', 'src/entry-bundler', 'src/entry'];
      for (const common of commonEntries) {
        for (const ext of sourceExtensions) {
          const candidate = common + ext;
          if (filePath === candidate || filePath.endsWith('/' + candidate)) {
            return { isEntry: true, reason: `Package main (source fallback for ${buildDir}/)` };
          }
        }
      }
      // When main points to a build dir (lib/, dist/), all src/ files are part of
      // the published package. Mark them as entry points — many libraries use dynamic
      // require/import patterns that can't be traced statically.
      if (filePath.startsWith('src/') || filePath.includes('/src/')) {
        return { isEntry: true, reason: `Package source (build dir ${buildDir}/ detected)` };
      }
    }
  }

  // When package has no entry point fields (main, module, exports, source),
  // files directly in src/ are likely entry points (e.g., Swiper's src/swiper.mjs).
  // These packages expose their source directly without a build step.
  if (!packageJson.main && !packageJson.module && !packageJson.exports && !packageJson.source) {
    if (/^src\/[^/]+\.[mc]?[jt]sx?$/.test(filePath)) {
      return { isEntry: true, reason: 'Source root file (no package entry points configured)' };
    }
  }

  // Check package.json bin
  if (packageJson.bin) {
    const bins = typeof packageJson.bin === 'string'
      ? [packageJson.bin]
      : Object.values(packageJson.bin);
    for (const bin of bins) {
      const binPath = bin.replace(/^\.\//, '');
      if (filePath === binPath || filePath.endsWith(binPath)) {
        return { isEntry: true, reason: 'Package bin entry' };
      }
    }
  }

  // Check package.json exports
  if (packageJson.exports) {
    const checkExports = (exp) => {
      if (typeof exp === 'string') {
        const expPath = exp.replace(/^\.\//, '');
        if (filePath === expPath || filePath.endsWith(expPath)) {
          return true;
        }
        // Also check source equivalent when export points to build dir
        if (buildDirPattern.test(expPath)) {
          const sourceStem = expPath.replace(buildDirPattern, 'src/').replace(/\.[mc]?[jt]sx?$/, '');
          for (const ext of sourceExtensions) {
            if (filePath === sourceStem + ext || filePath.endsWith('/' + sourceStem + ext)) {
              return true;
            }
          }
        }
      } else if (typeof exp === 'object') {
        return Object.values(exp).some(v => checkExports(v));
      }
      return false;
    };
    if (checkExports(packageJson.exports)) {
      return { isEntry: true, reason: 'Package exports entry' };
    }
  }

  // Check npm script entry points
  if (scriptEntryPoints) {
    for (const entry of scriptEntryPoints) {
      if (filePath === entry || filePath.endsWith('/' + entry) || entry.endsWith('/' + filePath)) {
        return { isEntry: true, reason: 'Referenced in npm script' };
      }
    }
  }

  // Check HTML entry points (e.g., <script src="main.tsx">)
  if (htmlEntryPoints) {
    for (const entry of htmlEntryPoints) {
      // Match with or without extension, handle src/ prefix variations
      const fileNoExt = filePath.replace(/\.([mc]?[jt]s|[jt]sx)$/, '');
      const entryNoExt = entry.replace(/\.([mc]?[jt]s|[jt]sx)$/, '');
      if (filePath === entry || fileNoExt === entryNoExt ||
          filePath.endsWith('/' + entry) || entry.endsWith('/' + filePath)) {
        return { isEntry: true, reason: 'Referenced in HTML file' };
      }
    }
  }

  // Check bundler/CI config entry points (webpack, vite, GitHub Actions, etc.)
  const configCheck = checkConfigEntry(filePath);
  if (configCheck.isConfigEntry) {
    return { isEntry: true, reason: 'Bundler/CI config entry point', source: configCheck.source };
  }

  // Check for plugin/extension entry points declared in package.json
  // Uses configurable DYNAMIC_PACKAGE_FIELDS and searches recursively
  const dynamicEntryFields = extractDynamicPaths(packageJson);

  for (const entryPath of dynamicEntryFields) {
    // Convert dist path to source: dist/path/file.js -> path/file.ts
    const sourcePath = entryPath
      .replace(/^dist\//, '')
      .replace(/\.js$/, '.ts');
    if (filePath === sourcePath || filePath.endsWith('/' + sourcePath) ||
        filePath === entryPath || filePath.endsWith('/' + entryPath)) {
      return { isEntry: true, reason: 'Plugin entry point (from package.json)', isDynamic: true };
    }
  }

  // Check dynamic loading patterns from config
  for (let i = 0; i < DYNAMIC_PATTERNS.length; i++) {
    if (DYNAMIC_PATTERNS[i].test(filePath)) {
      return {
        isEntry: true,
        reason: `Matches dynamic loading pattern: ${DYNAMIC_PATTERN_SOURCES[i]}`,
        isDynamic: true,
        matchedPattern: DYNAMIC_PATTERN_SOURCES[i]
      };
    }
  }

  return { isEntry: false };
}

/**
 * Parse exports from a file using Babel AST
 */
function parseExports(content, filePath) {
  const exports = [];

  try {
    const ast = parse(content, {
      sourceType: 'module',
      plugins: [
        'jsx',
        'typescript',
        'decorators-legacy',
        'classProperties',
        'classPrivateProperties',
        'classPrivateMethods',
        'exportDefaultFrom',
        'exportNamespaceFrom',
        'dynamicImport',
        'nullishCoalescingOperator',
        'optionalChaining'
      ],
      errorRecovery: true
    });

    traverse(ast, {
      ExportNamedDeclaration(path) {
        const decl = path.node.declaration;
        const loc = path.node.loc;

        if (decl) {
          if (decl.type === 'FunctionDeclaration' && decl.id) {
            exports.push({
              name: decl.id.name,
              type: 'function',
              line: decl.loc?.start?.line || loc?.start?.line,
              lineEnd: decl.loc?.end?.line || loc?.end?.line,
              async: decl.async || false
            });
          } else if (decl.type === 'VariableDeclaration') {
            for (const declarator of decl.declarations) {
              if (declarator.id?.name) {
                // Determine the actual type
                let varType = 'const';
                if (declarator.init) {
                  if (declarator.init.type === 'ArrowFunctionExpression' ||
                      declarator.init.type === 'FunctionExpression') {
                    varType = 'function';
                  } else if (declarator.init.type === 'ObjectExpression') {
                    varType = 'object';
                  } else if (declarator.init.type === 'ArrayExpression') {
                    varType = 'array';
                  }
                }
                exports.push({
                  name: declarator.id.name,
                  type: varType,
                  line: declarator.loc?.start?.line || loc?.start?.line,
                  lineEnd: declarator.loc?.end?.line || loc?.end?.line
                });
              }
            }
          } else if (decl.type === 'ClassDeclaration' && decl.id) {
            exports.push({
              name: decl.id.name,
              type: 'class',
              line: decl.loc?.start?.line || loc?.start?.line,
              lineEnd: decl.loc?.end?.line || loc?.end?.line
            });
          } else if (decl.type === 'TSEnumDeclaration' && decl.id) {
            exports.push({
              name: decl.id.name,
              type: 'enum',
              line: decl.loc?.start?.line || loc?.start?.line,
              lineEnd: decl.loc?.end?.line || loc?.end?.line
            });
          } else if (decl.type === 'TSTypeAliasDeclaration' || decl.type === 'TSInterfaceDeclaration') {
            if (decl.id) {
              exports.push({
                name: decl.id.name,
                type: 'type',
                line: decl.loc?.start?.line || loc?.start?.line,
                lineEnd: decl.loc?.end?.line || loc?.end?.line
              });
            }
          }
        }

        // Handle export { foo, bar } and export { foo as bar }
        if (path.node.specifiers) {
          for (const spec of path.node.specifiers) {
            if (spec.exported?.name) {
              exports.push({
                name: spec.exported.name,
                type: 'reexport',
                localName: spec.local?.name,
                line: loc?.start?.line,
                lineEnd: loc?.end?.line
              });
            }
          }
        }
      },

      ExportDefaultDeclaration(path) {
        const decl = path.node.declaration;
        const loc = path.node.loc;

        let type = 'default';
        let name = 'default';

        if (decl) {
          if (decl.type === 'FunctionDeclaration') {
            type = 'function';
            name = decl.id?.name || 'default';
          } else if (decl.type === 'ClassDeclaration') {
            type = 'class';
            name = decl.id?.name || 'default';
          } else if (decl.type === 'Identifier') {
            name = decl.name;
          }
        }

        exports.push({
          name,
          type,
          isDefault: true,
          line: loc?.start?.line,
          lineEnd: decl?.loc?.end?.line || loc?.end?.line
        });
      },

      // Handle module.exports = ... (CommonJS)
      AssignmentExpression(path) {
        const left = path.node.left;
        if (left?.type === 'MemberExpression' &&
            left.object?.name === 'module' &&
            left.property?.name === 'exports') {
          exports.push({
            name: 'default',
            type: 'commonjs',
            isDefault: true,
            line: path.node.loc?.start?.line,
            lineEnd: path.node.loc?.end?.line
          });
        }
        // Handle exports.foo = ...
        if (left?.type === 'MemberExpression' &&
            left.object?.name === 'exports' &&
            left.property?.name) {
          exports.push({
            name: left.property.name,
            type: 'commonjs',
            line: path.node.loc?.start?.line,
            lineEnd: path.node.loc?.end?.line
          });
        }
      }
    });

  } catch (error) {
    // Fallback to regex for unparseable files
    return parseExportsRegex(content);
  }

  return exports;
}

/**
 * Fallback regex-based export parsing
 */
function parseExportsRegex(content) {
  const exports = [];
  const lines = content.split('\n');

  const patterns = [
    { regex: /^export\s+async\s+function\s+(\w+)/, type: 'function' },
    { regex: /^export\s+function\s+(\w+)/, type: 'function' },
    { regex: /^export\s+const\s+(\w+)/, type: 'const' },
    { regex: /^export\s+let\s+(\w+)/, type: 'let' },
    { regex: /^export\s+var\s+(\w+)/, type: 'var' },
    { regex: /^export\s+class\s+(\w+)/, type: 'class' },
    { regex: /^export\s+default\s+function\s+(\w+)?/, type: 'function', isDefault: true },
    { regex: /^export\s+default\s+class\s+(\w+)?/, type: 'class', isDefault: true },
    { regex: /^export\s+default\s+/, type: 'default', isDefault: true }
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    for (const { regex, type, isDefault } of patterns) {
      const match = line.match(regex);
      if (match) {
        exports.push({
          name: match[1] || 'default',
          type,
          isDefault: isDefault || false,
          line: i + 1,
          lineEnd: findEndLine(lines, i)
        });
        break;
      }
    }
  }

  return exports;
}

/**
 * Find the end line of a code block
 */
function findEndLine(lines, startIndex) {
  let braceCount = 0;
  let started = false;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];

    for (const char of line) {
      if (char === '{') {
        braceCount++;
        started = true;
      } else if (char === '}') {
        braceCount--;
        if (started && braceCount === 0) {
          return i + 1;
        }
      }
    }

    // Single line export (no braces)
    if (i === startIndex && !line.includes('{') && (line.endsWith(';') || line.endsWith(','))) {
      return i + 1;
    }
  }

  return startIndex + 1;
}

/**
 * Calculate byte size of an export based on line range
 */
function calculateExportSize(content, lineStart, lineEnd) {
  const lines = content.split('\n');
  let size = 0;

  for (let i = lineStart - 1; i < Math.min(lineEnd, lines.length); i++) {
    size += (lines[i]?.length || 0) + 1; // +1 for newline
  }

  return size;
}

/**
 * Check if an export is used internally within the same file
 */
function checkInternalUsage(exportName, content, allExports) {
  // Don't count the export declaration itself
  // Look for usage patterns: function calls, variable references

  const usagePatterns = [
    new RegExp(`\\b${exportName}\\s*\\(`, 'g'),           // Function call
    new RegExp(`\\b${exportName}\\s*\\.`, 'g'),           // Property access
    new RegExp(`\\[\\s*${exportName}\\s*\\]`, 'g'),       // Bracket notation
    new RegExp(`:\\s*${exportName}\\b`, 'g'),             // Object shorthand or type
    new RegExp(`=\\s*${exportName}\\b`, 'g'),             // Assignment
    new RegExp(`\\(\\s*${exportName}\\s*[,)]`, 'g'),      // Function argument
  ];

  // Remove the export lines to avoid false positives
  const lines = content.split('\n');
  const contentWithoutExport = lines.filter((_, i) => {
    const lineNum = i + 1;
    return !allExports.some(e => lineNum >= e.line && lineNum <= (e.lineEnd || e.line));
  }).join('\n');

  for (const pattern of usagePatterns) {
    if (pattern.test(contentWithoutExport)) {
      return true;
    }
  }

  return false;
}

/**
 * Find files that import a specific export from a file
 */
function findImportersOfExport(exportName, filePath, importGraph, jsAnalysis) {
  const importers = [];
  const fileBasename = basename(filePath).replace(/\.([mc]?[jt]s|[jt]sx)$/, '');

  for (const file of jsAnalysis) {
    const importerPath = file.file?.relativePath || file.file;
    if (importerPath === filePath) continue;

    const content = file.content || '';

    // Check for named imports: import { exportName } from './file'
    // or import { exportName as alias } from './file'
    // Note: fileBasename does NOT include extension, so we match it followed by optional extension
    const namedImportPattern = new RegExp(
      `import\\s*\\{[^}]*\\b${exportName}\\b[^}]*\\}\\s*from\\s*['"][^'"]*${fileBasename}(?:\\.[^'"]*)?['"]`,
      'g'
    );

    // Check for namespace imports: import * as ns from './file' then ns.exportName
    const namespacePattern = new RegExp(
      `import\\s*\\*\\s*as\\s+(\\w+)\\s*from\\s*['"][^'"]*${fileBasename}(?:\\.[^'"]*)?['"]`,
      'g'
    );

    // Check for default import if this is a default export
    const defaultImportPattern = new RegExp(
      `import\\s+(\\w+)\\s*from\\s*['"][^'"]*${fileBasename}(?:\\.[^'"]*)?['"]`,
      'g'
    );

    // Check for require
    const requirePattern = new RegExp(
      `require\\s*\\(\\s*['"][^'"]*${fileBasename}(?:\\.[^'"]*)?['"]\\s*\\)\\s*\\.\\s*${exportName}`,
      'g'
    );

    let match;

    // Named imports
    if ((match = namedImportPattern.exec(content))) {
      const line = content.substring(0, match.index).split('\n').length;
      importers.push({
        file: importerPath,
        line,
        type: 'named'
      });
      continue;
    }

    // Namespace imports - need to check if ns.exportName is used
    while ((match = namespacePattern.exec(content))) {
      const nsName = match[1];
      const usagePattern = new RegExp(`\\b${nsName}\\.${exportName}\\b`);
      if (usagePattern.test(content)) {
        const line = content.substring(0, match.index).split('\n').length;
        importers.push({
          file: importerPath,
          line,
          type: 'namespace'
        });
        break;
      }
    }

    // Default imports (only for default exports)
    if (exportName === 'default' && defaultImportPattern.test(content)) {
      const match = defaultImportPattern.exec(content);
      if (match) {
        const line = content.substring(0, match.index).split('\n').length;
        importers.push({
          file: importerPath,
          line,
          type: 'default'
        });
      }
    }

    // Require
    if ((match = requirePattern.exec(content))) {
      const line = content.substring(0, match.index).split('\n').length;
      importers.push({
        file: importerPath,
        line,
        type: 'require'
      });
    }
  }

  return importers;
}

/**
 * Get git history for when an export was last imported
 */
function getExportGitHistory(filePath, exportName, projectPath) {
  if (!projectPath) return { available: false, reason: 'No project path' };

  try {
    // Check if we're in a git repo
    try {
      execSync('git rev-parse --git-dir', { cwd: projectPath, stdio: 'pipe', timeout: 5000 });
    } catch {
      return { available: false, reason: 'Not a git repository' };
    }

    const fileBasename = basename(filePath).replace(/\.([mc]?[jt]s|[jt]sx)$/, '');

    // Search for commits that removed imports of this export
    // Use -S to find commits where the string was added or removed
    const searchPattern = `${exportName}.*from.*${fileBasename}`;

    let lastImportCommit;
    try {
      lastImportCommit = execSync(
        `git log -1 --all -p -S "${exportName}" --grep="" --format="%H|%ae|%aI|%s" -- "*.js" "*.jsx" "*.ts" "*.tsx" "*.mjs" 2>/dev/null | head -1`,
        { cwd: projectPath, encoding: 'utf-8', timeout: 15000 }
      ).trim();
    } catch {
      lastImportCommit = '';
    }

    if (!lastImportCommit || !lastImportCommit.includes('|')) {
      // Try finding when the export was created
      let createdCommit;
      try {
        createdCommit = execSync(
          `git log --follow --diff-filter=A --format="%H|%ae|%aI|%s" -- "${filePath}" 2>/dev/null | tail -1`,
          { cwd: projectPath, encoding: 'utf-8', timeout: 10000 }
        ).trim();
      } catch {
        createdCommit = '';
      }

      if (createdCommit && createdCommit.includes('|')) {
        const [commit, author, date, message] = createdCommit.split('|');
        return {
          everImported: false,
          createdIn: { commit, author, date, message },
          note: 'No import history found - may have never been used'
        };
      }

      return { available: false, reason: 'No git history found' };
    }

    const [commit, author, date, message] = lastImportCommit.split('|');
    const daysDead = Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24));

    // Try to find which file had the import
    let affectedFile = null;
    try {
      affectedFile = execSync(
        `git show ${commit} --name-only --format="" 2>/dev/null | grep -E "\\.(js|jsx|ts|tsx|mjs)$" | head -1`,
        { cwd: projectPath, encoding: 'utf-8', timeout: 5000 }
      ).trim();
    } catch {
      // Ignore
    }

    return {
      everImported: true,
      lastImportedIn: {
        file: affectedFile || 'unknown',
        removedIn: {
          commit: commit.slice(0, 7),
          author,
          date,
          message: message?.slice(0, 60)
        }
      },
      daysDead
    };

  } catch (error) {
    return { available: false, reason: error.message };
  }
}

/**
 * Get git history for an entire file
 */
function getFileGitHistory(filePath, projectPath) {
  if (!projectPath) return { available: false, reason: 'No project path' };

  try {
    // Check if git repo
    try {
      execSync('git rev-parse --git-dir', { cwd: projectPath, stdio: 'pipe', timeout: 5000 });
    } catch {
      return { available: false, reason: 'Not a git repository' };
    }

    // Last modification
    let lastModified;
    try {
      lastModified = execSync(
        `git log -1 --format="%H|%ae|%aI|%s" -- "${filePath}" 2>/dev/null`,
        { cwd: projectPath, encoding: 'utf-8', timeout: 10000 }
      ).trim();
    } catch {
      lastModified = '';
    }

    // When file was created
    let created;
    try {
      created = execSync(
        `git log --follow --diff-filter=A --format="%H|%ae|%aI|%s" -- "${filePath}" 2>/dev/null | tail -1`,
        { cwd: projectPath, encoding: 'utf-8', timeout: 10000 }
      ).trim();
    } catch {
      created = '';
    }

    const result = {
      available: true
    };

    if (lastModified && lastModified.includes('|')) {
      const [commit, author, date, message] = lastModified.split('|');
      result.lastModified = {
        commit: commit.slice(0, 7),
        author,
        date,
        message: message?.slice(0, 60)
      };
      result.daysSinceModified = Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24));
    }

    if (created && created.includes('|')) {
      const [commit, author, date, message] = created.split('|');
      result.createdIn = {
        commit: commit.slice(0, 7),
        author,
        date,
        message: message?.slice(0, 60)
      };
    }

    return result;

  } catch (error) {
    return { available: false, reason: error.message };
  }
}

/**
 * Calculate cost impact of dead code
 */
function calculateDeadCodeCost(sizeBytes, config = {}) {
  const {
    monthlyVisitors = 10000,
    avgPagesPerVisit = 3,
    cacheHitRate = 0.8,
    bandwidthCostPerGB = 0.085, // AWS CloudFront pricing
    co2PerGB = 0.5, // kg CO2 per GB transferred
    inBundle = true
  } = config;

  if (!inBundle || sizeBytes === 0) {
    return {
      bundleContribution: sizeBytes,
      monthlyCostGBP: '0.00',
      annualCostGBP: '0.00',
      monthlyCO2Kg: '0.000',
      note: inBundle ? 'No size impact' : 'Not included in bundle'
    };
  }

  const monthlyPageviews = monthlyVisitors * avgPagesPerVisit;
  const uncachedPageviews = monthlyPageviews * (1 - cacheHitRate);

  const bytesPerMonth = sizeBytes * uncachedPageviews;
  const gbPerMonth = bytesPerMonth / (1024 * 1024 * 1024);

  const monthlyCost = gbPerMonth * bandwidthCostPerGB;
  const annualCost = monthlyCost * 12;
  const co2PerMonth = gbPerMonth * co2PerGB;

  return {
    bundleContribution: sizeBytes,
    monthlyCostGBP: monthlyCost.toFixed(4),
    annualCostGBP: annualCost.toFixed(2),
    monthlyCO2Kg: co2PerMonth.toFixed(6)
  };
}

/**
 * Build recommendation with rich reasoning
 */
function buildRecommendation(filePath, deadExports, liveExports, totalFilesSearched) {
  const canDelete = liveExports.length === 0;
  const deadNames = deadExports.map(e => e.name);
  const liveNames = liveExports.map(e => e.name);

  const parts = [];
  parts.push(`Searched ${totalFilesSearched} files.`);

  if (deadExports.length === 0) {
    return {
      action: 'keep',
      confidence: 'safe-to-remove',
      safeToRemove: [],
      keep: liveNames,
      reasoning: `${parts[0]} All exports are in use.`
    };
  }

  if (canDelete) {
    parts.push(`All ${deadExports.length} export(s) are dead - entire file can be removed.`);
  } else {
    parts.push(`${deadExports.length} of ${deadExports.length + liveExports.length} exports are dead.`);
  }

  // Add git history context for the first dead export
  const firstDead = deadExports[0];
  if (firstDead?.gitHistory?.everImported) {
    const gh = firstDead.gitHistory;
    parts.push(
      `${firstDead.name} last used ${gh.daysDead} days ago` +
      (gh.lastImportedIn?.file ? ` in ${gh.lastImportedIn.file}` : '') +
      (gh.lastImportedIn?.removedIn?.author ? `, removed by ${gh.lastImportedIn.removedIn.author.split('@')[0]}` : '') +
      (gh.lastImportedIn?.removedIn?.message ? ` (${gh.lastImportedIn.removedIn.message})` : '') +
      '.'
    );
  } else if (firstDead?.gitHistory?.note) {
    parts.push(firstDead.gitHistory.note);
  }

  // Live exports warning
  if (liveNames.length > 0) {
    parts.push(`Keep: ${liveNames.join(', ')} - still in use.`);
  }

  // Final recommendation
  if (canDelete) {
    parts.push('Safe to delete entire file.');
    return {
      action: 'delete-file',
      confidence: 'safe-to-remove',
      safeToRemove: deadNames,
      keep: [],
      command: `rm ${filePath}`,
      reasoning: parts.join(' ')
    };
  }

  // Build line ranges for removal
  const lineRanges = deadExports
    .map(e => e.lineEnd ? `${e.line}-${e.lineEnd}` : `${e.line}`)
    .join(', ');

  const partialConfidence = 'safe-to-remove';

  return {
    action: 'partial-cleanup',
    confidence: partialConfidence,
    safeToRemove: deadNames,
    keep: liveNames,
    linesToRemove: lineRanges,
    reasoning: parts.join(' ')
  };
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Check if a file is JavaScript/TypeScript
 */
function isJavaScript(path) {
  return /\.([mc]?[jt]s|[jt]sx)$/.test(path);
}

/**
 * Check if file is a code file (any supported language)
 */
function isCodeFile(path) {
  return /\.([mc]?[jt]s|[jt]sx|py|pyi|java|kt|kts|cs|go|rs)$/.test(path);
}

/**
 * Build the set of files reachable from entry points by walking the import graph
 * This is the correct approach: start from entry points and find what's reachable,
 * rather than checking if each file is imported somewhere.
 * @param {Set<string>} entryPointFiles - Set of entry point file paths
 * @param {Array} jsAnalysis - Parsed file analysis results
 * @param {string} projectPath - Project root path
 * @param {Map<string, Set<string>>} additionalRefs - Optional map of additional file->files references (e.g., C# class refs)
 */
function buildReachableFiles(entryPointFiles, jsAnalysis, projectPath = null, additionalRefs = null) {
  const reachable = new Set();
  const visited = new Set();
  const _sortedAliasCache = new WeakMap();  // Cache sorted alias arrays per alias Map

  // Extract path aliases from tsconfig.json / vite.config.ts
  // Returns global aliases, per-package aliases, baseUrls, and workspace package mapping for monorepo support
  const { aliases: pathAliases, packageAliases, packageBaseUrls, workspacePackages, goModulePath, javaSourceRoots } = extractPathAliases(projectPath);

  // Build Java/Kotlin fully-qualified class name → file path mapping
  // e.g. "com.example.service.UserService" → "module/src/main/java/com/example/service/UserService.java"
  const javaFqnMap = new Map();  // FQN → file path
  const javaPackageDirMap = new Map();  // package dir (com/example/service) → [file paths]

  /**
   * Get the appropriate alias map for a file
   * In monorepos, use package-specific aliases first, then fall back to global
   */
  function getAliasesForFile(filePath) {
    // Check if file is in a package directory
    // Find the MOST SPECIFIC (longest) matching package directory
    let bestMatch = null;
    let bestMatchLen = 0;
    for (const [pkgDir, pkgAliases] of packageAliases) {
      if ((filePath.startsWith(pkgDir + '/') || filePath.startsWith(pkgDir + '\\')) && pkgDir.length > bestMatchLen) {
        bestMatch = pkgAliases;
        bestMatchLen = pkgDir.length;
      }
    }

    if (bestMatch) {
      // Merge package aliases with global (package takes precedence)
      const merged = new Map(pathAliases);
      for (const [alias, target] of bestMatch) {
        merged.set(alias, target);
      }
      return merged;
    }
    return pathAliases;
  }

  /**
   * Get the baseUrl prefix for a file (for resolving bare imports via tsconfig baseUrl)
   * Returns the project-relative prefix or null if no baseUrl configured
   */
  function getBaseUrlForFile(filePath) {
    let bestMatch = null;
    let bestMatchLen = -1;
    for (const [pkgDir, baseUrlPrefix] of packageBaseUrls) {
      if (pkgDir === '') {
        // Root-level baseUrl applies to all files (lowest priority)
        if (bestMatchLen < 0) {
          bestMatch = baseUrlPrefix;
          bestMatchLen = 0;
        }
      } else if ((filePath.startsWith(pkgDir + '/') || filePath.startsWith(pkgDir + '\\')) && pkgDir.length > bestMatchLen) {
        bestMatch = baseUrlPrefix;
        bestMatchLen = pkgDir.length;
      }
    }
    return bestMatch;
  }

  // Build a map from file path to its imports
  const fileImports = new Map();
  // Build a map from file path to its metadata (for Java package lookups)
  const fileMetadata = new Map();
  for (const file of jsAnalysis) {
    const filePath = file.file?.relativePath || file.file;
    fileImports.set(filePath, file.imports || []);
    if (file.metadata) {
      fileMetadata.set(filePath, file.metadata);
    }
  }

  // Build a map from file path to its exports (for re-export chain following)
  const fileExports = new Map();
  for (const file of jsAnalysis) {
    const filePath = file.file?.relativePath || file.file;
    fileExports.set(filePath, file.exports || []);
  }

  // Track per-export usage: Map<filePath, Map<exportName, [{importerFile, importType}]>>
  const exportUsageMap = new Map();

  /**
   * Record that an importer consumed specific exports from a target file.
   */
  function recordExportUsage(targetFile, importerFile, specifiers, importType) {
    if (!targetFile || !importerFile) return;

    let fileUsage = exportUsageMap.get(targetFile);
    if (!fileUsage) {
      fileUsage = new Map();
      exportUsageMap.set(targetFile, fileUsage);
    }

    // Determine what symbols are consumed
    if (!specifiers || specifiers.length === 0) {
      if (importType === 'esm') {
        // Side-effect import: import './module' — file reached but no named exports consumed
        const key = '__SIDE_EFFECT__';
        let usages = fileUsage.get(key);
        if (!usages) { usages = []; fileUsage.set(key, usages); }
        usages.push({ importerFile, importType });
      } else {
        // CJS/dynamic — assume all exports consumed (conservative)
        const key = '__ALL__';
        let usages = fileUsage.get(key);
        if (!usages) { usages = []; fileUsage.set(key, usages); }
        usages.push({ importerFile, importType });
      }
      return;
    }

    for (const spec of specifiers) {
      let key;
      if (spec.type === 'namespace') {
        key = '*'; // import * as ns — all exports consumed
      } else if (spec.type === 'default') {
        key = 'default';
      } else {
        key = spec.name || spec;
      }
      let usages = fileUsage.get(key);
      if (!usages) { usages = []; fileUsage.set(key, usages); }
      usages.push({ importerFile, importType });
    }
  }

  // Build a map from file path to its Rust mod declarations
  const fileMods = new Map();
  for (const file of jsAnalysis) {
    const filePath = file.file?.relativePath || file.file;
    if (file.mods?.length > 0) {
      fileMods.set(filePath, file.mods);
    }
  }

  // Build Java/Kotlin FQN → file path mapping
  // Strategy 1: Use parser-extracted package name + class name (most reliable)
  // Strategy 2: Infer from detected source roots (fallback)
  // Also auto-detect source roots from file paths (handles arbitrarily deep module nesting)
  const detectedSourceRoots = new Set(javaSourceRoots);
  const srcRootPatterns = ['src/main/java/', 'src/test/java/', 'src/main/kotlin/', 'src/test/kotlin/'];
  for (const file of jsAnalysis) {
    const filePath = file.file?.relativePath || file.file;
    if (!filePath.endsWith('.java') && !filePath.endsWith('.kt')) continue;
    for (const pattern of srcRootPatterns) {
      const idx = filePath.indexOf(pattern);
      if (idx >= 0) {
        const root = filePath.substring(0, idx + pattern.length - 1); // strip trailing /
        detectedSourceRoots.add(root);
        break;
      }
    }
  }
  const allJavaSourceRoots = [...detectedSourceRoots];

  for (const file of jsAnalysis) {
    const filePath = file.file?.relativePath || file.file;
    if (!filePath.endsWith('.java') && !filePath.endsWith('.kt')) continue;

    // Strategy 1: Use parser-extracted package name + class name from file path
    const packageName = file.metadata?.packageName;
    if (packageName) {
      // Extract class name from file name (e.g., UserService.java → UserService)
      const fileName = basename(filePath).replace(/\.(java|kt)$/, '');
      const fqn = packageName + '.' + fileName;
      javaFqnMap.set(fqn, filePath);

      // Also populate package dir map for wildcard imports
      const packageDir = packageName.replace(/\./g, '/');
      if (!javaPackageDirMap.has(packageDir)) {
        javaPackageDirMap.set(packageDir, []);
      }
      javaPackageDirMap.get(packageDir).push(filePath);
    } else {
      // Strategy 2: Infer FQN from source root + file path
      for (const root of allJavaSourceRoots) {
        if (filePath.startsWith(root + '/')) {
          const relativePart = filePath.slice(root.length + 1); // e.g. com/example/service/UserService.java
          const fqn = relativePart.replace(/\.(java|kt)$/, '').replace(/\//g, '.');
          javaFqnMap.set(fqn, filePath);

          // Package dir map
          const packageDir = dirname(relativePart);
          if (packageDir !== '.') {
            if (!javaPackageDirMap.has(packageDir)) {
              javaPackageDirMap.set(packageDir, []);
            }
            javaPackageDirMap.get(packageDir).push(filePath);
          }
          break;
        }
      }
    }
  }

  // Also create a map for extension-less lookups
  const filePathsNoExt = new Map();
  for (const file of jsAnalysis) {
    const filePath = file.file?.relativePath || file.file;
    // Support all code file extensions
    const noExt = filePath.replace(/\.([mc]?[jt]s|[jt]sx|py|pyi|java|kt|kts|cs|go|rs)$/, '');
    if (!filePathsNoExt.has(noExt)) {
      filePathsNoExt.set(noExt, []);
    }
    filePathsNoExt.get(noExt).push(filePath);
  }

  // Build indexes for O(1) lookups (replaces O(n) scans)

  // A2: Go same-package linking index: Map<dir, string[]> of .go files per directory
  const goFilesByDir = new Map();
  // A3: Suffix index for findMatchingFiles: Map<suffix, string[]> for partial path matching
  const suffixIndex = new Map();
  // A5: Directory index for sibling detection: Map<dir, string[]>
  const dirIndex = new Map();

  const allFilePaths = [...fileImports.keys()];
  for (const fp of allFilePaths) {
    // goFilesByDir: only Go files
    if (fp.endsWith('.go')) {
      const dir = dirname(fp);
      let arr = goFilesByDir.get(dir);
      if (!arr) { arr = []; goFilesByDir.set(dir, arr); }
      arr.push(fp);
    }

    // suffixIndex: keyed by everything after the last '/'
    const lastSlash = fp.lastIndexOf('/');
    const suffix = lastSlash >= 0 ? fp.slice(lastSlash + 1) : fp;
    let sarr = suffixIndex.get(suffix);
    if (!sarr) { sarr = []; suffixIndex.set(suffix, sarr); }
    sarr.push(fp);

    // dirIndex: group files by their directory
    const dir = dirname(fp);
    let darr = dirIndex.get(dir);
    if (!darr) { darr = []; dirIndex.set(dir, darr); }
    darr.push(fp);
  }

  // Mark files matching glob patterns from source as reachable
  // (e.g., glob.sync('**/*.node.ts'), import.meta.glob('**/*.ts'))
  for (const file of jsAnalysis) {
    const fileDir = dirname(file.file?.relativePath || '');
    for (const imp of file.imports || []) {
      if (imp.isGlob && imp.module) {
        const matches = matchGlobPattern(imp.module, allFilePaths, fileDir);
        for (const match of matches) {
          reachable.add(match);
        }
      }
    }
  }

  // Detect directory-scanning auto-loaders (requireDirectory, readdirSync, glob.sync)
  // When an index file dynamically loads all siblings, mark those siblings as reachable
  // Common patterns: Outline's requireDirectory(__dirname), NestJS module scanning, plugin loaders
  if (projectPath) {
    const dirScanPatterns = /requireDirectory\s*[(<]|readdirSync\s*\(\s*__dirname|readdir\s*\(\s*__dirname|glob\.sync\s*\(|globSync\s*\(/;
    for (const file of jsAnalysis) {
      const filePath = file.file?.relativePath || file.file;
      const fileName = basename(filePath).replace(/\.[^.]+$/, '');
      // Only check index files (index.ts, index.js, etc.) - these are the typical auto-loader hubs
      if (fileName !== 'index') continue;

      const fileDir = dirname(filePath);
      // Read the actual source to detect directory-scanning patterns
      try {
        const fullPath = join(projectPath, filePath);
        const source = readFileSync(fullPath, 'utf-8');
        if (dirScanPatterns.test(source)) {
          // Mark all sibling files in the same directory as reachable (using dirIndex for O(1))
          const siblings = dirIndex.get(fileDir) || [];
          for (const otherFile of siblings) {
            if (otherFile !== filePath) {
              reachable.add(otherFile);
            }
          }
        }
      } catch {
        // Ignore read errors
      }
    }
  }

  // Helper to find matching files for a module path with possible extensions
  function findMatchingFiles(modulePath, extensions) {
    const matches = [];
    for (const ext of extensions) {
      const fullPath = modulePath + ext;
      // Check if exact path exists
      if (fileImports.has(fullPath)) {
        matches.push(fullPath);
      }
      // Check with various prefixes (src/, app/, etc.)
      for (const prefix of ['', 'src/', 'app/', 'lib/', 'pkg/', 'internal/', 'crates/', 'packages/']) {
        const prefixedPath = prefix + fullPath;
        if (fileImports.has(prefixedPath)) {
          matches.push(prefixedPath);
        }
        // Also check with lowercase module path
        const lowerPath = prefix + fullPath.toLowerCase();
        if (fileImports.has(lowerPath)) {
          matches.push(lowerPath);
        }
      }
      // Use suffix index for O(1) partial match lookup (instead of O(n) scan)
      // Look up by the filename portion of fullPath (after last /)
      const fullPathBasename = fullPath.includes('/') ? fullPath.slice(fullPath.lastIndexOf('/') + 1) : fullPath;
      const candidates = suffixIndex.get(fullPathBasename) || [];
      for (const filePath of candidates) {
        // Only match if fullPath is at a path boundary (after / or at start)
        // Avoid matching 'dead_tasks.py' when looking for 'tasks.py'
        if (filePath.endsWith('/' + fullPath) || filePath === fullPath) {
          if (!matches.includes(filePath)) {
            matches.push(filePath);
          }
        }
      }
    }
    return matches;
  }

  // Resolve an import path to actual file path(s)
  function resolveImport(fromFile, importPath) {
    const fromDir = dirname(fromFile);
    let resolved = importPath;

    // Detect language from importing file
    const isPython = fromFile.endsWith('.py') || fromFile.endsWith('.pyi');
    const isJava = fromFile.endsWith('.java');
    const isKotlin = fromFile.endsWith('.kt') || fromFile.endsWith('.kts');
    const isGo = fromFile.endsWith('.go');
    const isRust = fromFile.endsWith('.rs');
    const isCSharp = fromFile.endsWith('.cs');

    // Handle Python-style absolute imports (module.submodule -> module/submodule.py)
    if (isPython && importPath.includes('.') && !importPath.startsWith('.')) {
      // Convert dots to slashes: users.models -> users/models
      const modulePath = importPath.replace(/\./g, '/');
      // Try both with and without .py extension
      let matches = findMatchingFiles(modulePath, ['.py', '/__init__.py']);

      // For 'from lib.utils import capitalize' the importPath is 'lib.utils.capitalize'
      // We need to also try without the last component (which is the imported symbol)
      if (matches.length === 0) {
        const parts = importPath.split('.');
        if (parts.length > 1) {
          // Try progressively shorter paths to find the module
          for (let i = parts.length - 1; i >= 1; i--) {
            const shorterPath = parts.slice(0, i).join('/');
            const shorterMatches = findMatchingFiles(shorterPath, ['.py', '/__init__.py']);
            if (shorterMatches.length > 0) {
              matches = shorterMatches;
              break;
            }
          }
        }
      }
      return matches;
    }

    // Handle Python relative imports (.module, ..module, ...module)
    // e.g. from .applications import FastAPI -> ".applications"
    // e.g. from ..utils import helper -> "..utils"
    if (isPython && /^\.+/.test(importPath)) {
      const dotMatch = importPath.match(/^(\.+)(.*)/);
      const dots = dotMatch[1].length;  // number of dots
      const moduleName = dotMatch[2];   // module name after dots (may be empty for "from . import X")

      // Resolve the base directory: 1 dot = current dir, 2 dots = parent, etc.
      let baseDir = fromDir;
      for (let i = 1; i < dots; i++) {
        baseDir = dirname(baseDir);
      }

      if (moduleName) {
        // Convert remaining dots to slashes for nested modules
        const modulePath = moduleName.replace(/\./g, '/');
        const fullPath = baseDir ? join(baseDir, modulePath) : modulePath;
        return findMatchingFiles(fullPath, ['.py', '/__init__.py']);
      } else {
        // Bare dots: "from . import X" - X is already resolved as module name by parser
        // This case shouldn't happen with the fixed parser since it stores ".X"
        return findMatchingFiles(baseDir, ['/__init__.py']);
      }
    }

    // Handle Java/Kotlin package imports (com.example.Service -> com/example/Service.java)
    if ((isJava || isKotlin) && importPath.includes('.') && !importPath.startsWith('.')) {
      const matches = [];
      const ext = isJava ? '.java' : '.kt';

      // Strategy 1: FQN map lookup (most precise - uses parser-extracted package names)
      // Direct lookup: import com.example.service.UserService → exact match
      // This runs BEFORE framework filtering because in framework repos (e.g. spring-boot)
      // internal imports look like framework imports (org.springframework.*)
      if (javaFqnMap.has(importPath)) {
        matches.push(javaFqnMap.get(importPath));
        return matches;
      }

      // Strategy 2: Wildcard import (import com.example.service.*)
      // Must check before framework filter since in framework repos wildcard imports are local
      if (importPath.endsWith('.*')) {
        const packageFqn = importPath.slice(0, -2); // strip .*
        const packageDir = packageFqn.replace(/\./g, '/');
        const pkgFiles = javaPackageDirMap.get(packageDir);
        if (pkgFiles && pkgFiles.length > 0) {
          return [...pkgFiles];
        }
        // Fallback: scan all files for matching package directory
        for (const filePath of fileImports.keys()) {
          if ((filePath.endsWith('.java') || filePath.endsWith('.kt')) && filePath.includes(packageDir + '/')) {
            const afterPkg = filePath.slice(filePath.indexOf(packageDir + '/') + packageDir.length + 1);
            if (!afterPkg.includes('/')) { // Only direct children, not sub-packages
              matches.push(filePath);
            }
          }
        }
        if (matches.length > 0) return matches;
        // If no local matches found, it's truly an external wildcard import
        return [];
      }

      // Strategy 3: Static imports (import static com.example.Utils.method → resolve to Utils)
      // Must check before framework filter since static imports in framework repos are local
      const parts = importPath.split('.');
      if (parts.length > 2) {
        const classCandidate = parts.slice(0, -1).join('.');
        if (javaFqnMap.has(classCandidate)) {
          matches.push(javaFqnMap.get(classCandidate));
          return matches;
        }
      }

      // Skip framework package imports - these are annotations/base classes, not project files
      // Only skip if NOT found in the FQN map or wildcard/static import maps (checked above)
      const frameworkPackages = ['org.springframework', 'javax.', 'jakarta.', 'java.', 'kotlin.', 'android.', 'com.google.', 'org.junit', 'org.mockito', 'io.ktor', 'org.apache.', 'io.netty.', 'org.slf4j', 'org.jboss.', 'io.quarkus.', 'io.smallrye.', 'org.eclipse.', 'com.fasterxml.', 'org.hibernate.', 'org.reactivestreams.', 'io.vertx.'];
      const isFrameworkImport = frameworkPackages.some(pkg => importPath.startsWith(pkg));
      if (isFrameworkImport) return [];

      // Strategy 5: Source-root-relative path resolution
      // Convert dots to slashes and try finding under known source roots
      const packagePath = importPath.replace(/\./g, '/');
      for (const root of allJavaSourceRoots) {
        const candidate = root + '/' + packagePath + ext;
        if (fileImports.has(candidate)) {
          matches.push(candidate);
        }
      }
      if (matches.length > 0) return matches;

      // Strategy 5: Path suffix matching (for projects without detected source roots)
      // Find files whose path ends with the expected package path
      const expectedSuffix = '/' + packagePath + ext;
      for (const filePath of fileImports.keys()) {
        if (filePath.endsWith(expectedSuffix)) {
          if (!matches.includes(filePath)) {
            matches.push(filePath);
          }
        }
      }
      if (matches.length > 0) return matches;

      // Strategy 6: Class-name-only fallback (least precise)
      // Only for project imports that didn't match above
      const className = parts[parts.length - 1];
      if (className && className[0] === className[0].toUpperCase()) {
        const deadFilePattern = /(^|\/)(dead[-_]?|deprecated[-_]?|legacy[-_]?|old[-_]?|unused[-_]?)/i;
        for (const filePath of fileImports.keys()) {
          if (filePath.endsWith('/' + className + ext) || filePath.endsWith(className + ext)) {
            if (!deadFilePattern.test(filePath) && !matches.includes(filePath)) {
              matches.push(filePath);
            }
          }
        }
      }
      return matches;
    }

    // Handle Go imports (package paths)
    if (isGo && !importPath.startsWith('.') && !importPath.startsWith('/')) {
      const deadFilePatternGo = /(^|\/)(dead[-_]?|deprecated[-_]?|legacy[-_]?|old[-_]?|unused[-_]?)[^/]*\.go$|\/dead\.go$/i;
      const matches = [];

      // Strategy 1: Module-path-aware resolution (most precise)
      // If import starts with go.mod module path, strip prefix to get local package dir
      // e.g. "github.com/gin-gonic/gin/internal/bytesconv" → "internal/bytesconv"
      if (goModulePath && importPath.startsWith(goModulePath)) {
        let localPath = importPath.slice(goModulePath.length);
        if (localPath.startsWith('/')) localPath = localPath.slice(1);
        // localPath is now a relative directory like "internal/bytesconv" or "" (root package)
        const pkgDir = localPath ? localPath + '/' : '';
        for (const filePath of fileImports.keys()) {
          if (!filePath.endsWith('.go')) continue;
          if (!filePath.endsWith('_test.go') && (filePath.startsWith(pkgDir) || (!localPath && !filePath.includes('/')))) {
            // File is in the target package directory (not in a subdirectory unless pkgDir matches)
            const afterPrefix = localPath ? filePath.slice(pkgDir.length) : filePath;
            // Only match files directly in this directory (not subdirectories)
            if (!afterPrefix.includes('/') && !deadFilePatternGo.test(filePath)) {
              matches.push(filePath);
            }
          }
        }
        if (matches.length > 0) return matches;
      }

      // Strategy 2: Direct local path matching
      // The import path's suffix after the module path might also just be a direct directory
      const segments = importPath.split('/');
      const lastSegment = segments[segments.length - 1];

      // Try to match by the full remaining path segments as a directory
      // For internal packages or sub-packages, try matching from the end
      for (let i = 0; i < segments.length; i++) {
        const candidateDir = segments.slice(i).join('/') + '/';
        for (const filePath of fileImports.keys()) {
          if (!filePath.endsWith('.go') || filePath.endsWith('_test.go')) continue;
          if (filePath.startsWith(candidateDir)) {
            const afterDir = filePath.slice(candidateDir.length);
            if (!afterDir.includes('/') && !deadFilePatternGo.test(filePath)) {
              if (!matches.includes(filePath)) matches.push(filePath);
            }
          }
        }
        if (matches.length > 0) return matches;
      }

      // Strategy 3: Last-segment fallback (least precise, for external packages)
      for (const filePath of fileImports.keys()) {
        if (filePath.endsWith('.go') && !filePath.endsWith('_test.go') && filePath.includes(lastSegment + '/')) {
          if (!deadFilePatternGo.test(filePath) && !matches.includes(filePath)) {
            matches.push(filePath);
          }
        }
      }
      if (matches.length > 0) return matches;
    }

    // Handle Rust mod imports
    if (isRust && !importPath.startsWith('.')) {
      const modulePath = importPath.replace(/::/g, '/');
      return findMatchingFiles(modulePath, ['.rs', '/mod.rs']);
    }

    // Handle C# using statements
    if (isCSharp && importPath.includes('.') && !importPath.startsWith('.')) {
      const namespacePath = importPath.replace(/\./g, '/');
      return findMatchingFiles(namespacePath, ['.cs']);
    }

    // Standard JS/TS import resolution
    // Handle bare "." import (import from ".") which resolves to ./index in current directory
    if (importPath === '.') {
      resolved = fromDir || '.';
    } else if (importPath.startsWith('./')) {
      resolved = fromDir ? join(fromDir, importPath.slice(2)) : importPath.slice(2);
    } else if (importPath.startsWith('../')) {
      resolved = join(fromDir, importPath);
    } else if (importPath.startsWith('/')) {
      resolved = importPath.slice(1);
    } else {
      // Check if it matches a path alias (e.g., @/components/ui/sidebar)
      // Use context-aware aliases for monorepo support
      const fileAliases = getAliasesForFile(fromFile);
      let aliasResolved = false;
      // Sort aliases by length (longest first) so '@site/' matches before '@/'
      // Use cached sorted array to avoid re-sorting on every resolveImport call
      let sortedAliases = _sortedAliasCache.get(fileAliases);
      if (!sortedAliases) {
        sortedAliases = [...fileAliases.entries()].sort((a, b) => b[0].length - a[0].length);
        _sortedAliasCache.set(fileAliases, sortedAliases);
      }
      for (const [alias, target] of sortedAliases) {
        if (importPath.startsWith(alias)) {
          // Replace alias with target path and normalize double slashes
          resolved = importPath.replace(alias, target).replace(/\/+/g, '/');
          aliasResolved = true;
          break;
        }
        // Also handle alias without trailing slash (e.g., @ -> src)
        const aliasNoSlash = alias.replace(/\/$/, '');
        if (importPath === aliasNoSlash || importPath.startsWith(aliasNoSlash + '/')) {
          resolved = importPath.replace(aliasNoSlash, target.replace(/\/$/, '')).replace(/\/+/g, '/');
          aliasResolved = true;
          break;
        }
      }

      if (!aliasResolved) {
        // Check if it's a workspace package (e.g., '@n8n/rest-api-client')
        // Extract the package name - for scoped packages like @scope/name or @scope/name/subpath
        let packageName = importPath;
        let subPath = '';

        if (importPath.startsWith('@')) {
          // Scoped package: @scope/name or @scope/name/subpath
          const parts = importPath.split('/');
          if (parts.length >= 2) {
            packageName = parts.slice(0, 2).join('/');
            subPath = parts.slice(2).join('/');
          }
        } else {
          // Non-scoped package: name or name/subpath
          const slashIndex = importPath.indexOf('/');
          if (slashIndex > 0) {
            packageName = importPath.slice(0, slashIndex);
            subPath = importPath.slice(slashIndex + 1);
          }
        }

        const workspacePkg = workspacePackages.get(packageName);
        if (workspacePkg) {
          // Resolve to local workspace package
          if (subPath) {
            // First, check package.json exports field for explicit subpath mapping
            // e.g., @strapi/admin/strapi-server -> exports["./strapi-server"] -> "./dist/server/index.mjs"
            const exportRaw = workspacePkg.exportsMap?.get(subPath);
            let exportMatched = false;
            if (exportRaw) {
              // Try multiple resolution strategies for dist -> source mapping
              // Handles both leading dist/ and nested dist/ (e.g., store/dist/store)
              const candidates = [exportRaw];
              if (/^dist\//.test(exportRaw)) {
                candidates.push(exportRaw.replace(/^dist\//, 'src/'));
                candidates.push(exportRaw.replace(/^dist\//, ''));
                candidates.push(exportRaw.replace(/^dist\/([^/]+)\//, '$1/src/'));
              }
              if (/\/dist\//.test(exportRaw)) {
                candidates.push(exportRaw.replace(/\/dist\//, '/src/'));
                candidates.push(exportRaw.replace(/\/dist\//, '/'));
              }
              if (/\/(lib|build|out)\//.test(exportRaw)) {
                candidates.push(exportRaw.replace(/\/(lib|build|out)\//, '/src/'));
                candidates.push(exportRaw.replace(/\/(lib|build|out)\//, '/'));
              }
              for (const candidate of candidates) {
                const fullCandidate = `${workspacePkg.dir}/${candidate}`;
                const candidateNoExt = fullCandidate.replace(/\.([mc]?[jt]s|[jt]sx)$/, '');
                if (fileImports.has(fullCandidate) || filePathsNoExt.has(candidateNoExt) || filePathsNoExt.has(fullCandidate + '/index') || filePathsNoExt.has(candidateNoExt + '/index')) {
                  resolved = fullCandidate;
                  exportMatched = true;
                  break;
                }
              }
              if (!exportMatched) {
                // Use the dist->src conversion as default
                resolved = `${workspacePkg.dir}/${exportRaw.replace(/^dist\//, 'src/')}`;
                exportMatched = true;
              }
            }
            if (!exportMatched) {
              // Fallback: try direct path with and without src/ prefix
              // Import like '@calcom/web/modules/foo' -> apps/web/modules/foo
              const withSrc = `${workspacePkg.dir}/src/${subPath}`;
              const withoutSrc = `${workspacePkg.dir}/${subPath}`;
              // Prefer the path that exists in the file index
              const withSrcNoExt = withSrc.replace(/\.([mc]?[jt]s|[jt]sx)$/, '');
              const withoutSrcNoExt = withoutSrc.replace(/\.([mc]?[jt]s|[jt]sx)$/, '');
              if (fileImports.has(withoutSrc) || filePathsNoExt.has(withoutSrcNoExt) || filePathsNoExt.has(withoutSrc + '/index')) {
                resolved = withoutSrc;
              } else {
                resolved = withSrc;
              }
            }
          } else {
            // Import like '@n8n/rest-api-client' -> packages/.../src/index
            resolved = `${workspacePkg.dir}/${workspacePkg.entryPoint}`;
          }
        } else {
          // Before treating as external, check if baseUrl can resolve it
          // e.g., import 'components/Foo' with baseUrl: "." in apps/studio/tsconfig.json
          // resolves to apps/studio/components/Foo
          const baseUrlPrefix = getBaseUrlForFile(fromFile);
          if (baseUrlPrefix) {
            const baseUrlResolved = baseUrlPrefix + importPath;
            const baseUrlNoExt = baseUrlResolved.replace(/\.([mc]?[jt]s|[jt]sx)$/, '');
            if (fileImports.has(baseUrlResolved) || filePathsNoExt.has(baseUrlNoExt) ||
                filePathsNoExt.has(baseUrlResolved + '/index') || filePathsNoExt.has(baseUrlNoExt + '/index')) {
              resolved = baseUrlResolved;
            } else {
              // External npm package - not a local file
              return [];
            }
          } else {
            // External npm package - not a local file
            return [];
          }
        }
      }
    }

    // Normalize
    resolved = resolved.replace(/\\/g, '/').replace(/^\.\//, '');

    // Handle directory imports (paths ending with /) by looking for index files
    const isDirectoryImport = resolved.endsWith('/');
    if (isDirectoryImport) {
      resolved = resolved.slice(0, -1); // Remove trailing slash
    }

    const resolvedNoExt = resolved.replace(/\.([mc]?[jt]s|[jt]sx|py|pyi|java|kt|kts|cs|go|rs)$/, '');

    // Find matching files
    const matches = [];
    if (fileImports.has(resolved)) {
      matches.push(resolved);
    }
    // Check extension variants
    const variants = filePathsNoExt.get(resolvedNoExt) || [];
    for (const variant of variants) {
      if (!matches.includes(variant)) {
        matches.push(variant);
      }
    }
    // Also check index files (for directory imports or bare module imports)
    const indexVariants = filePathsNoExt.get(resolved + '/index') || [];
    for (const variant of indexVariants) {
      if (!matches.includes(variant)) {
        matches.push(variant);
      }
    }
    // Check platform-specific extensions (React Native convention)
    // import './Screen' should also match Screen.ios.tsx, Screen.android.tsx, Screen.web.tsx
    const platformSuffixes = ['.ios', '.android', '.web', '.native', '.macos', '.windows'];
    for (const suffix of platformSuffixes) {
      const platformVariants = filePathsNoExt.get(resolvedNoExt + suffix) || [];
      for (const variant of platformVariants) {
        if (!matches.includes(variant)) {
          matches.push(variant);
        }
      }
    }
    // For directory imports, index is the primary match
    if (isDirectoryImport && matches.length === 0) {
      const dirIndexVariants = filePathsNoExt.get(resolvedNoExt + '/index') || [];
      for (const variant of dirIndexVariants) {
        if (!matches.includes(variant)) {
          matches.push(variant);
        }
      }
    }

    return matches;
  }

  // BFS to find all reachable files
  function walkFromFile(startFile) {
    const queue = [startFile];
    let qi = 0;

    while (qi < queue.length) {
      const current = queue[qi++];

      if (visited.has(current)) continue;
      visited.add(current);
      reachable.add(current);

      // Go same-package linking: all .go files in the same directory are compiled together
      // When any Go file is reachable, all non-test files in the same package (directory) are reachable
      // But exclude files with dead/deprecated patterns - these should only be reachable via explicit import
      if (current.endsWith('.go')) {
        const currentDir = dirname(current);
        const deadGoPattern = /(^|\/)(dead[-_]?|deprecated[-_]?|legacy[-_]?|old[-_]?|unused[-_]?)[^/]*\.go$|\/dead\.go$/i;
        const sameDir = goFilesByDir.get(currentDir);
        if (sameDir) {
          for (const filePath of sameDir) {
            if (!visited.has(filePath) && !deadGoPattern.test(filePath)) {
              queue.push(filePath);
            }
          }
        }
      }

      // Java/Kotlin same-package linking: classes in the same package can reference each other
      // without import statements. When a Java file is reachable, all files in the same
      // Java package (by packageName, not directory) are also reachable.
      // But exclude files with dead/deprecated/legacy patterns - these should only be reachable via explicit import.
      if (current.endsWith('.java') || current.endsWith('.kt')) {
        const currentPkg = fileMetadata.get(current)?.packageName;
        if (currentPkg) {
          const pkgDir = currentPkg.replace(/\./g, '/');
          const pkgFiles = javaPackageDirMap.get(pkgDir);
          if (pkgFiles) {
            const deadJavaPattern = /(^|\/)(dead[-_]?|deprecated[-_]?|legacy[-_]?|old[-_]?|unused[-_]?)[^/]*\.(java|kt)$|\/(Dead|Deprecated|Legacy|Old|Unused)[A-Z][^/]*\.(java|kt)$/;
            for (const filePath of pkgFiles) {
              if (!visited.has(filePath) && !deadJavaPattern.test(filePath)) {
                queue.push(filePath);
              }
            }
          }
        }
      }

      // Get imports for this file
      const isPythonFile = current.endsWith('.py') || current.endsWith('.pyi');
      const imports = fileImports.get(current) || [];
      for (const imp of imports) {
        const module = imp.module || imp;
        if (typeof module !== 'string') continue;

        // Let resolveImport handle all imports - it knows about path aliases
        // and returns empty array for npm packages
        const resolvedFiles = resolveImport(current, module);
        for (const resolved of resolvedFiles) {
          if (!visited.has(resolved)) {
            queue.push(resolved);
          }
          // Record per-export usage
          if (imp.type === 'esm' && imp.specifiers) {
            recordExportUsage(resolved, current, imp.specifiers, 'esm');
          } else if (isPythonFile && imp.type === 'from' && imp.name) {
            // Python: from X import name — synthesize specifier
            // For __init__.py files: mark ALL exports as used (conservative).
            // __init__.py defines the package's public API — its sibling modules'
            // exports are importable via the package (e.g., from openai.types.X import Y).
            // Marking only the named import would falsely flag other exports as dead.
            const isInitFile = current.endsWith('__init__.py') || current.endsWith('__init__.pyi');
            if (isInitFile || imp.name === '*') {
              recordExportUsage(resolved, current, null, 'from');
            } else {
              const pySpec = [{ name: imp.name, type: 'named' }];
              recordExportUsage(resolved, current, pySpec, 'from');
            }
          } else if (imp.type === 'commonjs' || imp.type === 'dynamic-import' || imp.type === 'require-context') {
            recordExportUsage(resolved, current, null, imp.type || 'commonjs');
          } else if (!imp.specifiers || imp.specifiers.length === 0) {
            // Unknown type with no specifiers — conservative: all consumed
            recordExportUsage(resolved, current, null, imp.type || 'unknown');
          }
        }

        // For Python "from package import X" statements, X could be a submodule (file)
        // not just a symbol. Try resolving module.name as a module path too.
        // e.g. "from airflow.routes import task_instances" -> try airflow/routes/task_instances.py
        if (isPythonFile && imp.name && imp.type === 'from') {
          const submodulePath = module + '.' + imp.name;
          const subResolved = resolveImport(current, submodulePath);
          for (const resolved of subResolved) {
            if (!visited.has(resolved)) {
              queue.push(resolved);
            }
            // Python submodule resolution: the import resolved to a file, mark all exports used
            recordExportUsage(resolved, current, null, 'from-submodule');
          }
        }
      }

      // Follow re-export chains (barrel files: export * from './module')
      // Also record export usage so re-exported symbols are marked as consumed.
      const exports = fileExports.get(current) || [];
      for (const exp of exports) {
        if (exp.sourceModule) {
          // This is a re-export - follow the source module
          const resolvedSources = resolveImport(current, exp.sourceModule);
          for (const source of resolvedSources) {
            if (!visited.has(source)) {
              queue.push(source);
            }
            // Record export usage for re-exported symbols.
            // export * from './module' → all exports consumed
            // export { X } from './module' → specific export consumed
            if (exp.type === 'reexport-all' || exp.name === '*') {
              recordExportUsage(source, current, null, 'reexport-all');
            } else if (exp.name) {
              recordExportUsage(source, current, [{ name: exp.name, type: 'named' }], 'reexport');
            }
          }
        }
      }

      // Follow Rust mod declarations (mod utils; makes utils.rs or utils/mod.rs reachable)
      // Skip mod declarations that have "dead" patterns in the name (they're likely unused)
      const mods = fileMods.get(current) || [];
      const deadModPattern = /^(dead[-_]|deprecated[-_]|legacy[-_]|old[-_]|unused[-_])/i;
      for (const mod of mods) {
        // Skip mods with dead patterns in the name
        if (deadModPattern.test(mod.name)) {
          continue;
        }

        // Resolve mod name to file path
        const currentDir = dirname(current);

        // If mod has #[path = "..."] override, use that path directly
        if (mod.pathOverride) {
          const overridePath = join(currentDir, mod.pathOverride);
          const normalizedOverride = overridePath.replace(/\\/g, '/');
          if (fileImports.has(normalizedOverride) && !visited.has(normalizedOverride)) {
            queue.push(normalizedOverride);
          }
          // Also try relative to Rust 2018 parent module dir
          const currentBase = basename(current);
          if (currentBase.endsWith('.rs') && currentBase !== 'mod.rs' && currentBase !== 'lib.rs' && currentBase !== 'main.rs') {
            const parentModDir = join(currentDir, currentBase.replace(/\.rs$/, ''));
            const altPath = join(parentModDir, mod.pathOverride).replace(/\\/g, '/');
            if (fileImports.has(altPath) && !visited.has(altPath)) {
              queue.push(altPath);
            }
          }
          continue;
        }

        // mod foo; -> look for foo.rs or foo/mod.rs in same directory
        const modFileName = mod.name + '.rs';
        const modDirFile = mod.name + '/mod.rs';

        // Build candidates list
        const modCandidates = [
          join(currentDir, modFileName),
          join(currentDir, modDirFile)
        ];

        // Rust 2018 module path: if current file is "rules.rs" (not mod.rs/lib.rs/main.rs),
        // then it manages a sibling "rules/" directory. Child mods resolve to rules/child.rs.
        const currentBase = basename(current);
        if (currentBase.endsWith('.rs') && currentBase !== 'mod.rs' && currentBase !== 'lib.rs' && currentBase !== 'main.rs') {
          const parentModDir = join(currentDir, currentBase.replace(/\.rs$/, ''));
          modCandidates.push(
            join(parentModDir, modFileName),    // e.g., rules/import.rs
            join(parentModDir, modDirFile)      // e.g., rules/import/mod.rs
          );
        }

        for (const candidate of modCandidates) {
          const normalizedCandidate = candidate.replace(/\\/g, '/');
          if (fileImports.has(normalizedCandidate) && !visited.has(normalizedCandidate)) {
            queue.push(normalizedCandidate);
          }
        }
      }

      // Follow Rust proc macros that scan directories for .rs files at compile time
      // Handles: automod::dir!("path"), declare_group_from_fs!, declare_lint_group!, etc.
      // Also handles r#keyword raw identifier syntax: mod r#if → if.rs
      if (current.endsWith('.rs') && projectPath) {
        try {
          const rsContent = readFileSync(join(projectPath, current), 'utf-8');

          // Resolve nested inline module declarations:
          // pub(crate) mod eslint { pub mod accessor_pairs; }
          // → accessor_pairs resolves to rules/eslint/accessor_pairs.rs (not rules/accessor_pairs.rs)
          // Strategy: Parse content for inline mod blocks (ending with {), track brace depth,
          // and resolve nested external mods (ending with ;) with parent inline mod as prefix dir.
          {
            const currentDir = dirname(current);
            const currentBase = basename(current);
            const baseDir = (currentBase.endsWith('.rs') && currentBase !== 'mod.rs' && currentBase !== 'lib.rs' && currentBase !== 'main.rs')
              ? join(currentDir, currentBase.replace(/\.rs$/, ''))
              : currentDir;

            // Track brace depth and inline mod stack
            const modStack = []; // [{name, startDepth}]
            let braceDepth = 0;
            // Tokenize: find mod declarations, open braces, close braces
            const tokenRe = /(?:(?:pub(?:\([^)]+\))?\s+)?mod\s+(\w+)\s*([;{]))|([{}])/g;
            let tok;
            while ((tok = tokenRe.exec(rsContent)) !== null) {
              if (tok[3] === '{') {
                braceDepth++;
              } else if (tok[3] === '}') {
                braceDepth--;
                // Pop any inline mods that ended at this depth
                while (modStack.length > 0 && modStack[modStack.length - 1].startDepth >= braceDepth) {
                  modStack.pop();
                }
              } else if (tok[1]) {
                // mod declaration
                const modName = tok[1];
                const ending = tok[2];
                if (ending === '{') {
                  // Inline module — push to stack and count its opening brace
                  braceDepth++;
                  modStack.push({ name: modName, startDepth: braceDepth });
                } else if (ending === ';' && modStack.length > 0) {
                  // External mod inside an inline block — resolve with prefix
                  const prefix = modStack.map(m => m.name).join('/');
                  const nestedCandidates = [
                    join(baseDir, prefix, modName + '.rs'),
                    join(baseDir, prefix, modName, 'mod.rs')
                  ];
                  for (const c of nestedCandidates) {
                    const nc = c.replace(/\\/g, '/');
                    if (fileImports.has(nc) && !visited.has(nc)) {
                      queue.push(nc);
                    }
                  }
                }
              }
            }
          }

          // Match automod::dir!("subdir") or automod::dir!(".")
          const automodRe = /automod::dir!\s*\(\s*"([^"]+)"\s*\)/g;
          let automodMatch;
          while ((automodMatch = automodRe.exec(rsContent)) !== null) {
            const automodDir = automodMatch[1];
            const currentDir = dirname(current);
            // automod::dir! resolves relative to Cargo.toml manifest dir (project root),
            // NOT relative to the current file. Try project-root-relative first, then file-relative as fallback.
            const rootRelativeDir = automodDir === '.' ? currentDir : automodDir.replace(/\\/g, '/');
            const fileRelativeDir = automodDir === '.' ? currentDir : join(currentDir, automodDir).replace(/\\/g, '/');
            // Check which directory has files — prefer root-relative
            const rootDirFiles = dirIndex ? dirIndex.get(rootRelativeDir) : null;
            const fileDirFiles = dirIndex ? dirIndex.get(fileRelativeDir) : null;
            const targetDir = (rootDirFiles && rootDirFiles.size > 0) ? rootRelativeDir
              : (fileDirFiles && fileDirFiles.size > 0) ? fileRelativeDir
              : rootRelativeDir;
            // Use dirIndex if available, otherwise scan fileImports keys
            const dirFiles = dirIndex ? dirIndex.get(targetDir) : null;
            if (dirFiles) {
              for (const f of dirFiles) {
                if (f.endsWith('.rs') && !visited.has(f)) {
                  queue.push(f);
                }
              }
            } else {
              // Fallback: scan all known file paths in that directory
              for (const filePath of fileImports.keys()) {
                if (filePath.endsWith('.rs') && dirname(filePath) === targetDir && !visited.has(filePath)) {
                  queue.push(filePath);
                }
              }
            }
          }

          // Detect Rust proc macros that scan directories at compile time (e.g., biome's declare_group_from_fs!)
          // Pattern: macro invocation in a file means "all .rs files in my sibling directory are modules"
          // e.g., crates/biome_js_analyze/src/lint/correctness.rs contains declare_group_from_fs!
          // which scans correctness/ directory for .rs files
          if (/declare_(?:group_from_fs|lint_group)|include_dir!\s*\(|auto_mod!\s*\(/.test(rsContent)) {
            const currentDir = dirname(current);
            const moduleName = current.replace(/\.rs$/, '').split('/').pop();
            // The macro typically scans a subdirectory named after the module
            const targetDir = `${currentDir}/${moduleName}`;
            const dirFiles = dirIndex ? dirIndex.get(targetDir) : null;
            if (dirFiles) {
              for (const f of dirFiles) {
                if (f.endsWith('.rs') && !visited.has(f)) {
                  queue.push(f);
                }
              }
            }
          }

          // Handle Rust raw identifier mod declarations: mod r#if; → if.rs
          const rawIdentRe = /\bmod\s+r#(\w+)\s*;/g;
          let rawMatch;
          while ((rawMatch = rawIdentRe.exec(rsContent)) !== null) {
            const modName = rawMatch[1];
            const currentDir = dirname(current);
            const candidates = [
              `${currentDir}/${modName}.rs`,
              `${currentDir}/${modName}/mod.rs`
            ];
            for (const c of candidates) {
              if (!visited.has(c) && (dirIndex?.get(dirname(c))?.has(c) || fileImports.has(c))) {
                queue.push(c);
              }
            }
          }

          // Handle Rust include!() macro: include!("../doctest_setup.rs") → resolve path
          const includeRe = /include!\s*\(\s*["']([^"']+\.rs)["']\s*\)/g;
          let inclMatch;
          while ((inclMatch = includeRe.exec(rsContent)) !== null) {
            const inclPath = inclMatch[1];
            const currentDir = dirname(current);
            // Try relative to current file
            const resolved = join(currentDir, inclPath).replace(/\\/g, '/');
            const normalised = resolved.replace(/\/\.\.\//g, () => {
              // Simple parent dir resolution
              return '/../';
            });
            // Normalise path — use a simple approach
            const parts = resolved.split('/');
            const normalParts = [];
            for (const p of parts) {
              if (p === '..') normalParts.pop();
              else if (p !== '.') normalParts.push(p);
            }
            const finalPath = normalParts.join('/');
            if (!visited.has(finalPath) && (dirIndex?.get(dirname(finalPath))?.has(finalPath) || fileImports.has(finalPath))) {
              queue.push(finalPath);
            }
          }
        } catch { /* skip read errors */ }
      }

      // Follow Python __getattr__ + lazy import dict patterns (e.g., langchain's create_importer)
      // Pattern: __init__.py files define __getattr__ + a dict mapping names to dotted module paths
      // The dict values are dynamically imported at runtime via importlib.import_module()
      if (isPythonFile && current.endsWith('__init__.py') && projectPath) {
        try {
          const pyContent = readFileSync(join(projectPath, current), 'utf-8');
          if (pyContent.includes('__getattr__')) {
            // Extract dotted module paths from dict-like structures
            // Matches: "module.path.name" in dict values, list items, or _module_lookup patterns
            const dottedModuleRe = /["'](\w+(?:\.\w+){1,})["']/g;
            let pyMatch;
            while ((pyMatch = dottedModuleRe.exec(pyContent)) !== null) {
              const dottedPath = pyMatch[1];
              const resolved = resolveImport(current, dottedPath);
              for (const r of resolved) {
                if (!visited.has(r)) {
                  queue.push(r);
                }
              }
            }
            // When __init__.py has __getattr__, ALL sibling .py modules are reachable
            // Python allows `from package.submodule import X` which bypasses __init__.py
            // and loads the submodule directly (e.g., langchain deprecation shims)
            const pkgDir = dirname(current);
            const siblingFiles = dirIndex ? dirIndex.get(pkgDir) : null;
            if (siblingFiles) {
              for (const f of siblingFiles) {
                if (f.endsWith('.py') && !f.endsWith('__init__.py') && !visited.has(f)) {
                  queue.push(f);
                }
              }
            }
            // Also recurse into sub-packages: when __init__.py has __getattr__,
            // sub-packages are also importable (from package.sub.module import X)
            if (dirIndex) {
              for (const [dir, files] of dirIndex) {
                if (dir.startsWith(pkgDir + '/') && dir !== pkgDir) {
                  for (const f of files) {
                    if (f.endsWith('__init__.py') && !visited.has(f)) {
                      queue.push(f);
                    }
                  }
                }
              }
            }
          }
        } catch { /* skip read errors */ }
      }

      // Follow Python import_module() / importlib.import_module() patterns
      // Sphinx uses import_module('sphinx.search.da.SearchDanish') and import_module('sphinx.directives.other')
      if (isPythonFile && projectPath) {
        try {
          const pyContent = readFileSync(join(projectPath, current), 'utf-8');
          if (pyContent.includes('import_module')) {
            const dottedModuleRe = /["'](\w+(?:\.\w+){1,})["']/g;
            let pyMatch;
            while ((pyMatch = dottedModuleRe.exec(pyContent)) !== null) {
              const dottedPath = pyMatch[1];
              const resolved = resolveImport(current, dottedPath);
              for (const r of resolved) {
                if (!visited.has(r)) {
                  queue.push(r);
                }
              }
            }
          }
        } catch { /* skip read errors */ }
      }

      // Follow Svelte component imports: parse <script> blocks for import statements
      // This handles .svelte files that import .ts/.js modules (e.g., gradio imageeditor)
      if (current.endsWith('.svelte') && projectPath) {
        try {
          const svelteContent = readFileSync(join(projectPath, current), 'utf-8');
          // Extract <script> block content
          const scriptBlockRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
          let scriptMatch;
          while ((scriptMatch = scriptBlockRe.exec(svelteContent)) !== null) {
            const scriptContent = scriptMatch[1];
            // Extract import paths from script content
            const importRe = /(?:import|from)\s+['"]([^'"]+)['"]/g;
            let importMatch;
            while ((importMatch = importRe.exec(scriptContent)) !== null) {
              const importPath = importMatch[1];
              if (importPath.startsWith('.')) {
                const resolved = resolveImport(current, importPath);
                for (const r of resolved) {
                  if (!visited.has(r)) {
                    queue.push(r);
                  }
                }
              }
            }
          }
        } catch { /* skip read errors */ }
      }

      // Follow Vue SFC imports: parse <script> blocks for import statements
      if (current.endsWith('.vue') && projectPath) {
        try {
          const vueContent = readFileSync(join(projectPath, current), 'utf-8');
          const scriptBlockRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
          let scriptMatch;
          while ((scriptMatch = scriptBlockRe.exec(vueContent)) !== null) {
            const scriptContent = scriptMatch[1];
            const importRe = /(?:import|from)\s+['"]([^'"]+)['"]/g;
            let importMatch;
            while ((importMatch = importRe.exec(scriptContent)) !== null) {
              const importPath = importMatch[1];
              if (importPath.startsWith('.')) {
                const resolved = resolveImport(current, importPath);
                for (const r of resolved) {
                  if (!visited.has(r)) {
                    queue.push(r);
                  }
                }
              }
            }
          }
        } catch { /* skip read errors */ }
      }

      // Follow additional references (e.g., C# class instantiation, extension methods)
      if (additionalRefs) {
        const refs = additionalRefs.get(current);
        if (refs) {
          for (const refFile of refs) {
            if (!visited.has(refFile)) {
              queue.push(refFile);
            }
          }
        }
      }
    }
  }

  // Start from each entry point using lookup maps instead of O(entryPoints × files)
  // Build a Set of all known file paths for exact matching
  const allFilePathSet = new Set(allFilePaths);
  for (const entryPoint of entryPointFiles) {
    // 1. Exact path match
    if (allFilePathSet.has(entryPoint)) {
      walkFromFile(entryPoint);
      continue;
    }

    // 2. Extension-less match via filePathsNoExt
    const entryNoExt = entryPoint.replace(/\.([mc]?[jt]s|[jt]sx|py|pyi|java|kt|kts|cs|go|rs)$/, '');
    const noExtMatches = filePathsNoExt.get(entryNoExt);
    if (noExtMatches) {
      for (const fp of noExtMatches) walkFromFile(fp);
      continue;
    }

    // 3. Suffix-based fallback for entries like "src/index.ts" matching "packages/foo/src/index.ts"
    const entryBasename = entryPoint.includes('/') ? entryPoint.slice(entryPoint.lastIndexOf('/') + 1) : entryPoint;
    const entryNoExtBasename = entryNoExt.includes('/') ? entryNoExt.slice(entryNoExt.lastIndexOf('/') + 1) : entryNoExt;
    let found = false;
    // Try exact suffix match
    const suffixCandidates = suffixIndex.get(entryBasename) || [];
    for (const fp of suffixCandidates) {
      if (fp.endsWith('/' + entryPoint) || fp === entryPoint) {
        walkFromFile(fp);
        found = true;
      }
    }
    if (found) continue;
    // Try extension variants via suffix index
    for (const ext of ['.tsx', '.ts', '.jsx', '.js']) {
      const variantBasename = entryNoExtBasename + ext;
      const variants = suffixIndex.get(variantBasename) || [];
      for (const fp of variants) {
        if (fp.endsWith('/' + entryNoExt + ext)) {
          walkFromFile(fp);
          found = true;
        }
      }
      if (found) break;
    }
  }

  // Walk imports from files discovered via glob patterns and directory-scanning
  // These were added to reachable but not walked (their transitive imports need following)
  for (const file of reachable) {
    if (!visited.has(file)) {
      walkFromFile(file);
    }
  }

  // Propagate export usage through re-export chains
  // e.g., if barrel.ts re-exports { foo } from './source.ts' and foo is consumed from barrel,
  // then foo should be marked as consumed in source.ts too
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    for (const [filePath, exports] of fileExports) {
      const barrelUsage = exportUsageMap.get(filePath);
      if (!barrelUsage) continue;

      for (const exp of exports) {
        if (!exp.sourceModule) continue; // Only process re-exports

        const resolvedSources = resolveImport(filePath, exp.sourceModule);
        for (const sourceFile of resolvedSources) {
          let sourceUsage = exportUsageMap.get(sourceFile);

          if (exp.name === '*' && exp.type === 'reexport-all') {
            // export * from './source' — propagate all named usages that aren't
            // direct exports of the barrel file itself
            const barrelDirectExports = new Set();
            for (const e of exports) {
              if (!e.sourceModule && e.name !== '*') barrelDirectExports.add(e.name);
            }

            for (const [symbolName, usages] of barrelUsage) {
              if (symbolName === '__SIDE_EFFECT__') continue;
              if (symbolName === '__ALL__' || symbolName === '*') {
                // All exports consumed from barrel — propagate to source
                if (!sourceUsage) { sourceUsage = new Map(); exportUsageMap.set(sourceFile, sourceUsage); }
                if (!sourceUsage.has('__ALL__')) {
                  sourceUsage.set('__ALL__', [...usages]);
                  changed = true;
                }
                continue;
              }
              // Named symbol: propagate if not a direct export of the barrel
              if (barrelDirectExports.has(symbolName)) continue;
              if (!sourceUsage) { sourceUsage = new Map(); exportUsageMap.set(sourceFile, sourceUsage); }
              if (!sourceUsage.has(symbolName)) {
                sourceUsage.set(symbolName, [...usages]);
                changed = true;
              }
            }
          } else {
            // export { foo } from './source' — propagate if foo is consumed from barrel
            const consumed = barrelUsage.get(exp.name);
            const allConsumed = barrelUsage.has('__ALL__') || barrelUsage.has('*');
            if (consumed || allConsumed) {
              if (!sourceUsage) { sourceUsage = new Map(); exportUsageMap.set(sourceFile, sourceUsage); }
              if (!sourceUsage.has(exp.name)) {
                sourceUsage.set(exp.name, consumed ? [...consumed] : (barrelUsage.get('__ALL__') || barrelUsage.get('*') || []).map(u => ({ ...u })));
                changed = true;
              }
            }
          }
        }
      }
    }
    if (!changed) break;
  }

  return { reachable, exportUsageMap };
}

/**
 * Main dead code analysis function
 * @param {Array} jsAnalysis - Parsed JavaScript files
 * @param {Object} importGraph - Import graph from analyseImports
 * @param {string} projectPath - Path to project root
 * @param {Object} packageJson - Parsed package.json
 * @param {Object} config - Configuration options (including deadCode.dynamicPatterns)
 * @param {Function} onProgress - Progress callback
 */
export async function findDeadCode(jsAnalysis, importGraph, projectPath = null, packageJson = {}, config = {}, onProgress = () => {}) {
  // Handle backwards compatibility: if config is a function, it's the old onProgress param
  if (typeof config === 'function') {
    onProgress = config;
    config = {};
  }

  // Set up dynamic patterns from config
  const dynamicPatterns = config.dynamicPatterns || config.deadCode?.dynamicPatterns || [];
  setDynamicPatterns(dynamicPatterns);

  // Set up DI patterns from config
  // Includes NestJS, TypeORM, Angular, InversifyJS, Spring, and common DI frameworks
  const diDecorators = config.diDecorators || config.deadCode?.diDecorators || [
    // NestJS and common DI frameworks - decorated classes are container-managed
    // @Controller marks HTTP endpoints, @Module defines DI containers,
    // @Resolver for GraphQL endpoints
    'Controller', 'Module', 'Resolver',
    // @Service and @Injectable are commonly used for auto-registered services
    // Used by: NestJS, Angular, InversifyJS, n8n's @n8n/di, etc.
    'Service', 'Injectable',
    // @RestController used by n8n and other frameworks for HTTP endpoints
    'RestController',
    // n8n-specific module decorator for dynamic module loading
    'BackendModule',
    // HTTP method decorators indicate routes (these imply the class IS used)
    'Get', 'Post', 'Put', 'Delete', 'Patch', 'Options', 'Head', 'All',
    // TypeORM entities are loaded by reflection
    'Entity',
    // Vue Class Component
    'Options',
    // === Java/Kotlin Spring Framework ===
    // Spring stereotype annotations - classes are loaded by component scan
    'RestController', 'Repository', 'Configuration',
    'SpringBootApplication', 'Bean', 'Aspect',
    // Spring request mappings
    'RequestMapping', 'GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping',
    // === C#/.NET ===
    // ASP.NET Core controller attribute
    'ApiController',
    // === Python Decorators (captured as annotations) ===
    // FastAPI decorators
    'router', 'app',
    // Celery
    'task', 'shared_task'
  ];
  const diContainerPatterns = config.diContainerPatterns || config.deadCode?.diContainerPatterns || [
    'Container\\.get\\s*[<(]', 'Container\\.resolve\\s*[<(]',
    'container\\.resolve\\s*[<(]', 'moduleRef\\.get\\s*[<(]',
    'injector\\.get\\s*[<(]',
    // C#/.NET DI registration patterns
    'AddScoped\\s*<', 'AddSingleton\\s*<', 'AddTransient\\s*<',
    'Services\\.Add\\s*<', 'Services\\.AddScoped\\s*<',
    'Services\\.AddSingleton\\s*<', 'Services\\.AddTransient\\s*<',
    // C#/.NET middleware and generic type references
    'UseMiddleware\\s*<', 'AddDbContext\\s*<',
    'DbSet\\s*<',
    // Interface implementations in DI
    'AddScoped\\s*<\\s*[A-Z]\\w*\\s*,\\s*',
    'AddSingleton\\s*<\\s*[A-Z]\\w*\\s*,\\s*',
    'AddTransient\\s*<\\s*[A-Z]\\w*\\s*,\\s*'
  ];
  setDIPatterns(diDecorators, diContainerPatterns);

  // Detect frameworks from package.json for framework-specific entry points
  detectFrameworks(packageJson);

  // Also detect frameworks from workspace sub-packages (monorepo support)
  // e.g., nocodb has nuxt in packages/nc-gui/package.json, not the root
  // Use _addFrameworks to accumulate rather than replace
  if (projectPath) {
    const { workspacePackages: wpkgs } = extractPathAliases(projectPath);
    for (const [, pkg] of wpkgs) {
      const subPkgPath = join(projectPath, pkg.dir, 'package.json');
      try {
        const subPkg = JSON.parse(readFileSync(subPkgPath, 'utf-8'));
        _addFrameworks(subPkg);
      } catch { /* ignore */ }
    }
    // Also detect Nuxt by nuxt.config.ts presence (covers cases where nuxt isn't a direct dep)
    try {
      const topEntries = readdirSync(projectPath, { withFileTypes: true });
      for (const entry of topEntries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          if (existsSync(join(projectPath, entry.name, 'nuxt.config.ts')) ||
              existsSync(join(projectPath, entry.name, 'nuxt.config.js'))) {
            DETECTED_FRAMEWORKS.add('nuxt');
            DETECTED_FRAMEWORKS.add('vue');
          }
        }
      }
    } catch { /* ignore */ }
  }

  // Parse .csproj ProjectReferences for C#/.NET projects
  // This builds a transitive dependency graph so all files in referenced projects are entry points
  const csprojReferencedDirs = parseCsprojReferences(projectPath);

  // Detect Deno workspaces (deno.json with "workspace" array)
  // Each workspace member's mod.ts/main.ts is an entry point
  const denoWorkspaceDirs = new Set();
  if (projectPath) {
    try {
      const denoConfigPath = join(projectPath, 'deno.json');
      if (existsSync(denoConfigPath)) {
        const denoConfig = JSON.parse(readFileSync(denoConfigPath, 'utf-8'));
        if (Array.isArray(denoConfig.workspace)) {
          for (const member of denoConfig.workspace) {
            const dir = member.replace(/^\.\//, '').replace(/\/$/, '');
            denoWorkspaceDirs.add(dir);
          }
        }
      }
    } catch { /* ignore */ }
  }

  // Set up dynamic package.json fields from config
  const dynamicPackageFields = config.dynamicPackageFields || config.deadCode?.dynamicPackageFields ||
    ['nodes', 'plugins', 'credentials', 'extensions', 'adapters', 'connectors'];
  setDynamicPackageFields(dynamicPackageFields);

  // Filter out generated code files
  const excludeGenerated = config.excludeGenerated ?? config.deadCode?.excludeGenerated ?? true;
  const customGeneratedPatterns = (config.generatedPatterns || config.deadCode?.generatedPatterns || [])
    .map(p => typeof p === 'string' ? new RegExp(p) : p);

  let analysisFiles = jsAnalysis;
  const excludedGeneratedFiles = [];

  if (excludeGenerated) {
    const { included, excluded } = filterGeneratedFiles(jsAnalysis, {
      customPatterns: customGeneratedPatterns,
      checkContent: true
    });
    analysisFiles = included;
    excludedGeneratedFiles.push(...excluded);
  }

  // Filter out entries with no file path (can happen with parse failures)
  analysisFiles = analysisFiles.filter(f => f.file?.relativePath || f.file);

  // Create unified entry point detector (optional - can be enabled via config)
  const useUnifiedDetector = config.useUnifiedEntryDetector ?? config.deadCode?.useUnifiedEntryDetector ?? false;
  const entryPointDetector = useUnifiedDetector ? createEntryPointDetector(projectPath, packageJson, {
    diDecorators,
    customPatterns: dynamicPatterns
  }) : null;

  const dynamicFiles = [];  // Track files skipped due to dynamic patterns

  const results = {
    fullyDeadFiles: [],
    partiallyDeadFiles: [],
    skippedDynamic: [],  // Files skipped due to dynamic loading patterns
    excludedGenerated: excludedGeneratedFiles,  // Files excluded as generated code
    entryPoints: [],
    summary: {
      totalDeadBytes: 0,
      totalDeadExports: 0,
      totalLiveExports: 0,
      filesAnalysed: 0,
      filesWithDeadCode: 0,
      dynamicPatternCount: dynamicPatterns.length,
      skippedDynamicCount: 0,
      excludedGeneratedCount: excludedGeneratedFiles.length
    }
  };

  // Extract entry points from various sources
  const scriptEntryPoints = extractScriptEntryPoints(packageJson);
  const scriptGlobEntryPoints = projectPath ? extractScriptGlobEntryPoints(packageJson, projectPath) : new Set();
  const nestedScriptEntryPoints = projectPath ? extractAllScriptEntryPoints(projectPath) : new Set();
  const htmlEntryPoints = extractHtmlEntryPoints(projectPath);
  const viteReplacementEntryPoints = extractViteReplacementEntryPoints(projectPath);

  // Collect entry points from bundler and CI/CD configs
  const configEntryData = projectPath ? collectConfigEntryPoints(projectPath) : { entries: [], npmScripts: [] };
  const configEntryPoints = configEntryData.entries;
  setConfigEntryData(configEntryData);  // Make available to isEntryPoint()

  // Extract entry points from Gruntfile/Gulpfile concat tasks
  const gruntConcatEntries = projectPath ? extractGruntConcatSources(projectPath) : new Set();

  // Extract entry points from tsconfig.json files/include arrays
  const tsconfigFileEntries = projectPath ? extractTsconfigFileEntries(projectPath) : new Set();

  // Collect all entry point file paths for reachability analysis
  const entryPointFiles = new Set([...scriptEntryPoints, ...scriptGlobEntryPoints, ...nestedScriptEntryPoints, ...htmlEntryPoints, ...viteReplacementEntryPoints, ...configEntryPoints, ...gruntConcatEntries, ...tsconfigFileEntries]);

  // Build map of class names to files (for DI container reference detection)
  const classToFile = new Map();
  for (const file of analysisFiles) {
    const filePath = file.file?.relativePath || file.file;
    for (const cls of file.classes || []) {
      if (cls.name) {
        classToFile.set(cls.name, filePath);
      }
    }
  }

  // B2: Helper to get file content — re-reads from disk if content was stripped by worker
  function _getContent(file) {
    if (file.content) return file.content;
    if (!projectPath) return '';
    const filePath = file.file?.relativePath || file.file;
    try { return readFileSync(join(projectPath, filePath), 'utf-8'); } catch { return ''; }
  }

  // Collect all class names referenced via DI container patterns (Container.get, etc.)
  // Only files with classes need DI scanning (skip the majority)
  const diReferencedClasses = new Set();
  for (const file of analysisFiles) {
    if (!file.classes?.length) continue;  // Only scan files that have classes
    const content = _getContent(file);
    const refs = extractDIContainerReferences(content);
    for (const className of refs) {
      diReferencedClasses.add(className);
    }
  }

  // Build map of C# extension method names to files
  const extensionMethodToFile = new Map();
  for (const file of analysisFiles) {
    const filePath = file.file?.relativePath || file.file;
    if (filePath.endsWith('.cs')) {
      const methods = extractCSharpExtensionMethods(file);
      for (const methodName of methods) {
        extensionMethodToFile.set(methodName, filePath);
      }
    }
  }

  // Build C# namespace-to-files map for same-namespace grouping
  // In C#, all files in the same namespace can reference each other implicitly
  const namespaceToFiles = new Map();
  for (const file of analysisFiles) {
    const filePath = file.file?.relativePath || file.file;
    if (filePath.endsWith('.cs') && file.metadata?.namespace) {
      const ns = file.metadata.namespace;
      if (!namespaceToFiles.has(ns)) namespaceToFiles.set(ns, []);
      namespaceToFiles.get(ns).push(filePath);
    }
  }

  // Set of all known class names (for C# class reference detection)
  const knownClassNames = new Set(classToFile.keys());

  // Collect C# class references (new ClassName, typeof, etc.) and extension method calls
  // Build a map of file -> Set<referenced files> for the reachability graph
  const csharpFileRefs = new Map();
  for (const file of analysisFiles) {
    const filePath = file.file?.relativePath || file.file;
    // B2: Only re-read content for .cs files (C# analysis), not all files
    const content = filePath.endsWith('.cs') ? _getContent(file) : '';

    // Detect C# class references
    if (filePath.endsWith('.cs')) {
      const refs = new Set();

      const classRefs = extractCSharpClassReferences(content, knownClassNames);
      for (const className of classRefs) {
        const classFile = classToFile.get(className);
        if (classFile && classFile !== filePath) {
          refs.add(classFile);
        }
        // Also add to DI-referenced for entry point detection
        diReferencedClasses.add(className);
      }

      // Detect extension method calls
      const calledExtensionFiles = findCalledExtensionMethods(content, extensionMethodToFile);
      for (const extFile of calledExtensionFiles) {
        if (extFile !== filePath) {
          refs.add(extFile);
        }
      }

      if (refs.size > 0) {
        csharpFileRefs.set(filePath, refs);
      }
    }
  }

  // Add same-namespace links: all .cs files in the same namespace connect to each other
  // This ensures that when one file in a namespace is reachable, all siblings are too
  for (const [, files] of namespaceToFiles) {
    if (files.length < 2 || files.length > 200) continue; // skip trivial or huge namespaces
    for (const file of files) {
      const existing = csharpFileRefs.get(file) || new Set();
      for (const sibling of files) {
        if (sibling !== file) existing.add(sibling);
      }
      if (existing.size > 0) csharpFileRefs.set(file, existing);
    }
  }

  // A10: Free content strings from parsed files — DI/C# analysis above is the last consumer.
  // Content will be re-read from disk only for dead files (small subset) below.
  // This frees ~250MB (50K × 5KB) from the heap mid-pipeline.
  for (const file of analysisFiles) {
    file.content = null;
  }

  // First pass: identify all entry points
  // Use full jsAnalysis (not filtered analysisFiles) because entry points in generated files
  // still import non-generated files that need to be walked for reachability
  for (const file of jsAnalysis) {
    const filePath = file.file?.relativePath || file.file;
    if (!isCodeFile(filePath)) continue;

    // Heuristic: Files in directories/names with "dead", "deprecated", "legacy", etc.
    // are likely not active code - skip treating as entry points
    // Also catch files named exactly "dead.ext" (common in Go: dead.go)
    const deadPatterns = /(^|\/)(dead[-_]|deprecated[-_]|legacy[-_]|old[-_]|unused[-_])/i;
    const deadFileExact = /(^|\/)dead\.[^/]+$/i;  // matches dead.go, dead.py, etc.
    if (deadPatterns.test(filePath) || deadFileExact.test(filePath)) {
      // Don't mark as entry point, let it be analyzed for dead code
      continue;
    }
    if (false) { /* placeholder */
    }

    // C#/.NET: Mark all .cs files in transitively-referenced project directories as entry points
    if (filePath.endsWith('.cs') && csprojReferencedDirs.size > 0) {
      const fileDir = dirname(filePath);
      let inReferencedProject = false;
      for (const refDir of csprojReferencedDirs) {
        if (fileDir === refDir || fileDir.startsWith(refDir + '/')) {
          inReferencedProject = true;
          break;
        }
      }
      if (inReferencedProject) {
        entryPointFiles.add(filePath);
        results.entryPoints.push({
          file: filePath,
          reason: 'In .csproj-referenced project directory',
          isDynamic: false
        });
        continue;
      }
    }

    // Deno workspace: treat mod.ts/main.ts in each workspace member as entry point
    // Also treat all exported files from member deno.json as entry points
    if (denoWorkspaceDirs.size > 0 && /\.[mc]?[jt]sx?$/.test(filePath)) {
      const fileDir = dirname(filePath);
      for (const wsDir of denoWorkspaceDirs) {
        if (fileDir === wsDir || fileDir.startsWith(wsDir + '/')) {
          const fileName = basename(filePath);
          // mod.ts and main.ts are explicit entry points
          if (fileName === 'mod.ts' || fileName === 'main.ts' || fileName === 'mod.js' || fileName === 'main.js') {
            entryPointFiles.add(filePath);
            results.entryPoints.push({
              file: filePath,
              reason: `Deno workspace entry: ${wsDir}`,
              isDynamic: false
            });
          }
          // Also check if this file is referenced in the member's deno.json exports
          if (!entryPointFiles.has(filePath) && projectPath) {
            try {
              const memberDenoJson = join(projectPath, wsDir, 'deno.json');
              if (existsSync(memberDenoJson)) {
                const memberConfig = JSON.parse(readFileSync(memberDenoJson, 'utf-8'));
                if (memberConfig.exports) {
                  const exportPaths = typeof memberConfig.exports === 'string'
                    ? [memberConfig.exports]
                    : Object.values(memberConfig.exports);
                  for (const ep of exportPaths) {
                    const resolvedExport = join(wsDir, ep.replace(/^\.\//, '')).replace(/\\/g, '/');
                    if (filePath === resolvedExport) {
                      entryPointFiles.add(filePath);
                      results.entryPoints.push({
                        file: filePath,
                        reason: `Deno workspace export: ${wsDir}`,
                        isDynamic: false
                      });
                      break;
                    }
                  }
                }
              }
            } catch {}
          }
          break;
        }
      }
    }

    // Check multi-language metadata for entry point indicators
    if (file.metadata) {
      // Python entry points
      if (file.metadata.hasMainBlock || file.metadata.isCelery) {
        entryPointFiles.add(filePath);
        results.entryPoints.push({
          file: filePath,
          reason: file.metadata.hasMainBlock ? 'Has __main__ block' : 'Has Celery task decorators',
          isDynamic: false
        });
        continue;
      }
      // Java/Kotlin entry points
      if (file.metadata.hasMainMethod || file.metadata.isSpringComponent) {
        entryPointFiles.add(filePath);
        results.entryPoints.push({
          file: filePath,
          reason: file.metadata.hasMainMethod ? 'Has main() method' : 'Has Spring component annotation',
          isDynamic: false
        });
        continue;
      }
      // Extended Java/Kotlin entry points: CDI, Quarkus, JPA, and test annotations
      if (file.annotations && file.annotations.length > 0) {
        const entryAnnotations = new Set([
          // Quarkus CDI & Build System
          'QuarkusMain', 'ApplicationScoped', 'RequestScoped', 'SessionScoped', 'Dependent',
          'Singleton', 'QuarkusTest', 'QuarkusIntegrationTest',
          'BuildStep', 'BuildSteps', 'Recorder',
          // GraalVM native-image substitutions
          'TargetClass', 'Substitute',
          // Jakarta CDI / Java EE
          'Stateless', 'Stateful', 'MessageDriven', 'Entity', 'MappedSuperclass',
          'Embeddable', 'Converter', 'Named', 'Startup',
          // JAX-RS / REST
          'Path', 'Provider', 'ApplicationPath',
          // Spring additional
          'Bean', 'Aspect', 'ControllerAdvice', 'RestControllerAdvice',
          'EnableAutoConfiguration', 'Import', 'ComponentScan',
          // JUnit / Testing
          'Test', 'ParameterizedTest', 'TestMethodOrder', 'TestInstance',
          'ExtendWith', 'SpringBootTest', 'WebMvcTest', 'DataJpaTest',
          // Servlet
          'WebServlet', 'WebFilter', 'WebListener',
        ]);
        const hasEntryAnnotation = file.annotations.some(a => entryAnnotations.has(a.name));
        if (hasEntryAnnotation) {
          const matchedAnnotation = file.annotations.find(a => entryAnnotations.has(a.name));
          entryPointFiles.add(filePath);
          results.entryPoints.push({
            file: filePath,
            reason: `Has @${matchedAnnotation.name} annotation`,
            isDynamic: false
          });
          continue;
        }
      }
      // Go entry points
      if (file.metadata.isMainPackage && file.metadata.hasMainFunction) {
        entryPointFiles.add(filePath);
        results.entryPoints.push({
          file: filePath,
          reason: 'Is Go main package with main()',
          isDynamic: false
        });
        continue;
      }
      if (file.metadata.hasInitFunction) {
        entryPointFiles.add(filePath);
        results.entryPoints.push({
          file: filePath,
          reason: 'Has Go init() function',
          isDynamic: false
        });
        continue;
      }
      if (file.metadata.isTestFile) {
        entryPointFiles.add(filePath);
        results.entryPoints.push({
          file: filePath,
          reason: 'Is Go test file',
          isDynamic: false
        });
        continue;
      }
      // Rust entry points
      if (file.metadata.isBinaryCrate || file.metadata.isLibraryCrate) {
        entryPointFiles.add(filePath);
        results.entryPoints.push({
          file: filePath,
          reason: file.metadata.isBinaryCrate ? 'Is Rust binary crate' : 'Is Rust library crate',
          isDynamic: false
        });
        continue;
      }
    }

    // Pass classes for DI decorator detection
    const fileClasses = file.classes || [];

    // Use unified detector if enabled, otherwise use legacy detection
    const entryCheck = entryPointDetector
      ? entryPointDetector.isEntryPoint(filePath, { classes: fileClasses, metadata: file.metadata })
      : isEntryPoint(filePath, packageJson, projectPath, htmlEntryPoints, scriptEntryPoints, fileClasses);

    if (entryCheck.isEntry) {
      entryPointFiles.add(filePath);
      results.entryPoints.push({
        file: filePath,
        reason: entryCheck.reason,
        isDynamic: entryCheck.isDynamic || false
      });

      // Track files skipped due to dynamic loading patterns
      if (entryCheck.isDynamic) {
        results.skippedDynamic.push({
          file: filePath,
          pattern: entryCheck.matchedPattern || entryCheck.reason,
          reason: entryCheck.reason
        });
      }
    } else {
      // Check if any class in this file is referenced via DI container (Container.get, etc.)
      for (const cls of fileClasses) {
        if (cls.name && diReferencedClasses.has(cls.name)) {
          entryPointFiles.add(filePath);
          results.entryPoints.push({
            file: filePath,
            reason: `Class ${cls.name} accessed via DI container (Container.get, etc.)`,
            isDynamic: true
          });
          results.skippedDynamic.push({
            file: filePath,
            pattern: 'DI container access',
            reason: `Class ${cls.name} accessed via DI container`
          });
          break;  // Only need to add once per file
        }
      }
    }
  }

  // Update skipped dynamic count
  results.summary.skippedDynamicCount = results.skippedDynamic.length;

  // Mark workspace package exports subpaths as entry points
  // These are published API surfaces consumed by external packages
  {
    const { workspacePackages: wpkgs } = extractPathAliases(projectPath);
    const allFilePaths = new Set(jsAnalysis.map(f => f.file?.relativePath || f.file));
    const allFileNoExt = new Map();
    for (const fp of allFilePaths) {
      const noExt = fp.replace(/\.([mc]?[jt]s|[jt]sx)$/, '');
      if (!allFileNoExt.has(noExt)) allFileNoExt.set(noExt, []);
      allFileNoExt.get(noExt).push(fp);
    }

    // Helper: generate dist→src candidates for a raw export path
    // Handles both leading dist/ (e.g., dist/server/index) and nested dist/
    // (e.g., store/dist/store, compat/dist/compat)
    function _distToSrcCandidates(rawPath) {
      const candidates = [rawPath];
      // Always try src/ prefix as a fallback (many libraries compile src/ → root)
      // e.g., lit-html.js → src/lit-html.ts, reactive-element.js → src/reactive-element.ts
      if (!/^(src|dist|lib|build|out)[\/-]/.test(rawPath) && !rawPath.includes('/src/')) {
        candidates.push('src/' + rawPath);
      }
      // Leading dist-cjs/, dist-es/, dist-types/ etc. (AWS SDK v3 pattern)
      if (/^dist-\w+\//.test(rawPath)) {
        candidates.push(rawPath.replace(/^dist-\w+\//, 'src/'));
        candidates.push(rawPath.replace(/^dist-\w+\//, ''));
      }
      // Leading dist/ with format subdir (tshy pattern): dist/commonjs/index → src/index
      if (/^dist\/(commonjs|cjs|esm|browser|react-native|workerd|node|default|types)\//.test(rawPath)) {
        candidates.push(rawPath.replace(/^dist\/(commonjs|cjs|esm|browser|react-native|workerd|node|default|types)\//, 'src/'));
      }
      // Leading dist/
      if (/^dist\//.test(rawPath)) {
        candidates.push(rawPath.replace(/^dist\//, 'src/'));
        candidates.push(rawPath.replace(/^dist\//, ''));
        candidates.push(rawPath.replace(/^dist\/([^/]+)\//, '$1/src/'));
      }
      // Nested dist-*/ (e.g., packages/foo/dist-cjs/index → packages/foo/src/index)
      if (/\/dist-\w+\//.test(rawPath)) {
        candidates.push(rawPath.replace(/\/dist-\w+\//, '/src/'));
        candidates.push(rawPath.replace(/\/dist-\w+\//, '/'));
      }
      // Nested dist/ (e.g., store/dist/store → store/src/store)
      if (/\/dist\//.test(rawPath)) {
        candidates.push(rawPath.replace(/\/dist\//, '/src/'));
        candidates.push(rawPath.replace(/\/dist\//, '/'));
      }
      // Nested lib/ or build/ or out/
      if (/\/(lib|build|out)\//.test(rawPath)) {
        candidates.push(rawPath.replace(/\/(lib|build|out)\//, '/src/'));
        candidates.push(rawPath.replace(/\/(lib|build|out)\//, '/'));
      }
      return candidates;
    }

    function _tryMatchExportPath(rawPath, pkgDir, pkgName, subpath) {
      const candidates = _distToSrcCandidates(rawPath);
      // Also try src/index fallback when the filename doesn't match
      // e.g., web/storage/dist/storage → web/storage/src/storage (miss) → web/storage/src/index (hit)
      const srcDirs = new Set();
      for (const candidate of candidates) {
        const fullPath = pkgDir ? `${pkgDir}/${candidate}` : candidate;
        const noExt = fullPath.replace(/\.([mc]?[jt]s|[jt]sx)$/, '');
        const matches = allFileNoExt.get(noExt) || allFileNoExt.get(fullPath + '/index') || allFileNoExt.get(noExt + '/index') || [];
        for (const fp of matches) {
          if (!entryPointFiles.has(fp)) {
            entryPointFiles.add(fp);
            results.entryPoints.push({
              file: fp,
              reason: `Package export: ${pkgName}/${subpath}`,
              isDynamic: false
            });
          }
        }
        if (matches.length > 0) return true;
        // Track parent src directories for fallback
        if (candidate.includes('/src/')) {
          const srcDir = candidate.replace(/\/[^/]+$/, '');
          srcDirs.add(srcDir);
        }
      }
      // Fallback: try src/index in the mapped directory
      for (const srcDir of srcDirs) {
        const indexPath = pkgDir ? `${pkgDir}/${srcDir}/index` : `${srcDir}/index`;
        const matches = allFileNoExt.get(indexPath) || [];
        for (const fp of matches) {
          if (!entryPointFiles.has(fp)) {
            entryPointFiles.add(fp);
            results.entryPoints.push({
              file: fp,
              reason: `Package export: ${pkgName}/${subpath}`,
              isDynamic: false
            });
          }
        }
        if (matches.length > 0) return true;
      }
      return false;
    }

    for (const [pkgName, pkg] of wpkgs) {
      // Process primary exports from exportsMap
      if (pkg.exportsMap?.size > 0) {
        for (const [subpath, rawPath] of pkg.exportsMap) {
          _tryMatchExportPath(rawPath, pkg.dir, pkgName, subpath);
        }
      }

      // Also collect ALL conditional export paths (different conditions may point to different files)
      // e.g., Solid: { browser: { import: "./dist/solid.js" }, node: { import: "./dist/server.js" } }
      const pkgJsonPath = join(projectPath, pkg.dir, 'package.json');
      try {
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
        if (pkgJson.exports && typeof pkgJson.exports === 'object') {
          for (const [subpath, target] of Object.entries(pkgJson.exports)) {
            if (typeof target !== 'object' || target === null) continue;
            const allPaths = _collectAllExportPaths(target);
            for (const exportPath of allPaths) {
              if (typeof exportPath === 'string' && !exportPath.endsWith('.d.ts') && !exportPath.endsWith('.d.mts') && !exportPath.endsWith('.d.cts')) {
                const rawPath = exportPath.replace(/^\.\//, '').replace(/\.(c|m)?js$/, '').replace(/\.d\.(c|m)?ts$/, '');
                _tryMatchExportPath(rawPath, pkg.dir, pkgName, subpath.replace(/^\.\//, '') || '.');
              }
            }
          }
        }
      } catch { /* ignore */ }
    }
    // Also process root package.json subpath exports (non-workspace single packages like hono)
    // e.g., hono's package.json has exports: { "./jsx/dom": { import: "./dist/jsx/dom/index.js" } }
    // which should map to src/jsx/dom/index.ts as an entry point
    const rootPkgJsonPath = join(projectPath, 'package.json');
    try {
      const rootPkgJson = JSON.parse(readFileSync(rootPkgJsonPath, 'utf-8'));
      if (rootPkgJson.exports && typeof rootPkgJson.exports === 'object') {
        for (const [subpath, target] of Object.entries(rootPkgJson.exports)) {
          if (subpath === '.' || subpath === './package.json') continue;
          const allPaths = _collectAllExportPaths(target);
          for (const exportPath of allPaths) {
            if (typeof exportPath === 'string' && !exportPath.endsWith('.d.ts') && !exportPath.endsWith('.d.mts') && !exportPath.endsWith('.d.cts')) {
              const rawPath = exportPath.replace(/^\.\//, '').replace(/\.(c|m)?js$/, '').replace(/\.d\.(c|m)?ts$/, '');
              _tryMatchExportPath(rawPath, '', rootPkgJson.name || '<root>', subpath.replace(/^\.\//, '') || '.');
            }
          }
        }
      }
    } catch { /* ignore — no root package.json or parse error */ }

    // end exports marking
  }

  // Build the reachability graph from entry points
  // This is the key fix: we walk FROM entry points to find what's actually used
  // Pass projectPath to resolve path aliases like @/ -> src/
  // Note: Use the full analysis (jsAnalysis) for reachability - we need full import graph
  // Also pass C# file references (class instantiation, extension methods) for .NET projects
  const { reachable: reachableFiles, exportUsageMap } = buildReachableFiles(entryPointFiles, jsAnalysis, projectPath, csharpFileRefs);

  // Build importer count map: for each file, how many unique files import it
  const importerCountMap = new Map();
  for (const [targetFile, usageMap] of exportUsageMap) {
    const importers = new Set();
    for (const [, importerList] of usageMap) {
      if (Array.isArray(importerList)) {
        for (const u of importerList) {
          if (u.importerFile) importers.add(u.importerFile);
        }
      }
    }
    importerCountMap.set(targetFile, importers.size);
  }

  // Use analysisFiles for dead code analysis (excludes generated files)
  const total = analysisFiles.length;

  for (let i = 0; i < analysisFiles.length; i++) {
    const file = analysisFiles[i];
    const filePath = file.file?.relativePath || file.file;

    // Report progress every 2 files and yield to event loop
    if (i % 2 === 0 || i === total - 1) {
      onProgress({ current: i + 1, total, file: filePath });
      await new Promise(resolve => setImmediate(resolve));
    }

    if (!isCodeFile(filePath)) continue;

    results.summary.filesAnalysed++;

    // Skip entry points (already added above)
    if (entryPointFiles.has(filePath)) {
      continue;
    }

    // Check if file is reachable from any entry point
    // This is the correct check - not "is it imported?" but "is it reachable?"
    if (reachableFiles.has(filePath)) {
      // File is reachable - it's live, skip dead file detection
      // (We could still check for unused exports within reachable files,
      // but that's a separate concern from dead FILE detection)
      continue;
    }

    // File is NOT reachable from any entry point - it's a dead file
    // Content was freed (A10) so re-read from disk for the small subset of dead files
    let content = file.content || '';
    if (!content && projectPath) {
      try { content = readFileSync(join(projectPath, filePath), 'utf-8'); } catch { /* skip */ }
    }
    if (!content) continue;

    // Developer-override: skip files with explicit "keep" comments in the first ~50 lines
    // Matches: DO NOT DELETE, DO NOT REMOVE, KEEP THIS FILE, @preserve
    const head = content.slice(0, 2000);
    if (/\b(DO\s+NOT\s+(DELETE|REMOVE)|KEEP\s+THIS\s+FILE|@preserve)\b/i.test(head)) {
      continue;
    }

    // A8: Skip git history when there are many dead files (>200) to avoid thousands of subprocess forks
    // Only fetch git history for the first 200 dead files (sorted by size later)
    const gitHistory = results.fullyDeadFiles.length < 200
      ? getFileGitHistory(filePath, projectPath)
      : { available: false, reason: 'Skipped for performance (>200 dead files)' };
    const sizeBytes = file.size || content.length;
    const cost = calculateDeadCodeCost(sizeBytes);
    const exports = parseExports(content, filePath);

    // Determine confidence based on available signals
    const dynamicRiskRe = /\b(plugin|middleware|handler|command|hook|loader|strategy|adapter|migration)s?\b/i;
    const hasDynamicRisk = dynamicRiskRe.test(filePath);
    const entryPointCount = results.entryPoints.length;
    const fullyDeadConfidence = 'safe-to-remove';

    // Extract source lines for each export
    const contentLines = content.split('\n');
    const exportsWithSource = exports.map(e => ({
      name: e.name,
      type: e.type,
      line: e.line,
      lineEnd: e.lineEnd,
      status: 'dead',
      sourceLine: e.line && contentLines[e.line - 1] ? contentLines[e.line - 1].trimEnd() : undefined
    }));

    results.fullyDeadFiles.push({
      file: filePath,
      relativePath: filePath,
      sizeBytes,
      sizeFormatted: formatBytes(sizeBytes),
      lineCount: contentLines.length,
      status: 'fully-dead',
      reason: 'not-reachable-from-entry-points',
      exports: exportsWithSource,
      gitHistory,
      costImpact: cost,
      summary: {
        totalExports: exports.length,
        deadExports: exports.length,
        liveExports: 0,
        deadBytes: sizeBytes,
        percentDead: 100,
        canDeleteFile: true
      },
      recommendation: {
        action: 'review-for-removal',
        confidence: fullyDeadConfidence,
        safeToRemove: exports.map(e => e.name),
        keep: [],
        verifyFirst: `grep -r "${basename(filePath).replace(/\.[^.]+$/, '')}" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.mjs" --include="*.vue" --include="*.html" --include="*.json" --include="*.yaml" --include="*.yml"`,
        reasoning: `File is not reachable from any detected entry point (${entryPointCount} entry points found). ` +
                   `Verify it's not loaded dynamically or referenced in config files before removing.`
      }
    });
    results.summary.totalDeadBytes += sizeBytes;
    results.summary.totalDeadExports += exports.length;
    results.summary.filesWithDeadCode++;
  }

  // Per-export dead export detection for reachable JS/TS/Python files
  const jstspyRegex = /\.([mc]?[jt]s|[jt]sx|py|pyi)$/;
  // Build a quick lookup from jsAnalysis for exports by file path
  const analysisByPath = new Map();
  for (const file of jsAnalysis) {
    const fp = file.file?.relativePath || file.file;
    analysisByPath.set(fp, file);
  }

  for (const file of analysisFiles) {
    const filePath = file.file?.relativePath || file.file;

    // Only JS/TS/Python (other languages don't have per-specifier imports yet)
    if (!jstspyRegex.test(filePath)) continue;
    // Skip unreachable files (already in fullyDeadFiles)
    if (!reachableFiles.has(filePath)) continue;
    // Skip entry points — their exports are the public API
    if (entryPointFiles.has(filePath)) continue;

    const fileExportsList = file.exports || [];
    // Skip files with no exports
    if (fileExportsList.length === 0) continue;

    // Get usage data for this file
    const usage = exportUsageMap.get(filePath);

    // If no usage data at all, the file was reached via a non-tracked path (e.g., Rust mod, glob)
    // Conservative: skip rather than report all as dead
    if (!usage) continue;

    // If file has __ALL__ or * usage, all exports are consumed
    if (usage.has('__ALL__') || usage.has('*')) continue;

    // Check each export
    const liveExports = [];
    const deadExports = [];
    const onlySideEffects = usage.size === 1 && usage.has('__SIDE_EFFECT__');

    // If only side-effect imports, skip — likely CSS/polyfill/setup file
    if (onlySideEffects) continue;

    for (const exp of fileExportsList) {
      // Skip re-exports (they're pass-throughs, not owned by this file)
      if (exp.sourceModule) continue;

      const exportName = exp.name || 'default';
      const importers = usage.get(exportName);

      if (importers && importers.length > 0) {
        liveExports.push({
          name: exportName,
          type: exp.type || 'unknown',
          line: exp.line || 0,
          lineEnd: exp.lineEnd,
          status: 'live',
          importedBy: importers.map(u => u.importerFile)
        });
      } else {
        deadExports.push({
          name: exportName,
          type: exp.type || 'unknown',
          line: exp.line || 0,
          lineEnd: exp.lineEnd,
          status: 'dead',
          importedBy: []
        });
      }
    }

    // Only report files with BOTH live and dead exports
    // If all exports appear dead, it's suspicious (likely FP — framework magic, reflection, etc.)
    if (deadExports.length === 0 || liveExports.length === 0) continue;

    // Read source lines for exports (content was freed at A10, re-read from disk)
    let fileLines = null;
    if (projectPath) {
      try {
        fileLines = readFileSync(join(projectPath, filePath), 'utf-8').split('\n');
      } catch { /* skip — file may have moved */ }
    }
    if (fileLines) {
      for (const exp of [...liveExports, ...deadExports]) {
        if (exp.line && fileLines[exp.line - 1]) {
          exp.sourceLine = fileLines[exp.line - 1].trimEnd();
        }
      }
    }

    const totalExports = liveExports.length + deadExports.length;
    const sizeBytes = file.size || 0;

    // Confidence: high when live exports have confirmed importers (proves tracking works for this file)
    const liveHaveImporters = liveExports.some(e => e.importedBy?.length > 0);
    const partialConfidence = 'safe-to-remove';

    results.partiallyDeadFiles.push({
      file: filePath,
      relativePath: filePath,
      sizeBytes,
      sizeFormatted: formatBytes(sizeBytes),
      lineCount: file.lineCount || file.lines || 0,
      status: 'partially-dead',
      exports: [...liveExports, ...deadExports],
      deadExports: deadExports.map(e => e.name),
      summary: {
        totalExports,
        deadExports: deadExports.length,
        liveExports: liveExports.length,
        percentDead: Math.round((deadExports.length / totalExports) * 100),
        canDeleteFile: false
      },
      recommendation: {
        action: 'remove-dead-exports',
        confidence: partialConfidence,
        safeToRemove: deadExports.map(e => e.name),
        keep: liveExports.map(e => e.name),
        reasoning: `File has ${deadExports.length} unused export(s) out of ${totalExports} total. ` +
                   `Live exports are imported by other files; dead exports have no detected importers.`,
        command: deadExports.map(e => `Remove \`${e.name}\` (line ${e.line})`).join('\n')
      }
    });
    results.summary.totalDeadExports += deadExports.length;
    results.summary.totalLiveExports += liveExports.length;
  }

  // Sort fully dead by impact (size)
  results.fullyDeadFiles.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
  // Sort partially dead by number of dead exports (most first)
  results.partiallyDeadFiles.sort((a, b) => (b.deadExports?.length || 0) - (a.deadExports?.length || 0));

  // Attach importer count map for file history (consumed by scanner/index.mjs, not serialised)
  results.importerCountMap = importerCountMap;

  return results;
}

/**
 * Calculate total dead code size (for backwards compatibility)
 */
export function calculateDeadCodeSize(deadCode, jsAnalysis) {
  return deadCode.summary?.totalDeadBytes || 0;
}

/**
 * Enrich a dead code file (for backwards compatibility)
 */
export function enrichDeadCodeFile(file, projectPath, jsAnalysis) {
  // Already enriched in findDeadCode
  return file;
}

export { findNestedPackageJsons };
export default { findDeadCode, calculateDeadCodeSize, enrichDeadCodeFile, findNestedPackageJsons };
