// src/scanner/analysers/buildSystems.mjs
// Enterprise build system detection for monorepos and multi-language projects

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { globSync } from 'glob';

/**
 * Detected build system info
 * @typedef {Object} BuildSystemInfo
 * @property {string} type - Build system type (gradle, maven, bazel, etc.)
 * @property {string} configFile - Path to config file
 * @property {string[]} packages - Detected package/module directories
 * @property {Object} metadata - Additional metadata
 */

/**
 * Detect all build systems in a project
 * @param {string} projectPath - Path to project root
 * @returns {BuildSystemInfo[]} - Array of detected build systems
 */
export function detectBuildSystems(projectPath) {
  if (!projectPath || !existsSync(projectPath)) return [];

  const systems = [];

  // JavaScript/TypeScript (already partially handled)
  systems.push(...detectTurborepo(projectPath));

  // JVM
  systems.push(...detectGradle(projectPath));
  systems.push(...detectMaven(projectPath));

  // Bazel/Buck/Pants
  systems.push(...detectBazel(projectPath));
  systems.push(...detectBuck(projectPath));
  systems.push(...detectPants(projectPath));

  // Go
  systems.push(...detectGoWorkspace(projectPath));

  // .NET
  systems.push(...detectDotNet(projectPath));

  // Rust
  systems.push(...detectCargo(projectPath));

  // Python
  systems.push(...detectPythonProject(projectPath));

  return systems;
}

/**
 * Get all package directories from detected build systems
 * @param {string} projectPath - Path to project root
 * @returns {string[]} - Array of package directory paths (relative)
 */
export function getPackageDirectories(projectPath) {
  const systems = detectBuildSystems(projectPath);
  const dirs = new Set();

  for (const system of systems) {
    for (const pkg of system.packages || []) {
      dirs.add(pkg);
    }
  }

  return [...dirs];
}

// ═══════════════════════════════════════════════════════════════════════════
// Turborepo
// ═══════════════════════════════════════════════════════════════════════════

