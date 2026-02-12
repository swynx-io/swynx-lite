// src/scanner/analysers/configParsers.mjs
// CI/CD and Bundler configuration parsers for entry point detection

import { readFileSync, existsSync } from 'fs';
import { join, dirname, basename, relative } from 'path';
import { globSync } from 'glob';

/**
 * Parse Webpack configuration for entry points
 * @param {string} projectPath - Project root path
 * @returns {Object} - { entries: string[], mode: string }
 */
export function parseWebpackConfig(projectPath) {
  const configFiles = [
    'webpack.config.js',
    'webpack.config.mjs',
    'webpack.config.ts',
    'webpack.config.cjs',
    'webpack.dev.js',
    'webpack.prod.js',
    'webpack.common.js'
  ];

  const entries = [];
  let mode = 'unknown';

  for (const configFile of configFiles) {
    const configPath = join(projectPath, configFile);
    if (!existsSync(configPath)) continue;

    try {
      const content = readFileSync(configPath, 'utf-8');

      // Extract entry points
      // Pattern: entry: './src/index.js' or entry: { main: './src/index.js' }
      const singleEntryMatch = content.match(/entry\s*:\s*['"]([^'"]+)['"]/);
      if (singleEntryMatch) {
        entries.push(singleEntryMatch[1]);
      }

      // Object entries: entry: { name: 'path' }
      const objectEntryMatch = content.match(/entry\s*:\s*\{([^}]+)\}/s);
      if (objectEntryMatch) {
        const entryBlock = objectEntryMatch[1];
        const pathMatches = entryBlock.matchAll(/['"]([^'"]+\.(?:js|ts|jsx|tsx|mjs))['"]/g);
        for (const match of pathMatches) {
          entries.push(match[1]);
        }
      }

      // Array entries: entry: ['./src/a.js', './src/b.js']
      const arrayEntryMatch = content.match(/entry\s*:\s*\[([^\]]+)\]/s);
      if (arrayEntryMatch) {
        const arrayBlock = arrayEntryMatch[1];
        const pathMatches = arrayBlock.matchAll(/['"]([^'"]+)['"]/g);
        for (const match of pathMatches) {
          entries.push(match[1]);
        }
      }

      // Detect mode
      if (content.includes("mode: 'production'") || content.includes('mode: "production"')) {
        mode = 'production';
      } else if (content.includes("mode: 'development'") || content.includes('mode: "development"')) {
        mode = 'development';
      }
    } catch {
      // Ignore parse errors
    }
  }

  return { entries: [...new Set(entries)], mode };
}

/**
 * Parse Vite configuration for entry points
 * @param {string} projectPath - Project root path
 * @returns {Object} - { entries: string[], framework: string|null }
 */
