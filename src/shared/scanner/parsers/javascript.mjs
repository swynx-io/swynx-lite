// src/scanner/parsers/javascript.mjs
// Enterprise-grade JavaScript/TypeScript parser using Babel AST
// Captures every function, class, method, and code structure with exact boundaries

import { readFileSync, existsSync } from 'fs';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';

// Handle both ESM and CJS default exports
const traverse = _traverse.default || _traverse;

/**
 * Parse a JavaScript/TypeScript file with full AST analysis
 * Captures every function, class, method with exact line numbers and sizes
 */
export async function parseJavaScript(file) {
  const filePath = typeof file === 'string' ? file : file.path;
  const relativePath = typeof file === 'string' ? file : file.relativePath;

  if (!existsSync(filePath)) {
    return createEmptyResult(filePath, relativePath, 'File not found');
  }

  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (error) {
    return createEmptyResult(filePath, relativePath, `Read error: ${error.message}`);
  }

  // Handle Vue Single File Components (.vue)
  // Extract script content from <script> or <script setup> block
  let scriptContent = content;
  let isVueSFC = false;
  let scriptLineOffset = 0;

  if (filePath.endsWith('.vue') || filePath.endsWith('.svelte')) {
    isVueSFC = true;
    const scriptMatch = content.match(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/i);
    if (scriptMatch) {
      scriptContent = scriptMatch[1];
      // Calculate line offset to adjust reported line numbers
      const beforeScript = content.slice(0, scriptMatch.index);
      scriptLineOffset = (beforeScript.match(/\n/g) || []).length + 1;
    } else {
      // No script block found - return empty but valid result
      return {
        file: { path: filePath, relativePath },
        content,
        functions: [],
        classes: [],
        exports: [],
        imports: [],
        lines: content.split('\n').length,
        size: content.length,
        parseMethod: filePath.endsWith('.svelte') ? 'svelte-no-script' : 'vue-no-script'
      };
    }
  }

  const lines = content.split('\n');

  try {
    // Parse with Babel - supports JSX, TypeScript, and all modern syntax
    const ast = parse(scriptContent, {
      sourceType: 'unambiguous', // Auto-detect module vs script
      plugins: [
        'jsx',
        'typescript',
        'decorators-legacy',
        'classProperties',
        'classPrivateProperties',
        'classPrivateMethods',
        'classStaticBlock',
        'exportDefaultFrom',
        'exportNamespaceFrom',
        'dynamicImport',
        'importMeta',
        'nullishCoalescingOperator',
        'optionalChaining',
        'optionalCatchBinding',
        'topLevelAwait',
        'asyncGenerators',
        'objectRestSpread',
        'numericSeparator',
        'bigInt',
        'throwExpressions',
        'regexpUnicodeSets',       // ES2024 regex features (v flag)
        'importAttributes',        // import assertions/attributes
        'explicitResourceManagement', // using declarations
        'sourcePhaseImports',      // source imports
        'deferredImportEvaluation' // deferred imports
      ],
      errorRecovery: true, // Continue parsing on errors
      allowReturnOutsideFunction: true,
      allowSuperOutsideMethod: true,
      allowUndeclaredExports: true
    });

    const functions = [];
    const classes = [];
    const exports = [];
    const imports = [];

    traverse(ast, {
      // ═══════════════════════════════════════════════════════════════════
      // FUNCTION DECLARATIONS: function name() {}
      // ═══════════════════════════════════════════════════════════════════
      FunctionDeclaration(path) {
        if (!path.node.id) return; // Skip anonymous

        const func = extractFunctionInfo(path.node, content, 'function');
        func.name = path.node.id.name;
        func.exported = isExported(path);
        functions.push(func);
      },

      // ═══════════════════════════════════════════════════════════════════
      // ARROW FUNCTIONS: const name = () => {} or const name = async () => {}
      // ═══════════════════════════════════════════════════════════════════
      VariableDeclarator(path) {
        const init = path.node.init;
        if (!init) return;
        if (!path.node.id || path.node.id.type !== 'Identifier') return;

        const name = path.node.id.name;

        // Arrow function or function expression assigned to variable
        if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
          const func = extractFunctionInfo(init, content, init.type === 'ArrowFunctionExpression' ? 'arrow' : 'expression');
          func.name = name;

          // Get the full declaration including 'const name = '
          const parent = path.parentPath?.node;
          if (parent?.loc) {
            func.line = parent.loc.start.line;
            func.column = parent.loc.start.column;
          }

          // Check if exported
          const grandParent = path.parentPath?.parentPath;
          func.exported = grandParent?.node?.type === 'ExportNamedDeclaration';

          // Recalculate size with full declaration
          func.sizeBytes = extractCodeSize(content, func.line, func.endLine);

          functions.push(func);
        }
      },

      // ═══════════════════════════════════════════════════════════════════
      // CLASS DECLARATIONS: class Name {}
      // ═══════════════════════════════════════════════════════════════════
      ClassDeclaration(path) {
        const node = path.node;
        if (!node.id) return;

        const classInfo = {
          name: node.id.name,
          type: 'class',
          line: node.loc?.start?.line || 0,
          endLine: node.loc?.end?.line || 0,
          column: node.loc?.start?.column || 0,
          lineCount: 0,
          sizeBytes: 0,
          exported: isExported(path),
          superClass: node.superClass?.name || null,
          methods: [],
          properties: [],
          // Extract decorators for DI detection (@Service, @Injectable, etc.)
          decorators: (node.decorators || []).map(dec => {
            const expr = dec.expression;
            let name = null;
            let args = null;

            if (expr.type === 'CallExpression') {
              // @Service() or @Module.forRoot()
              name = expr.callee?.name || expr.callee?.property?.name;
              // Extract first argument if it's an object literal (for @Injectable({ providedIn: 'root' }))
              if (expr.arguments?.[0]?.type === 'ObjectExpression') {
                args = {};
                for (const prop of expr.arguments[0].properties || []) {
                  if (prop.key?.name && prop.value) {
                    // Handle string literals and identifiers
                    if (prop.value.type === 'StringLiteral' || prop.value.type === 'Literal') {
                      args[prop.key.name] = prop.value.value;
                    } else if (prop.value.type === 'Identifier') {
                      args[prop.key.name] = prop.value.name;
                    }
                  }
                }
              }
            } else if (expr.type === 'Identifier') {
              // @Service (without parentheses)
              name = expr.name;
            } else if (expr.type === 'MemberExpression') {
              // @Module.Service
              name = expr.property?.name;
            }

            return { name, args, line: dec.loc?.start?.line || 0 };
          }).filter(d => d.name)
        };

        classInfo.lineCount = classInfo.endLine - classInfo.line + 1;
        classInfo.sizeBytes = extractCodeSize(content, classInfo.line, classInfo.endLine);

        // Extract methods
        if (node.body && node.body.body) {
          for (const member of node.body.body) {
            if (member.type === 'ClassMethod' || member.type === 'ClassPrivateMethod') {
              const method = extractMethodInfo(member, content, classInfo.name);
              classInfo.methods.push(method);
              functions.push(method); // Also add to global functions for duplicate detection
            } else if (member.type === 'ClassProperty' || member.type === 'ClassPrivateProperty') {
              // Check if property is assigned a function
              if (member.value?.type === 'ArrowFunctionExpression' ||
                  member.value?.type === 'FunctionExpression') {
                const method = extractFunctionInfo(member.value, content, 'property');
                method.name = member.key?.name || member.key?.id?.name || 'anonymous';
                method.className = classInfo.name;
                method.line = member.loc?.start?.line || 0;
                method.endLine = member.loc?.end?.line || 0;
                method.sizeBytes = extractCodeSize(content, method.line, method.endLine);
                classInfo.methods.push(method);
                functions.push(method);
              } else {
                classInfo.properties.push({
                  name: member.key?.name || 'unknown',
                  line: member.loc?.start?.line || 0,
                  static: member.static || false
                });
              }
            }
          }
        }

        classes.push(classInfo);
      },

      // ═══════════════════════════════════════════════════════════════════
      // OBJECT METHODS: { methodName() {} } or { methodName: function() {} }
      // ═══════════════════════════════════════════════════════════════════
      ObjectMethod(path) {
        if (!path.node.key) return;

        const name = path.node.key.name || path.node.key.value || 'anonymous';
        const func = extractFunctionInfo(path.node, content, 'method');
        func.name = name;
        func.isObjectMethod = true;

        // Try to find parent object name
        const parent = path.parentPath?.parentPath;
        if (parent?.node?.type === 'VariableDeclarator' && parent.node.id?.name) {
          func.objectName = parent.node.id.name;
        }

        functions.push(func);
      },

      ObjectProperty(path) {
        const value = path.node.value;
        if (!value) return;

        // Property with function value: { name: function() {} } or { name: () => {} }
        if (value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression') {
          const name = path.node.key?.name || path.node.key?.value || 'anonymous';
          const func = extractFunctionInfo(value, content, 'property');
          func.name = name;
          func.isObjectProperty = true;

          // Get full property bounds
          func.line = path.node.loc?.start?.line || func.line;
          func.endLine = path.node.loc?.end?.line || func.endLine;
          func.sizeBytes = extractCodeSize(content, func.line, func.endLine);

          functions.push(func);
        }
      },

      // ═══════════════════════════════════════════════════════════════════
      // IMPORTS
      // ═══════════════════════════════════════════════════════════════════
      ImportDeclaration(path) {
        const node = path.node;
        const source = node.source?.value;
        if (!source) return;

        const importInfo = {
          module: source,
          line: node.loc?.start?.line || 0,
          type: 'esm',
          specifiers: []
        };

        for (const spec of node.specifiers || []) {
          if (spec.type === 'ImportDefaultSpecifier') {
            importInfo.specifiers.push({
              name: spec.local?.name,
              type: 'default'
            });
          } else if (spec.type === 'ImportNamespaceSpecifier') {
            importInfo.specifiers.push({
              name: spec.local?.name,
              type: 'namespace'
            });
          } else if (spec.type === 'ImportSpecifier') {
            importInfo.specifiers.push({
              name: spec.imported?.name || spec.local?.name,
              localName: spec.local?.name,
              type: 'named'
            });
          }
        }

        imports.push(importInfo);
      },

      // Handle dynamic imports: import('./module')
      Import(path) {
        // The parent is a CallExpression with the dynamic import
        const parent = path.parentPath;
        if (parent?.node?.type === 'CallExpression') {
          const arg = parent.node.arguments?.[0];
          if (arg?.type === 'StringLiteral' || arg?.type === 'Literal') {
            const modulePath = arg.value;
            if (modulePath) {
              imports.push({
                module: modulePath,
                line: parent.node.loc?.start?.line || 0,
                type: 'dynamic-import',
                isDynamic: true
              });
            }
          }
        }
      },

      // Handle require() calls and dynamic module loading patterns
      CallExpression(path) {
        const node = path.node;

        // Handle dynamic import() as CallExpression (older parser versions)
        if (node.callee?.type === 'Import' && node.arguments?.[0]) {
          const arg = node.arguments[0];
          const modulePath = arg.value || arg.quasis?.[0]?.value?.raw;
          if (modulePath && typeof modulePath === 'string') {
            imports.push({
              module: modulePath,
              line: node.loc?.start?.line || 0,
              type: 'dynamic-import',
              isDynamic: true
            });
          }
        }

        // Handle require('module')
        if (node.callee?.name === 'require' && node.arguments?.[0]?.value) {
          imports.push({
            module: node.arguments[0].value,
            line: node.loc?.start?.line || 0,
            type: 'commonjs'
          });
        }

        // Handle glob.sync('**/*.node.ts') - Node.js glob
        if (node.callee?.type === 'MemberExpression' &&
            node.callee.object?.name === 'glob' &&
            node.callee.property?.name === 'sync') {
          const pattern = node.arguments?.[0]?.value;
          if (pattern && typeof pattern === 'string') {
            imports.push({
              module: pattern,
              line: node.loc?.start?.line || 0,
              type: 'glob-sync',
              isGlob: true
            });
          }
        }

        // Handle globSync('**/*.ts') - glob v9+ named export
        if (node.callee?.name === 'globSync' && node.arguments?.[0]?.value) {
          const pattern = node.arguments[0].value;
          if (typeof pattern === 'string') {
            imports.push({
              module: pattern,
              line: node.loc?.start?.line || 0,
              type: 'glob-sync',
              isGlob: true
            });
          }
        }

        // Handle import.meta.glob('**/*.ts') - Vite
        if (node.callee?.type === 'MemberExpression' &&
            node.callee.object?.type === 'MetaProperty' &&
            node.callee.property?.name === 'glob') {
          const pattern = node.arguments?.[0]?.value;
          if (pattern && typeof pattern === 'string') {
            imports.push({
              module: pattern,
              line: node.loc?.start?.line || 0,
              type: 'import-meta-glob',
              isGlob: true
            });
          }
        }

        // Handle require.context('./', true, /\.ts$/) - Webpack
        if (node.callee?.type === 'MemberExpression' &&
            node.callee.object?.name === 'require' &&
            node.callee.property?.name === 'context') {
          const dir = node.arguments?.[0]?.value;
          const regexNode = node.arguments?.[2];
          if (dir) {
            imports.push({
              module: dir,
              line: node.loc?.start?.line || 0,
              type: 'require-context',
              isGlob: true,
              recursive: node.arguments?.[1]?.value ?? false,
              pattern: regexNode?.regex?.pattern || regexNode?.pattern || '.*'
            });
          }
        }
      },

      // ═══════════════════════════════════════════════════════════════════
      // EXPORTS
      // ═══════════════════════════════════════════════════════════════════
      ExportNamedDeclaration(path) {
        const node = path.node;
        const decl = node.declaration;

        if (decl) {
          if (decl.type === 'FunctionDeclaration' && decl.id) {
            exports.push({
              name: decl.id.name,
              type: 'function',
              line: node.loc?.start?.line || 0
            });
          } else if (decl.type === 'VariableDeclaration') {
            for (const d of decl.declarations) {
              if (d.id?.name) {
                exports.push({
                  name: d.id.name,
                  type: 'variable',
                  line: node.loc?.start?.line || 0
                });
              }
            }
          } else if (decl.type === 'ClassDeclaration' && decl.id) {
            exports.push({
              name: decl.id.name,
              type: 'class',
              line: node.loc?.start?.line || 0
            });
          }
        }

        // export { foo, bar } or export { foo } from './module'
        for (const spec of node.specifiers || []) {
          exports.push({
            name: spec.exported?.name || spec.local?.name,
            type: 'reexport',
            line: node.loc?.start?.line || 0,
            sourceModule: node.source?.value || null  // Capture re-export source for barrel files
          });
        }
      },

      // ═══════════════════════════════════════════════════════════════════
      // EXPORT ALL: export * from './module'
      // ═══════════════════════════════════════════════════════════════════
      ExportAllDeclaration(path) {
        exports.push({
          name: '*',
          type: 'reexport-all',
          sourceModule: path.node.source?.value || null,
          line: path.node.loc?.start?.line || 0
        });
      },

      ExportDefaultDeclaration(path) {
        const node = path.node;
        let name = 'default';

        if (node.declaration) {
          if (node.declaration.id?.name) {
            name = node.declaration.id.name;
          } else if (node.declaration.type === 'Identifier') {
            name = node.declaration.name;
          }
        }

        exports.push({
          name,
          type: 'default',
          isDefault: true,
          line: node.loc?.start?.line || 0
        });
      }
    });

    // Sort functions by line number
    functions.sort((a, b) => a.line - b.line);
    classes.sort((a, b) => a.line - b.line);

    return {
      file: { path: filePath, relativePath },
      content,
      functions,
      classes,
      exports,
      imports,
      lines: lines.length,
      size: content.length,
      parseMethod: isVueSFC ? 'babel-ast-vue' : 'babel-ast',
      ...(isVueSFC && { scriptLineOffset })  // Include offset for Vue SFCs
    };

  } catch (parseError) {
    // Fallback to regex parsing for files Babel can't handle
    // Suppress warnings for Vue/Svelte — Babel can't parse the full SFC, regex fallback is expected
    if (!isVueSFC && process.env.SWYNX_VERBOSE) {
      console.warn(`[Parser] Babel failed for ${relativePath}, using regex fallback: ${parseError.message}`);
    }
    return parseWithRegex(filePath, relativePath, content, lines);
  }
}

