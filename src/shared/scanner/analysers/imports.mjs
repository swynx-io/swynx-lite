// src/scanner/analysers/imports.mjs
// Import/export graph analysis

/**
 * Analyse import relationships
 */
export async function analyseImports(jsAnalysis, onProgress = () => {}) {
  const graph = new Map();
  const usedPackages = new Set();
  const unusedExports = [];
  const total = jsAnalysis.length;

  for (let i = 0; i < jsAnalysis.length; i++) {
    const file = jsAnalysis[i];

    // Report progress every 2 files and yield to event loop
    if (i % 2 === 0 || i === total - 1) {
      onProgress({ current: i + 1, total, file: file.file?.relativePath || file.file });
      await new Promise(resolve => setImmediate(resolve));
    }
    const filePath = file.file?.relativePath || file.file;

    // Track imports
    for (const imp of file.imports || []) {
      const module = imp.module;
      if (typeof module !== "string") continue;

      // Track npm packages
      if (!module.startsWith('.') && !module.startsWith('/')) {
        const packageName = module.startsWith('@')
          ? module.split('/').slice(0, 2).join('/')
          : module.split('/')[0];
        usedPackages.add(packageName);
      }

      // Build graph
      if (!graph.has(filePath)) {
        graph.set(filePath, { imports: [], exports: [], importedBy: [] });
      }
      graph.get(filePath).imports.push(module);
    }

    // Track exports
    for (const exp of file.exports || []) {
      if (!graph.has(filePath)) {
        graph.set(filePath, { imports: [], exports: [], importedBy: [] });
      }
      graph.get(filePath).exports.push(exp);
    }
  }

  return {
    graph,
    usedPackages,
    unusedExports,
    fileCount: graph.size
  };
}

export default { analyseImports };