function detectTurborepo(projectPath) {
  const turboPath = join(projectPath, 'turbo.json');
  if (!existsSync(turboPath)) return [];

  try {
    const content = readFileSync(turboPath, 'utf-8');
    const turbo = JSON.parse(content);

    // Turborepo uses package.json workspaces for packages
    // turbo.json defines the pipeline
    const pipelines = Object.keys(turbo.pipeline || turbo.tasks || {});

    return [{
      type: 'turborepo',
      configFile: 'turbo.json',
      packages: [],  // Packages come from package.json workspaces
      metadata: { pipelines }
    }];
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Gradle (Java/Kotlin)
// ═══════════════════════════════════════════════════════════════════════════

function detectGradle(projectPath) {
  const settingsFiles = ['settings.gradle', 'settings.gradle.kts'];
  const results = [];

  for (const settingsFile of settingsFiles) {
    const settingsPath = join(projectPath, settingsFile);
    if (!existsSync(settingsPath)) continue;

    try {
      const content = readFileSync(settingsPath, 'utf-8');
      const packages = [];

      // Parse include statements
      // include ':app', ':core', ':shared:utils'
      // include(":app", ":core")
      const includePatterns = [
        /include\s*\(\s*['"]([^'"]+)['"]/g,              // include(":app")
        /include\s+['"]([^'"]+)['"]/g,                    // include ':app'
        /include\s*\(\s*([^)]+)\)/g,                      // include(":app", ":core")
      ];

      for (const pattern of includePatterns) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
          const modules = match[1].split(/[,\s]+/).map(m =>
            m.replace(/['"]/g, '').replace(/^:/, '').replace(/:/g, '/')
          ).filter(m => m);
          packages.push(...modules);
        }
      }

      // Parse includeFlat
      const flatPattern = /includeFlat\s+['"]([^'"]+)['"]/g;
      let match;
      while ((match = flatPattern.exec(content)) !== null) {
        packages.push(`../${match[1]}`);
      }

      results.push({
        type: 'gradle',
        configFile: settingsFile,
        packages: [...new Set(packages)],
        metadata: { isKotlinDsl: settingsFile.endsWith('.kts') }
      });
    } catch {
      // Ignore parse errors
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// Maven (Java)
// ═══════════════════════════════════════════════════════════════════════════

function detectMaven(projectPath) {
  const pomPath = join(projectPath, 'pom.xml');
  if (!existsSync(pomPath)) return [];

  try {
    const content = readFileSync(pomPath, 'utf-8');
    const packages = [];

    // Parse <modules> section
    // <modules>
    //   <module>core</module>
    //   <module>api</module>
    // </modules>
    const modulesMatch = content.match(/<modules>([\s\S]*?)<\/modules>/);
    if (modulesMatch) {
      const modulePattern = /<module>([^<]+)<\/module>/g;
      let match;
      while ((match = modulePattern.exec(modulesMatch[1])) !== null) {
        packages.push(match[1].trim());
      }
    }

    // Recursively check for submodule pom.xml files
    for (const pkg of [...packages]) {
      const subPomPath = join(projectPath, pkg, 'pom.xml');
      if (existsSync(subPomPath)) {
        try {
          const subContent = readFileSync(subPomPath, 'utf-8');
          const subModulesMatch = subContent.match(/<modules>([\s\S]*?)<\/modules>/);
          if (subModulesMatch) {
            const modulePattern = /<module>([^<]+)<\/module>/g;
            let match;
            while ((match = modulePattern.exec(subModulesMatch[1])) !== null) {
              packages.push(`${pkg}/${match[1].trim()}`);
            }
          }
        } catch {
          // Ignore
        }
      }
    }

    // Extract artifactId for metadata
    const artifactIdMatch = content.match(/<artifactId>([^<]+)<\/artifactId>/);
    const groupIdMatch = content.match(/<groupId>([^<]+)<\/groupId>/);

    return [{
      type: 'maven',
      configFile: 'pom.xml',
      packages: [...new Set(packages)],
      metadata: {
        artifactId: artifactIdMatch?.[1],
        groupId: groupIdMatch?.[1]
      }
    }];
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Bazel
// ═══════════════════════════════════════════════════════════════════════════

function detectBazel(projectPath) {
  const workspaceFiles = ['WORKSPACE', 'WORKSPACE.bazel', 'MODULE.bazel'];
  let foundConfig = null;

  for (const wsFile of workspaceFiles) {
    const wsPath = join(projectPath, wsFile);
    if (existsSync(wsPath)) {
      foundConfig = wsFile;
      break;
    }
  }

  if (!foundConfig) return [];

  // Find all BUILD files to identify packages
  const packages = [];
  try {
    const buildFiles = globSync('**/BUILD{,.bazel}', {
      cwd: projectPath,
      ignore: ['bazel-*/**', 'node_modules/**', '.git/**']
    });

    for (const buildFile of buildFiles) {
      const dir = dirname(buildFile);
      if (dir !== '.') {
        packages.push(dir);
      }
    }
  } catch {
    // Ignore glob errors
  }

  return [{
    type: 'bazel',
    configFile: foundConfig,
    packages,
    metadata: { isBzlmod: foundConfig === 'MODULE.bazel' }
  }];
}

// ═══════════════════════════════════════════════════════════════════════════
// Buck/Buck2 (Meta)
// ═══════════════════════════════════════════════════════════════════════════

function detectBuck(projectPath) {
  const buckConfigs = ['.buckconfig'];
  let foundConfig = null;

  for (const cfg of buckConfigs) {
    if (existsSync(join(projectPath, cfg))) {
      foundConfig = cfg;
      break;
    }
  }

  if (!foundConfig) return [];

  // Find all BUCK files
  const packages = [];
  try {
    const buckFiles = globSync('**/BUCK{,.v2}', {
      cwd: projectPath,
      ignore: ['buck-out/**', 'node_modules/**', '.git/**']
    });

    for (const buckFile of buckFiles) {
      const dir = dirname(buckFile);
      if (dir !== '.') {
        packages.push(dir);
      }
    }
  } catch {
    // Ignore glob errors
  }

  return [{
    type: 'buck',
    configFile: foundConfig,
    packages,
    metadata: {}
  }];
}

// ═══════════════════════════════════════════════════════════════════════════
// Pants
// ═══════════════════════════════════════════════════════════════════════════

function detectPants(projectPath) {
  const pantsPath = join(projectPath, 'pants.toml');
  if (!existsSync(pantsPath)) return [];

  const packages = [];

  try {
    const content = readFileSync(pantsPath, 'utf-8');

    // Parse source_roots from pants.toml
    // [source]
    // root_patterns = ["src/*", "tests/*"]
    const rootPatternsMatch = content.match(/root_patterns\s*=\s*\[(.*?)\]/s);
    if (rootPatternsMatch) {
      const patterns = rootPatternsMatch[1].match(/["']([^"']+)["']/g);
      if (patterns) {
        for (const p of patterns) {
          const pattern = p.replace(/["']/g, '');
          const baseDir = pattern.replace(/\/?\*.*$/, '');
          if (baseDir && existsSync(join(projectPath, baseDir))) {
            try {
              const entries = readdirSync(join(projectPath, baseDir), { withFileTypes: true });
              for (const entry of entries) {
                if (entry.isDirectory()) {
                  packages.push(`${baseDir}/${entry.name}`);
                }
              }
            } catch {
              // Ignore
            }
          }
        }
      }
    }
  } catch {
    // Ignore parse errors
  }

  // Also find BUILD files (Pants uses same format as Bazel)
  try {
    const buildFiles = globSync('**/BUILD', {
      cwd: projectPath,
      ignore: ['dist/**', 'node_modules/**', '.git/**', '.pants.d/**']
    });

    for (const buildFile of buildFiles) {
      const dir = dirname(buildFile);
      if (dir !== '.' && !packages.includes(dir)) {
        packages.push(dir);
      }
    }
  } catch {
    // Ignore glob errors
  }

  return [{
    type: 'pants',
    configFile: 'pants.toml',
    packages: [...new Set(packages)],
    metadata: {}
  }];
}

// ═══════════════════════════════════════════════════════════════════════════
// Go Workspaces
// ═══════════════════════════════════════════════════════════════════════════

function detectGoWorkspace(projectPath) {
  const goWorkPath = join(projectPath, 'go.work');
  if (!existsSync(goWorkPath)) return [];

  try {
    const content = readFileSync(goWorkPath, 'utf-8');
    const packages = [];

    // Parse use directives
    // use (
    //     ./cmd/server
    //     ./pkg/utils
    // )
    // or: use ./cmd/server
    const useBlockMatch = content.match(/use\s*\(([\s\S]*?)\)/);
    if (useBlockMatch) {
      const lines = useBlockMatch[1].split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('//')) {
          packages.push(trimmed.replace(/^\.\//, ''));
        }
      }
    }

    // Single use directive
    const singleUsePattern = /^use\s+(\S+)/gm;
    let match;
    while ((match = singleUsePattern.exec(content)) !== null) {
      if (!match[1].startsWith('(')) {
        packages.push(match[1].replace(/^\.\//, ''));
      }
    }

    return [{
      type: 'go-workspace',
      configFile: 'go.work',
      packages: [...new Set(packages)],
      metadata: {}
    }];
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// .NET Solutions
// ═══════════════════════════════════════════════════════════════════════════

function detectDotNet(projectPath) {
  const results = [];

  try {
    // Find .sln files
    const slnFiles = globSync('*.sln', { cwd: projectPath });

    for (const slnFile of slnFiles) {
      const slnPath = join(projectPath, slnFile);
      const content = readFileSync(slnPath, 'utf-8');
      const packages = [];

      // Parse Project lines
      // Project("{GUID}") = "ProjectName", "path\to\project.csproj", "{GUID}"
      const projectPattern = /Project\("[^"]+"\)\s*=\s*"([^"]+)",\s*"([^"]+)",\s*"[^"]+"/g;
      let match;
      while ((match = projectPattern.exec(content)) !== null) {
        const projectPath = match[2].replace(/\\/g, '/');
        // Get directory containing the .csproj
        const projectDir = dirname(projectPath);
        if (projectDir && projectDir !== '.') {
          packages.push(projectDir);
        }
      }

      results.push({
        type: 'dotnet-solution',
        configFile: slnFile,
        packages: [...new Set(packages)],
        metadata: {}
      });
    }
  } catch {
    // Ignore errors
  }

  // Also detect Directory.Build.props for SDK-style projects
  if (existsSync(join(projectPath, 'Directory.Build.props'))) {
    // Find all .csproj files
    try {
      const csprojFiles = globSync('**/*.csproj', {
        cwd: projectPath,
        ignore: ['**/bin/**', '**/obj/**', 'node_modules/**']
      });

      const packages = csprojFiles.map(f => dirname(f)).filter(d => d !== '.');

      if (packages.length > 0 && !results.some(r => r.type === 'dotnet-solution')) {
        results.push({
          type: 'dotnet-sdk',
          configFile: 'Directory.Build.props',
          packages: [...new Set(packages)],
          metadata: {}
        });
      }
    } catch {
      // Ignore
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// Cargo Workspaces (Rust)
// ═══════════════════════════════════════════════════════════════════════════

function detectCargo(projectPath) {
  const cargoPath = join(projectPath, 'Cargo.toml');
  if (!existsSync(cargoPath)) return [];

  try {
    const content = readFileSync(cargoPath, 'utf-8');
    const packages = [];

    // Check for [workspace] section
    if (!content.includes('[workspace]')) {
      // Single crate, not a workspace
      return [{
        type: 'cargo-single',
        configFile: 'Cargo.toml',
        packages: [],
        metadata: {}
      }];
    }

    // Parse members
    // [workspace]
    // members = ["crates/*", "tools/cli"]
    const membersMatch = content.match(/members\s*=\s*\[([\s\S]*?)\]/);
    if (membersMatch) {
      const memberStrings = membersMatch[1].match(/["']([^"']+)["']/g);
      if (memberStrings) {
        for (const memberStr of memberStrings) {
          const member = memberStr.replace(/["']/g, '');
          if (member.includes('*')) {
            // Glob pattern - expand it
            const baseDir = member.replace(/\/?\*.*$/, '');
            if (existsSync(join(projectPath, baseDir))) {
              try {
                const entries = readdirSync(join(projectPath, baseDir), { withFileTypes: true });
                for (const entry of entries) {
                  if (entry.isDirectory() && existsSync(join(projectPath, baseDir, entry.name, 'Cargo.toml'))) {
                    packages.push(`${baseDir}/${entry.name}`);
                  }
                }
              } catch {
                // Ignore
              }
            }
          } else {
            packages.push(member);
          }
        }
      }
    }

    // Parse exclude (these should NOT be packages)
    const excludeMatch = content.match(/exclude\s*=\s*\[([\s\S]*?)\]/);
    const excludes = new Set();
    if (excludeMatch) {
      const excludeStrings = excludeMatch[1].match(/["']([^"']+)["']/g);
      if (excludeStrings) {
        for (const excStr of excludeStrings) {
          excludes.add(excStr.replace(/["']/g, ''));
        }
      }
    }

    return [{
      type: 'cargo-workspace',
      configFile: 'Cargo.toml',
      packages: packages.filter(p => !excludes.has(p)),
      metadata: { excludes: [...excludes] }
    }];
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Python Projects
// ═══════════════════════════════════════════════════════════════════════════

function detectPythonProject(projectPath) {
  const results = [];

  // Check pyproject.toml (PEP 518)
  const pyprojectPath = join(projectPath, 'pyproject.toml');
  if (existsSync(pyprojectPath)) {
    try {
      const content = readFileSync(pyprojectPath, 'utf-8');
      const packages = [];

      // Check for Poetry workspaces (experimental)
      // [tool.poetry.packages]
      // or src layout detection
      if (existsSync(join(projectPath, 'src'))) {
        try {
          const srcEntries = readdirSync(join(projectPath, 'src'), { withFileTypes: true });
          for (const entry of srcEntries) {
            if (entry.isDirectory() && !entry.name.startsWith('_')) {
              packages.push(`src/${entry.name}`);
            }
          }
        } catch {
          // Ignore
        }
      }

      // Check for package names in [tool.poetry] or [project]
      const nameMatch = content.match(/name\s*=\s*["']([^"']+)["']/);

      results.push({
        type: 'python-pyproject',
        configFile: 'pyproject.toml',
        packages,
        metadata: { name: nameMatch?.[1] }
      });
    } catch {
      // Ignore
    }
  }

  // Check setup.py
  const setupPyPath = join(projectPath, 'setup.py');
  if (existsSync(setupPyPath)) {
    results.push({
      type: 'python-setup',
      configFile: 'setup.py',
      packages: existsSync(join(projectPath, 'src')) ? ['src'] : [],
      metadata: {}
    });
  }

  return results;
}

/**
 * Merge packages from all build systems into the monorepo detection
 * This is called from deadcode.mjs extractPathAliases
 * @param {string} projectPath - Path to project root
 * @returns {Array<{dir: string, prefix: string}>} - Config dirs for alias extraction
 */
export function getConfigDirsFromBuildSystems(projectPath) {
  const systems = detectBuildSystems(projectPath);
  const configDirs = [];

  for (const system of systems) {
    for (const pkg of system.packages || []) {
      configDirs.push({ dir: pkg, prefix: `${pkg}/` });
    }
  }

  return configDirs;
}

export default {
  detectBuildSystems,
  getPackageDirectories,
  getConfigDirsFromBuildSystems
};