/**
 * Extract function information from AST node
 */
function extractFunctionInfo(node, content, type) {
  const loc = node.loc || {};
  const startLine = loc.start?.line || 0;
  const endLine = loc.end?.line || 0;
  const startColumn = loc.start?.column || 0;

  const info = {
    name: node.id?.name || 'anonymous',
    type,
    line: startLine,
    endLine,
    column: startColumn,
    lineCount: endLine - startLine + 1,
    sizeBytes: 0,
    async: node.async || false,
    generator: node.generator || false,
    params: [],
    signature: ''
  };

  // Extract parameters
  for (const param of node.params || []) {
    if (param.type === 'Identifier') {
      info.params.push(param.name);
    } else if (param.type === 'AssignmentPattern' && param.left?.name) {
      info.params.push(`${param.left.name}=`);
    } else if (param.type === 'RestElement' && param.argument?.name) {
      info.params.push(`...${param.argument.name}`);
    } else if (param.type === 'ObjectPattern') {
      info.params.push('{...}');
    } else if (param.type === 'ArrayPattern') {
      info.params.push('[...]');
    }
  }

  // Build signature
  const asyncPrefix = info.async ? 'async ' : '';
  const genPrefix = info.generator ? '*' : '';
  info.signature = `${asyncPrefix}function${genPrefix} ${info.name}(${info.params.join(', ')})`;

  // Compute size without storing full body (saves ~5GB on large repos)
  info.sizeBytes = extractCodeSize(content, startLine, endLine);

  return info;
}