export function parseViteConfig(projectPath) {
  const configFiles = [
    'vite.config.js',
    'vite.config.ts',
    'vite.config.mjs'
  ];

  const entries = [];
  let framework = null;

  for (const configFile of configFiles) {
    const configPath = join(projectPath, configFile);
    if (!existsSync(configPath)) continue;

    try {
      const content = readFileSync(configPath, 'utf-8');

      // Default entry is index.html, but check for custom entries
      // build.rollupOptions.input
      const inputMatch = content.match(/input\s*:\s*['"]([^'"]+)['"]/);
      if (inputMatch) {
        entries.push(inputMatch[1]);
      }

      // Object input: { main: 'src/main.ts' }
      const objectInputMatch = content.match(/input\s*:\s*\{([^}]+)\}/s);
      if (objectInputMatch) {
        const inputBlock = objectInputMatch[1];
        const pathMatches = inputBlock.matchAll(/['"]([^'"]+\.(?:html|js|ts|jsx|tsx))['"]/g);
        for (const match of pathMatches) {
          entries.push(match[1]);
        }
      }

      // Detect framework
      if (content.includes('@vitejs/plugin-react') || content.includes('vite-plugin-react')) {
        framework = 'react';
      } else if (content.includes('@vitejs/plugin-vue')) {
        framework = 'vue';
      } else if (content.includes('@sveltejs/vite-plugin-svelte')) {
        framework = 'svelte';
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Check for index.html as default entry
  if (entries.length === 0 && existsSync(join(projectPath, 'index.html'))) {
    entries.push('index.html');
  }

  return { entries: [...new Set(entries)], framework };
}

/**
 * Parse Rollup configuration for entry points
 * @param {string} projectPath - Project root path
 * @returns {Object} - { entries: string[], outputFormats: string[] }
 */
export function parseRollupConfig(projectPath) {
  const configFiles = [
    'rollup.config.js',
    'rollup.config.mjs',
    'rollup.config.ts'
  ];

  const entries = [];
  const outputFormats = [];

  for (const configFile of configFiles) {
    const configPath = join(projectPath, configFile);
    if (!existsSync(configPath)) continue;

    try {
      const content = readFileSync(configPath, 'utf-8');

      // Input: 'src/index.js' or input: ['src/a.js', 'src/b.js']
      const singleInputMatch = content.match(/input\s*:\s*['"]([^'"]+)['"]/);
      if (singleInputMatch) {
        entries.push(singleInputMatch[1]);
      }

      const arrayInputMatch = content.match(/input\s*:\s*\[([^\]]+)\]/s);
      if (arrayInputMatch) {
        const arrayBlock = arrayInputMatch[1];
        const pathMatches = arrayBlock.matchAll(/['"]([^'"]+)['"]/g);
        for (const match of pathMatches) {
          entries.push(match[1]);
        }
      }

      // Detect output formats
      const formatMatches = content.matchAll(/format\s*:\s*['"](\w+)['"]/g);
      for (const match of formatMatches) {
        outputFormats.push(match[1]);
      }
    } catch {
      // Ignore parse errors
    }
  }

  return { entries: [...new Set(entries)], outputFormats: [...new Set(outputFormats)] };
}

/**
 * Parse esbuild configuration for entry points
 * @param {string} projectPath - Project root path
 * @returns {Object} - { entries: string[] }
 */
export function parseEsbuildConfig(projectPath) {
  const configFiles = [
    'esbuild.config.js',
    'esbuild.config.mjs',
    'esbuild.mjs',
    'build.mjs'
  ];

  const entries = [];

  for (const configFile of configFiles) {
    const configPath = join(projectPath, configFile);
    if (!existsSync(configPath)) continue;

    try {
      const content = readFileSync(configPath, 'utf-8');

      // entryPoints: ['src/index.ts']
      const entryPointsMatch = content.match(/entryPoints\s*:\s*\[([^\]]+)\]/s);
      if (entryPointsMatch) {
        const arrayBlock = entryPointsMatch[1];
        const pathMatches = arrayBlock.matchAll(/['"]([^'"]+)['"]/g);
        for (const match of pathMatches) {
          entries.push(match[1]);
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  return { entries: [...new Set(entries)] };
}

/**
 * Parse Parcel configuration (uses package.json source/main)
 * @param {string} projectPath - Project root path
 * @returns {Object} - { entries: string[] }
 */
export function parseParcelConfig(projectPath) {
  const entries = [];

  const pkgPath = join(projectPath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

      // Parcel uses 'source' field
      if (pkg.source) {
        if (Array.isArray(pkg.source)) {
          entries.push(...pkg.source);
        } else {
          entries.push(pkg.source);
        }
      }

      // Also check for targets in .parcelrc
      const parcelrcPath = join(projectPath, '.parcelrc');
      if (existsSync(parcelrcPath)) {
        const parcelrc = JSON.parse(readFileSync(parcelrcPath, 'utf-8'));
        // Extract entries from targets if defined
      }
    } catch {
      // Ignore parse errors
    }
  }

  return { entries: [...new Set(entries)] };
}

/**
 * Parse GitHub Actions workflow for script references
 * @param {string} projectPath - Project root path
 * @returns {Object} - { scripts: string[], testCommands: string[] }
 */
export function parseGitHubActions(projectPath) {
  const workflowDir = join(projectPath, '.github', 'workflows');
  if (!existsSync(workflowDir)) {
    return { scripts: [], testCommands: [] };
  }

  const scripts = [];
  const testCommands = [];

  try {
    const workflowFiles = globSync('*.{yml,yaml}', { cwd: workflowDir });

    for (const file of workflowFiles) {
      const content = readFileSync(join(workflowDir, file), 'utf-8');

      // Extract run commands
      const runMatches = content.matchAll(/run\s*:\s*(?:\|-)?\s*\n?\s*(.+)/g);
      for (const match of runMatches) {
        const command = match[1].trim();

        // Look for script executions
        const scriptMatch = command.match(/(?:node|npx|ts-node|tsx)\s+([^\s|&;]+)/);
        if (scriptMatch) {
          scripts.push(scriptMatch[1]);
        }

        // Look for test commands
        if (command.includes('test') || command.includes('jest') || command.includes('vitest') ||
            command.includes('mocha') || command.includes('cypress') || command.includes('playwright')) {
          testCommands.push(command);
        }
      }

      // Extract npm/yarn script references
      const npmRunMatches = content.matchAll(/(?:npm|yarn|pnpm)\s+(?:run\s+)?(\w+)/g);
      for (const match of npmRunMatches) {
        scripts.push(`npm:${match[1]}`);
      }
    }
  } catch {
    // Ignore errors
  }

  return { scripts: [...new Set(scripts)], testCommands: [...new Set(testCommands)] };
}

/**
 * Parse GitLab CI configuration
 * @param {string} projectPath - Project root path
 * @returns {Object} - { scripts: string[], stages: string[] }
 */
export function parseGitLabCI(projectPath) {
  const ciPath = join(projectPath, '.gitlab-ci.yml');
  if (!existsSync(ciPath)) {
    return { scripts: [], stages: [] };
  }

  const scripts = [];
  const stages = [];

  try {
    const content = readFileSync(ciPath, 'utf-8');

    // Extract stages
    const stagesMatch = content.match(/stages:\s*\n((?:\s+-\s+\w+\n?)*)/);
    if (stagesMatch) {
      const stageLines = stagesMatch[1].split('\n');
      for (const line of stageLines) {
        const match = line.match(/^\s*-\s+(\w+)/);
        if (match) stages.push(match[1]);
      }
    }

    // Extract script commands
    const scriptMatches = content.matchAll(/script:\s*\n?((?:\s+-\s+.+\n?)*)/g);
    for (const match of scriptMatches) {
      const scriptLines = match[1].split('\n');
      for (const line of scriptLines) {
        const cmdMatch = line.match(/^\s*-\s+(.+)/);
        if (cmdMatch) {
          const command = cmdMatch[1].trim();
          const scriptMatch = command.match(/(?:node|npx|ts-node|tsx)\s+([^\s|&;]+)/);
          if (scriptMatch) {
            scripts.push(scriptMatch[1]);
          }
        }
      }
    }
  } catch {
    // Ignore errors
  }

  return { scripts: [...new Set(scripts)], stages: [...new Set(stages)] };
}

/**
 * Parse Jenkins configuration (Jenkinsfile)
 * @param {string} projectPath - Project root path
 * @returns {Object} - { scripts: string[], stages: string[] }
 */
export function parseJenkinsfile(projectPath) {
  const jenkinsfiles = ['Jenkinsfile', 'jenkinsfile', 'Jenkinsfile.groovy'];
  const scripts = [];
  const stages = [];

  for (const jenkinsfile of jenkinsfiles) {
    const filePath = join(projectPath, jenkinsfile);
    if (!existsSync(filePath)) continue;

    try {
      const content = readFileSync(filePath, 'utf-8');

      // Extract stage names
      const stageMatches = content.matchAll(/stage\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
      for (const match of stageMatches) {
        stages.push(match[1]);
      }

      // Extract sh commands
      const shMatches = content.matchAll(/sh\s+['"]([^'"]+)['"]/g);
      for (const match of shMatches) {
        const command = match[1];
        const scriptMatch = command.match(/(?:node|npx|ts-node|tsx)\s+([^\s|&;]+)/);
        if (scriptMatch) {
          scripts.push(scriptMatch[1]);
        }
      }
    } catch {
      // Ignore errors
    }
  }

  return { scripts: [...new Set(scripts)], stages: [...new Set(stages)] };
}

/**
 * Parse Docker configuration for entry points
 * @param {string} projectPath - Project root path
 * @returns {Object} - { entrypoints: string[], cmdScripts: string[] }
 */
export function parseDockerConfig(projectPath) {
  const dockerfiles = ['Dockerfile', 'dockerfile', 'Dockerfile.dev', 'Dockerfile.prod'];
  const entrypoints = [];
  const cmdScripts = [];

  for (const dockerfile of dockerfiles) {
    const filePath = join(projectPath, dockerfile);
    if (!existsSync(filePath)) continue;

    try {
      const content = readFileSync(filePath, 'utf-8');

      // Extract ENTRYPOINT
      const entrypointMatches = content.matchAll(/ENTRYPOINT\s+\[([^\]]+)\]/g);
      for (const match of entrypointMatches) {
        const parts = match[1].match(/['"]([^'"]+)['"]/g);
        if (parts) {
          const script = parts.find(p => p.includes('.js') || p.includes('.ts') || p.includes('.mjs'));
          if (script) entrypoints.push(script.replace(/['"]/g, ''));
        }
      }

      // Extract CMD
      const cmdMatches = content.matchAll(/CMD\s+\[([^\]]+)\]/g);
      for (const match of cmdMatches) {
        const parts = match[1].match(/['"]([^'"]+)['"]/g);
        if (parts) {
          const script = parts.find(p => p.includes('.js') || p.includes('.ts') || p.includes('.mjs'));
          if (script) cmdScripts.push(script.replace(/['"]/g, ''));
        }
      }

      // Shell form: CMD node app.js
      const shellCmdMatch = content.match(/CMD\s+(?:node|npm|yarn|npx)\s+([^\s\n]+)/);
      if (shellCmdMatch) {
        cmdScripts.push(shellCmdMatch[1]);
      }
    } catch {
      // Ignore errors
    }
  }

  // Check docker-compose.yml
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  for (const composeFile of composeFiles) {
    const filePath = join(projectPath, composeFile);
    if (!existsSync(filePath)) continue;

    try {
      const content = readFileSync(filePath, 'utf-8');

      // Extract command from services
      const commandMatches = content.matchAll(/command:\s*(?:\[([^\]]+)\]|(.+))/g);
      for (const match of commandMatches) {
        const cmdBlock = match[1] || match[2];
        const scriptMatch = cmdBlock?.match(/(?:node|npm|yarn|npx)\s+([^\s|&;'"]+)/);
        if (scriptMatch) {
          cmdScripts.push(scriptMatch[1]);
        }
      }
    } catch {
      // Ignore errors
    }
  }

  return {
    entrypoints: [...new Set(entrypoints)],
    cmdScripts: [...new Set(cmdScripts)]
  };
}

/**
 * Parse Webpack Module Federation exposes configuration
 * Searches root and common subdirectories for monorepo-style projects
 * @param {string} projectPath - Project root path
 * @returns {Object} - { exposes: string[], remotes: string[] }
 */
export function parseModuleFederationConfig(projectPath) {
  const configFileNames = [
    'webpack.config.js',
    'webpack.config.mjs',
    'webpack.config.ts',
    'webpack.dev.js',
    'webpack.prod.js'
  ];

  const exposes = [];
  const remotes = [];

  // Search in root and subdirectories
  const searchDirs = [''];

  // Find potential app directories
  try {
    const entries = globSync('*/', { cwd: projectPath, ignore: ['node_modules/'] });
    for (const entry of entries) {
      const entryPath = entry.replace(/\/$/, '');
      // Check if this directory has a webpack config
      for (const configName of configFileNames) {
        if (existsSync(join(projectPath, entryPath, configName))) {
          searchDirs.push(entryPath);
          break;
        }
      }
    }
  } catch {
    // Ignore glob errors
  }

  for (const searchDir of searchDirs) {
    const basePath = searchDir ? join(projectPath, searchDir) : projectPath;
    const relativePrefix = searchDir ? searchDir + '/' : '';

    for (const configFile of configFileNames) {
      const configPath = join(basePath, configFile);
      if (!existsSync(configPath)) continue;

      try {
        const content = readFileSync(configPath, 'utf-8');

        // Check for ModuleFederationPlugin
        if (!content.includes('ModuleFederationPlugin')) continue;

        // Extract entry point (add as entry)
        const entryMatch = content.match(/entry\s*:\s*['"]([^'"]+)['"]/);
        if (entryMatch) {
          exposes.push(relativePrefix + entryMatch[1].replace(/^\.\//, ''));
        }

        // Extract exposes paths
        // exposes: { './Button': './src/components/Button' }
        const exposesMatch = content.match(/exposes\s*:\s*\{([^}]+)\}/s);
        if (exposesMatch) {
          const exposesBlock = exposesMatch[1];
          // Match: './key': './src/path' or './key': 'src/path'
          const pathMatches = exposesBlock.matchAll(/['"][^'"]+['"]\s*:\s*['"]\.?\/?(src\/[^'"]+|[^'"\/][^'"]+)['"]/g);
          for (const match of pathMatches) {
            const exposePath = match[1].replace(/^\.\//, '');
            // Add with the relative prefix for monorepo support
            exposes.push(relativePrefix + exposePath);
            // Also add common extensions
            exposes.push(relativePrefix + exposePath + '.js');
            exposes.push(relativePrefix + exposePath + '.jsx');
            exposes.push(relativePrefix + exposePath + '.ts');
            exposes.push(relativePrefix + exposePath + '.tsx');
          }
        }

        // Extract remotes for reference
        const remotesMatch = content.match(/remotes\s*:\s*\{([^}]+)\}/s);
        if (remotesMatch) {
          const remotesBlock = remotesMatch[1];
          const nameMatches = remotesBlock.matchAll(/['"](\w+)['"]\s*:/g);
          for (const match of nameMatches) {
            remotes.push(match[1]);
          }
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  return { exposes: [...new Set(exposes)], remotes: [...new Set(remotes)] };
}

/**
 * Parse Serverless Framework configuration for handler entry points
 * @param {string} projectPath - Project root path
 * @returns {Object} - { handlers: string[] }
 */
export function parseServerlessConfig(projectPath) {
  const configFiles = [
    'serverless.yml',
    'serverless.yaml',
    'serverless.ts',
    'serverless.js'
  ];

  const handlers = [];

  for (const configFile of configFiles) {
    const configPath = join(projectPath, configFile);
    if (!existsSync(configPath)) continue;

    try {
      const content = readFileSync(configPath, 'utf-8');

      // Match handler patterns like: handler: src/handlers/hello.handler
      const handlerMatches = content.matchAll(/handler\s*:\s*['"]?([^\s'"#\n]+)['"]?/g);
      for (const match of handlerMatches) {
        const handlerPath = match[1].trim();
        // Handler format: path/to/file.functionName - extract file path
        const filePath = handlerPath.replace(/\.[^.]+$/, ''); // Remove .handler suffix
        // Add common extensions
        handlers.push(filePath + '.js');
        handlers.push(filePath + '.ts');
        handlers.push(filePath + '.mjs');
      }
    } catch {
      // Ignore parse errors
    }
  }

  return { handlers: [...new Set(handlers)] };
}

/**
 * Parse Next.js configuration and detect page/app router entry points
 * @param {string} projectPath - Project root path
 * @returns {Object} - { pages: string[], appRoutes: string[], apiRoutes: string[] }
 */
export function parseNextjsConfig(projectPath) {
  const pages = [];
  const appRoutes = [];
  const apiRoutes = [];

  // Check for Next.js indicators
  const nextConfigFiles = ['next.config.js', 'next.config.mjs', 'next.config.ts'];
  let isNextProject = false;
  for (const configFile of nextConfigFiles) {
    if (existsSync(join(projectPath, configFile))) {
      isNextProject = true;
      break;
    }
  }

  // Also check package.json for next dependency
  const pkgPath = join(projectPath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.dependencies?.next || pkg.devDependencies?.next) {
        isNextProject = true;
      }
    } catch {}
  }

  if (!isNextProject) return { pages, appRoutes, apiRoutes };

  // Scan for pages directory (Pages Router)
  const pagesDirs = ['pages', 'src/pages'];
  for (const pagesDir of pagesDirs) {
    const fullDir = join(projectPath, pagesDir);
    if (existsSync(fullDir)) {
      try {
        const pageFiles = globSync('**/*.{js,jsx,ts,tsx}', { cwd: fullDir, nodir: true });
        for (const file of pageFiles) {
          if (file.startsWith('api/')) {
            apiRoutes.push(join(pagesDir, file));
          } else {
            pages.push(join(pagesDir, file));
          }
        }
      } catch {}
    }
  }

  // Scan for app directory (App Router)
  const appDirs = ['app', 'src/app'];
  for (const appDir of appDirs) {
    const fullDir = join(projectPath, appDir);
    if (existsSync(fullDir)) {
      try {
        // App router files: page.tsx, layout.tsx, route.ts, loading.tsx, error.tsx, etc.
        const appFiles = globSync('**/{page,layout,route,loading,error,not-found,template}.{js,jsx,ts,tsx}', { cwd: fullDir, nodir: true });
        for (const file of appFiles) {
          if (file.includes('/api/') || file.startsWith('api/')) {
            apiRoutes.push(join(appDir, file));
          } else {
            appRoutes.push(join(appDir, file));
          }
        }
      } catch {}
    }
  }

  return { pages, appRoutes, apiRoutes };
}

/**
 * Parse Cypress configuration for spec and support files
 * @param {string} projectPath - Project root path
 * @returns {Object} - { specFiles: string[], supportFiles: string[] }
 */
export function parseCypressConfig(projectPath) {
  const configFiles = [
    'cypress.config.js',
    'cypress.config.ts',
    'cypress.config.mjs',
    'cypress.json' // Legacy config
  ];

  const specFiles = [];
  const supportFiles = [];

  for (const configFile of configFiles) {
    const configPath = join(projectPath, configFile);
    if (!existsSync(configPath)) continue;

    try {
      const content = readFileSync(configPath, 'utf-8');

      // Extract specPattern
      const specPatternMatch = content.match(/specPattern\s*:\s*['"]([^'"]+)['"]/);
      if (specPatternMatch) {
        const pattern = specPatternMatch[1];
        // Resolve glob pattern to actual files
        try {
          const files = globSync(pattern, { cwd: projectPath, nodir: true });
          specFiles.push(...files);
        } catch {}
      }

      // Extract supportFile
      const supportFileMatch = content.match(/supportFile\s*:\s*['"]([^'"]+)['"]/);
      if (supportFileMatch) {
        supportFiles.push(supportFileMatch[1]);
      }

      // Legacy cypress.json format
      if (configFile === 'cypress.json') {
        try {
          const config = JSON.parse(content);
          if (config.integrationFolder || config.testFiles) {
            const folder = config.integrationFolder || 'cypress/integration';
            const pattern = config.testFiles || '**/*.*';
            const files = globSync(`${folder}/${pattern}`, { cwd: projectPath, nodir: true });
            specFiles.push(...files);
          }
          if (config.supportFile) {
            supportFiles.push(config.supportFile);
          }
        } catch {}
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Default patterns if config not found but cypress folder exists
  if (specFiles.length === 0 && existsSync(join(projectPath, 'cypress'))) {
    try {
      const defaultSpecs = globSync('cypress/e2e/**/*.cy.{js,ts,jsx,tsx}', { cwd: projectPath, nodir: true });
      specFiles.push(...defaultSpecs);
      // Also check legacy integration folder
      const legacySpecs = globSync('cypress/integration/**/*.{js,ts,jsx,tsx}', { cwd: projectPath, nodir: true });
      specFiles.push(...legacySpecs);
    } catch {}
  }

  if (supportFiles.length === 0 && existsSync(join(projectPath, 'cypress/support'))) {
    // Default support file location
    if (existsSync(join(projectPath, 'cypress/support/e2e.ts'))) {
      supportFiles.push('cypress/support/e2e.ts');
    } else if (existsSync(join(projectPath, 'cypress/support/e2e.js'))) {
      supportFiles.push('cypress/support/e2e.js');
    } else if (existsSync(join(projectPath, 'cypress/support/index.ts'))) {
      supportFiles.push('cypress/support/index.ts');
    } else if (existsSync(join(projectPath, 'cypress/support/index.js'))) {
      supportFiles.push('cypress/support/index.js');
    }
  }

  return { specFiles: [...new Set(specFiles)], supportFiles: [...new Set(supportFiles)] };
}

/**
 * Parse Jest configuration for test patterns and setup files
 * @param {string} projectPath - Project root path
 * @returns {Object} - { testFiles: string[], setupFiles: string[] }
 */
export function parseJestConfig(projectPath) {
  const configFiles = [
    'jest.config.js',
    'jest.config.ts',
    'jest.config.mjs',
    'jest.config.json'
  ];

  const testFiles = [];
  const setupFiles = [];

  // Check package.json jest config
  const pkgPath = join(projectPath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.jest) {
        if (pkg.jest.setupFilesAfterEnv) {
          setupFiles.push(...pkg.jest.setupFilesAfterEnv.map(f => f.replace(/^<rootDir>\//, '')));
        }
        if (pkg.jest.setupFiles) {
          setupFiles.push(...pkg.jest.setupFiles.map(f => f.replace(/^<rootDir>\//, '')));
        }
      }
    } catch {}
  }

  for (const configFile of configFiles) {
    const configPath = join(projectPath, configFile);
    if (!existsSync(configPath)) continue;

    try {
      const content = readFileSync(configPath, 'utf-8');

      // Extract setupFilesAfterEnv
      const setupMatch = content.match(/setupFilesAfterEnv\s*:\s*\[([^\]]+)\]/s);
      if (setupMatch) {
        const files = setupMatch[1].matchAll(/['"]([^'"]+)['"]/g);
        for (const match of files) {
          setupFiles.push(match[1].replace(/^<rootDir>\//, ''));
        }
      }

      // Extract testMatch patterns
      const testMatchMatch = content.match(/testMatch\s*:\s*\[([^\]]+)\]/s);
      if (testMatchMatch) {
        const patterns = testMatchMatch[1].matchAll(/['"]([^'"]+)['"]/g);
        for (const match of patterns) {
          const pattern = match[1].replace(/^<rootDir>\//, '').replace(/\*\*\//, '');
          try {
            const files = globSync(pattern, { cwd: projectPath, nodir: true });
            testFiles.push(...files);
          } catch {}
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Default test patterns if none found
  if (testFiles.length === 0) {
    try {
      const defaultTests = globSync('**/*.{test,spec}.{js,ts,jsx,tsx}', {
        cwd: projectPath,
        nodir: true,
        ignore: ['node_modules/**']
      });
      testFiles.push(...defaultTests);

      const testDirTests = globSync('**/__tests__/**/*.{js,ts,jsx,tsx}', {
        cwd: projectPath,
        nodir: true,
        ignore: ['node_modules/**']
      });
      testFiles.push(...testDirTests);
    } catch {}
  }

  return { testFiles: [...new Set(testFiles)], setupFiles: [...new Set(setupFiles)] };
}

/**
 * Parse Nx workspace configuration for entry points
 * Looks for project.json files in apps/ and libs/ directories
 * @param {string} projectPath - Project root path
 * @returns {{ entries: string[] }}
 */
export function parseNxConfig(projectPath) {
  const entries = [];

  try {
    // Find all project.json files in apps/ and libs/
    const projectPatterns = [
      'apps/*/project.json',
      'apps/*/*/project.json',
      'libs/*/project.json',
      'libs/*/*/project.json',
      'packages/*/project.json'
    ];

    for (const pattern of projectPatterns) {
      try {
        const matches = globSync(pattern, { cwd: projectPath, nodir: true });
        for (const match of matches) {
          try {
            const projectJsonPath = join(projectPath, match);
            const content = JSON.parse(readFileSync(projectJsonPath, 'utf-8'));

            // Only treat applications as entry points, not libraries
            // Libraries are only "live" if something imports from them
            const isApplication = content.projectType === 'application';
            if (!isApplication) continue;

            // Look for main entry in targets.build.options
            if (content.targets?.build?.options?.main) {
              entries.push(content.targets.build.options.main);
            }

            // Also check for executor-specific entries
            for (const [, target] of Object.entries(content.targets || {})) {
              if (target.options?.main && !entries.includes(target.options.main)) {
                entries.push(target.options.main);
              }
              // Check for browser/server entries (Angular-style)
              if (target.options?.browser) {
                entries.push(target.options.browser);
              }
              if (target.options?.server) {
                entries.push(target.options.server);
              }
            }
          } catch {
            // Ignore individual project.json parse errors
          }
        }
      } catch {
        // Ignore glob errors
      }
    }
  } catch {
    // Ignore errors
  }

  return { entries: [...new Set(entries)] };
}

/**
 * Parse Angular workspace configuration for entry points
 * @param {string} projectPath - Project root path
 * @returns {{ entries: string[] }}
 */
export function parseAngularConfig(projectPath) {
  const entries = [];

  try {
    const angularJsonPath = join(projectPath, 'angular.json');
    if (existsSync(angularJsonPath)) {
      const content = JSON.parse(readFileSync(angularJsonPath, 'utf-8'));

      for (const [, project] of Object.entries(content.projects || {})) {
        // Check architect/build/options/main
        if (project.architect?.build?.options?.main) {
          entries.push(project.architect.build.options.main);
        }
        // Check for environment files in fileReplacements
        if (project.architect?.build?.configurations) {
          for (const [, config] of Object.entries(project.architect.build.configurations)) {
            if (config.fileReplacements) {
              for (const replacement of config.fileReplacements) {
                if (replacement.replace) entries.push(replacement.replace);
                if (replacement.with) entries.push(replacement.with);
              }
            }
          }
        }
      }
    }
  } catch {
    // Ignore errors
  }

  return { entries: [...new Set(entries)] };
}

/**
 * Collect all entry points from bundler and CI/CD configs
 * @param {string} projectPath - Project root path
 * @returns {Object} - Aggregated entry point information
 */
export function collectConfigEntryPoints(projectPath) {
  const webpack = parseWebpackConfig(projectPath);
  const vite = parseViteConfig(projectPath);
  const rollup = parseRollupConfig(projectPath);
  const esbuild = parseEsbuildConfig(projectPath);
  const parcel = parseParcelConfig(projectPath);
  const github = parseGitHubActions(projectPath);
  const gitlab = parseGitLabCI(projectPath);
  const jenkins = parseJenkinsfile(projectPath);
  const docker = parseDockerConfig(projectPath);
  const moduleFederation = parseModuleFederationConfig(projectPath);
  const serverless = parseServerlessConfig(projectPath);
  const nextjs = parseNextjsConfig(projectPath);
  const cypress = parseCypressConfig(projectPath);
  const jest = parseJestConfig(projectPath);
  const nx = parseNxConfig(projectPath);
  const angular = parseAngularConfig(projectPath);

  // Combine all entries
  const allEntries = [
    ...webpack.entries,
    ...vite.entries,
    ...rollup.entries,
    ...esbuild.entries,
    ...parcel.entries,
    ...github.scripts.filter(s => !s.startsWith('npm:')),
    ...gitlab.scripts,
    ...jenkins.scripts,
    ...docker.entrypoints,
    ...docker.cmdScripts,
    ...moduleFederation.exposes,
    ...serverless.handlers,
    ...nextjs.pages,
    ...nextjs.appRoutes,
    ...nextjs.apiRoutes,
    ...cypress.specFiles,
    ...cypress.supportFiles,
    ...jest.testFiles,
    ...jest.setupFiles,
    ...nx.entries,
    ...angular.entries
  ];

  // Normalize paths (remove leading ./)
  const normalizedEntries = allEntries.map(e =>
    e.replace(/^\.\//, '')
  );

  return {
    bundler: {
      webpack: webpack.entries.length > 0 ? webpack : null,
      vite: vite.entries.length > 0 ? vite : null,
      rollup: rollup.entries.length > 0 ? rollup : null,
      esbuild: esbuild.entries.length > 0 ? esbuild : null,
      parcel: parcel.entries.length > 0 ? parcel : null,
      moduleFederation: moduleFederation.exposes.length > 0 ? moduleFederation : null
    },
    cicd: {
      github: github.scripts.length > 0 ? github : null,
      gitlab: gitlab.scripts.length > 0 ? gitlab : null,
      jenkins: jenkins.scripts.length > 0 ? jenkins : null,
      docker: (docker.entrypoints.length > 0 || docker.cmdScripts.length > 0) ? docker : null,
      serverless: serverless.handlers.length > 0 ? serverless : null
    },
    framework: {
      nextjs: (nextjs.pages.length > 0 || nextjs.appRoutes.length > 0) ? nextjs : null
    },
    testing: {
      cypress: (cypress.specFiles.length > 0 || cypress.supportFiles.length > 0) ? cypress : null,
      jest: (jest.testFiles.length > 0 || jest.setupFiles.length > 0) ? jest : null
    },
    entries: [...new Set(normalizedEntries)],
    npmScripts: github.scripts.filter(s => s.startsWith('npm:')).map(s => s.replace('npm:', ''))
  };
}

/**
 * Check if a file is referenced in bundler/CI configs
 * @param {string} filePath - Relative file path
 * @param {Object} configData - Result from collectConfigEntryPoints
 * @returns {Object} - { isEntry: boolean, source: string|null }
 */
export function isConfigEntry(filePath, configData) {
  const normalizedPath = filePath.replace(/^\.\//, '');

  for (const entry of configData.entries) {
    // Direct match
    if (normalizedPath === entry || normalizedPath.endsWith(entry)) {
      return { isEntry: true, source: 'bundler/ci-config' };
    }

    // Match without extension
    const withoutExt = entry.replace(/\.[^.]+$/, '');
    const fileWithoutExt = normalizedPath.replace(/\.[^.]+$/, '');
    if (fileWithoutExt === withoutExt || fileWithoutExt.endsWith(withoutExt)) {
      return { isEntry: true, source: 'bundler/ci-config' };
    }
  }

  return { isEntry: false, source: null };
}

export default {
  parseWebpackConfig,
  parseViteConfig,
  parseRollupConfig,
  parseEsbuildConfig,
  parseParcelConfig,
  parseGitHubActions,
  parseGitLabCI,
  parseJenkinsfile,
  parseDockerConfig,
  parseModuleFederationConfig,
  parseServerlessConfig,
  parseNextjsConfig,
  parseCypressConfig,
  parseJestConfig,
  collectConfigEntryPoints,
  isConfigEntry
};