/**
 * Extract class method information
 */
function extractMethodInfo(node, content, className) {
  const loc = node.loc || {};
  const startLine = loc.start?.line || 0;
  const endLine = loc.end?.line || 0;

  let name = 'anonymous';
  if (node.key) {
    if (node.key.type === 'Identifier') {
      name = node.key.name;
    } else if (node.key.type === 'PrivateName') {
      name = `#${node.key.id?.name || 'private'}`;
    }
  }

  const info = {
    name,
    type: 'method',
    kind: node.kind || 'method', // 'constructor', 'method', 'get', 'set'
    className,
    line: startLine,
    endLine,
    column: loc.start?.column || 0,
    lineCount: endLine - startLine + 1,
    sizeBytes: 0,
    async: node.async || false,
    generator: node.generator || false,
    static: node.static || false,
    params: [],
    signature: ''
  };

  // Extract parameters
  for (const param of node.params || []) {
    if (param.type === 'Identifier') {
      info.params.push(param.name);
    } else if (param.type === 'AssignmentPattern' && param.left?.name) {
      info.params.push(`${param.left.name}=`);
    } else if (param.type === 'RestElement' && param.argument?.name) {
      info.params.push(`...${param.argument.name}`);
    }
  }

  // Build signature
  const staticPrefix = info.static ? 'static ' : '';
  const asyncPrefix = info.async ? 'async ' : '';
  info.signature = `${staticPrefix}${asyncPrefix}${name}(${info.params.join(', ')})`;

  // Compute size without storing full body (saves ~5GB on large repos)
  info.sizeBytes = extractCodeSize(content, startLine, endLine);

  return info;
}

/**
 * Check if a node is exported
 */
function isExported(path) {
  const parent = path.parentPath;
  if (!parent) return false;

  return parent.node?.type === 'ExportNamedDeclaration' ||
         parent.node?.type === 'ExportDefaultDeclaration';
}

/**
 * Extract code between line numbers
 */
function extractCode(content, startLine, endLine) {
  if (!startLine || !endLine) return '';

  const lines = content.split('\n');
  const start = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, endLine);

  return lines.slice(start, end).join('\n');
}

/**
 * Calculate code size between line numbers
 */
function extractCodeSize(content, startLine, endLine) {
  return extractCode(content, startLine, endLine).length;
}

/**
 * Create empty result for error cases
 */
function createEmptyResult(filePath, relativePath, error) {
  return {
    file: { path: filePath, relativePath },
    content: '',
    functions: [],
    classes: [],
    exports: [],
    imports: [],
    lines: 0,
    size: 0,
    error,
    parseMethod: 'none'
  };
}

/**
 * Fallback regex-based parsing for files Babel can't handle
 */
function parseWithRegex(filePath, relativePath, content, lines) {
  const functions = [];
  const classes = [];
  const exports = [];
  const imports = [];

  // Track brace depth for finding function boundaries
  const functionPatterns = [
    /^(\s*)(export\s+)?(async\s+)?function\s*\*?\s*(\w+)\s*\(/,
    /^(\s*)(export\s+)?(const|let|var)\s+(\w+)\s*=\s*(async\s+)?\([^)]*\)\s*=>/,
    /^(\s*)(export\s+)?(const|let|var)\s+(\w+)\s*=\s*(async\s+)?(\w+)\s*=>/,
    /^(\s*)(export\s+)?class\s+(\w+)/
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for function patterns
    for (const pattern of functionPatterns) {
      const match = line.match(pattern);
      if (match) {
        const startLine = i + 1;
        const endLine = findBlockEnd(lines, i);
        const name = match[4] || match[3] || 'anonymous';
        const body = lines.slice(i, endLine).join('\n');

        if (pattern.source.includes('class')) {
          classes.push({
            name,
            type: 'class',
            line: startLine,
            endLine,
            lineCount: endLine - startLine + 1,
            sizeBytes: body.length
          });
        } else {
          functions.push({
            name,
            type: 'function',
            line: startLine,
            endLine,
            lineCount: endLine - startLine + 1,
            sizeBytes: body.length,
            signature: line.trim().replace(/\{.*$/, '').trim()
          });
        }
        break;
      }
    }

    // Check for imports
    const importMatch = line.match(/^import\s+.*from\s+['"]([^'"]+)['"]/);
    if (importMatch) {
      imports.push({ module: importMatch[1], line: i + 1, type: 'esm' });
    }

    const requireMatch = line.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (requireMatch) {
      imports.push({ module: requireMatch[1], line: i + 1, type: 'commonjs' });
    }

    // Check for exports
    if (/^export\s+(default\s+)?/.test(line)) {
      const exportMatch = line.match(/export\s+(default\s+)?(function|class|const|let|var)?\s*(\w+)?/);
      if (exportMatch) {
        exports.push({
          name: exportMatch[3] || 'default',
          type: exportMatch[2] || 'default',
          isDefault: !!exportMatch[1],
          line: i + 1
        });
      }
    }
  }

  return {
    file: { path: filePath, relativePath },
    content,
    functions,
    classes,
    exports,
    imports,
    lines: lines.length,
    size: content.length,
    parseMethod: 'regex-fallback'
  };
}

/**
 * Find the end of a code block by tracking braces
 */
function findBlockEnd(lines, startIndex) {
  let braceDepth = 0;
  let started = false;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];

    // Skip strings and comments (simplified)
    let inString = false;
    let stringChar = '';

    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      const nextChar = line[j + 1];

      // Handle strings
      if (!inString && (char === '"' || char === "'" || char === '`')) {
        inString = true;
        stringChar = char;
        continue;
      }
      if (inString && char === stringChar && line[j - 1] !== '\\') {
        inString = false;
        continue;
      }
      if (inString) continue;

      // Handle single-line comments
      if (char === '/' && nextChar === '/') break;

      // Count braces
      if (char === '{') {
        braceDepth++;
        started = true;
      } else if (char === '}') {
        braceDepth--;
        if (started && braceDepth === 0) {
          return i + 1;
        }
      }
    }
  }

  return startIndex + 1;
}

export default { parseJavaScript };
