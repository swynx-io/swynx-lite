// src/scanner/parsers/python.mjs
// Python parser with Django, FastAPI, Flask, Celery support

import { readFileSync, existsSync } from 'fs';

/**
 * Parse a Python file and extract classes, functions, decorators, imports
 * @param {Object|string} file - File object or path
 * @returns {Object} - Parse result
 */
export async function parse(file) {
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

  try {
    const lines = content.split('\n');
    const functions = [];
    const classes = [];
    const decorators = [];  // All decorators found
    const imports = [];

    // Track decorators for next element
    let pendingDecorators = [];

    // Parse line by line
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Detect import statements
      const importMatch = line.match(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/);
      if (importMatch) {
        imports.push({
          module: importMatch[1],
          alias: importMatch[2] || null,
          type: 'import',
          line: lineNum
        });
        continue;
      }

      // Detect from ... import statements (single-line and multi-line with parentheses)
      const fromImportMatch = line.match(/^\s*from\s+([\w.]+)\s+import\s+(.+)/);
      if (fromImportMatch) {
        const module = fromImportMatch[1];
        let importedText = fromImportMatch[2].trim();

        // Handle multi-line parenthetical imports: from X import (\n  item1,\n  item2\n)
        if (importedText.startsWith('(') && !importedText.includes(')')) {
          // Collect lines until closing paren
          importedText = importedText.slice(1); // remove opening paren
          for (let j = i + 1; j < lines.length; j++) {
            const nextLine = lines[j].trim();
            if (nextLine.includes(')')) {
              importedText += ',' + nextLine.replace(')', '');
              i = j; // advance line pointer
              break;
            }
            importedText += ',' + nextLine;
          }
        } else if (importedText.startsWith('(') && importedText.includes(')')) {
          // Single-line parenthetical: from X import (a, b, c)
          importedText = importedText.replace(/[()]/g, '');
        }

        const importedItems = importedText.split(',').map(s => s.trim()).filter(s => s && !s.startsWith('#'));

        // If module is only dots (e.g. ".", ".."), imported items are submodules
        // e.g. "from . import applications" → module should be ".applications"
        // If module has a name after dots (e.g. ".applications"), imported items are symbols
        // e.g. "from .applications import FastAPI" → module should be ".applications"
        const isDotsOnly = /^\.+$/.test(module);

        for (const item of importedItems) {
          // Handle star import: from X import *
          if (item.trim() === '*') {
            imports.push({
              module: module,
              name: '*',
              alias: null,
              type: 'from',
              line: lineNum
            });
            continue;
          }
          const aliasMatch = item.match(/(\w+)(?:\s+as\s+(\w+))?/);
          if (aliasMatch) {
            imports.push({
              module: isDotsOnly ? `${module}${aliasMatch[1]}` : module,
              name: aliasMatch[1],
              alias: aliasMatch[2] || null,
              type: 'from',
              line: lineNum
            });
          }
        }
        continue;
      }

      // Detect decorators
      const decoratorMatch = line.match(/^\s*@([\w.]+)(?:\(([^)]*)\))?/);
      if (decoratorMatch) {
        const decorator = {
          name: decoratorMatch[1],
          args: decoratorMatch[2] || null,
          line: lineNum
        };
        decorators.push(decorator);
        pendingDecorators.push(decorator);
        continue;
      }

      // Detect class declaration
      const classMatch = line.match(/^(\s*)class\s+(\w+)(?:\(([^)]*)\))?:/);
      if (classMatch) {
        const indent = classMatch[1].length;
        const baseClasses = classMatch[3] ? classMatch[3].split(',').map(s => s.trim()) : [];

        const classInfo = {
          name: classMatch[2],
          type: 'class',
          line: lineNum,
          endLine: findIndentBlockEnd(lines, i, indent),
          indent,
          baseClasses,
          decorators: [...pendingDecorators],
          methods: [],
          exported: !classMatch[2].startsWith('_')  // Not private
        };

        classInfo.lineCount = classInfo.endLine - classInfo.line + 1;
        classInfo.sizeBytes = extractCode(content, classInfo.line, classInfo.endLine).length;

        // Parse methods inside the class
        parseClassMethods(lines, classInfo, functions);

        classes.push(classInfo);
        pendingDecorators = [];
        continue;
      }

      // Detect function declaration (module-level)
      const funcMatch = line.match(/^(\s*)(async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([\w\[\],\s.]+))?:/);
      if (funcMatch && funcMatch[1].length === 0) {  // Module-level only
        const funcInfo = {
          name: funcMatch[3],
          type: funcMatch[2] ? 'async function' : 'function',
          async: !!funcMatch[2],
          line: lineNum,
          endLine: findIndentBlockEnd(lines, i, 0),
          params: parseParams(funcMatch[4]),
          returnType: funcMatch[5]?.trim() || null,
          decorators: [...pendingDecorators],
          signature: `def ${funcMatch[3]}(${funcMatch[4]})`,
          exported: !funcMatch[3].startsWith('_')
        };

        funcInfo.lineCount = funcInfo.endLine - funcInfo.line + 1;
        funcInfo.sizeBytes = extractCode(content, funcInfo.line, funcInfo.endLine).length;

        functions.push(funcInfo);
        pendingDecorators = [];
        continue;
      }

      // Clear pending decorators if we hit something else
      if (line.trim() && !line.trim().startsWith('#')) {
        pendingDecorators = [];
      }
    }

    // Check for __main__ block
    const hasMainBlock = content.includes('if __name__ == "__main__"') ||
                         content.includes("if __name__ == '__main__'");

    // Determine exports (public functions and classes)
    const exports = [
      ...functions.filter(f => f.exported).map(f => ({
        name: f.name,
        type: 'function',
        line: f.line
      })),
      ...classes.filter(c => c.exported).map(c => ({
        name: c.name,
        type: 'class',
        line: c.line
      }))
    ];

    // Check for __all__ definition
    const allMatch = content.match(/__all__\s*=\s*\[([\s\S]*?)\]/);
    if (allMatch) {
      const exportNames = allMatch[1].match(/['"](\w+)['"]/g);
      if (exportNames) {
        // __all__ defines explicit exports
        exports.length = 0;
        for (const name of exportNames) {
          const cleanName = name.replace(/['"]/g, '');
          exports.push({
            name: cleanName,
            type: 'explicit',
            line: 0
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
      annotations: decorators,
      lines: lines.length,
      size: content.length,
      parseMethod: 'python-regex',
      metadata: {
        hasMainBlock,
        isDjangoModel: classes.some(c =>
          c.baseClasses.some(b => b.includes('Model') || b.includes('models.Model'))
        ),
        isDjangoView: classes.some(c =>
          c.baseClasses.some(b => b.includes('View') || b.includes('APIView') || b.includes('ViewSet'))
        ),
        isFastAPI: decorators.some(d =>
          d.name.includes('app.') || d.name.includes('router.') || d.name === 'Depends'
        ),
        isFlask: decorators.some(d =>
          d.name.includes('route') || d.name.includes('Blueprint')
        ),
        isCelery: decorators.some(d =>
          d.name === 'task' || d.name === 'shared_task' || d.name.includes('celery.')
        )
      }
    };

  } catch (error) {
    return createEmptyResult(filePath, relativePath, `Parse error: ${error.message}`);
  }
}

/**
 * Parse methods inside a class
 */
function parseClassMethods(lines, classInfo, allFunctions) {
  const classIndent = classInfo.indent;

  for (let i = classInfo.line; i < classInfo.endLine - 1 && i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Method declaration
    const methodMatch = line.match(/^(\s+)(async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([\w\[\],\s.]+))?:/);
    if (methodMatch) {
      const methodIndent = methodMatch[1].length;
      // Must be directly inside the class
      if (methodIndent > classIndent) {
        // Collect decorators from previous lines
        const methodDecorators = [];
        for (let j = i - 1; j >= classInfo.line; j--) {
          const prevLine = lines[j];
          const decMatch = prevLine.match(/^\s+@([\w.]+)(?:\(([^)]*)\))?/);
          if (decMatch) {
            methodDecorators.unshift({
              name: decMatch[1],
              args: decMatch[2] || null,
              line: j + 1
            });
          } else if (prevLine.trim() && !prevLine.trim().startsWith('#')) {
            break;
          }
        }

        const methodInfo = {
          name: methodMatch[3],
          type: methodMatch[2] ? 'async method' : 'method',
          async: !!methodMatch[2],
          className: classInfo.name,
          line: lineNum,
          endLine: findIndentBlockEnd(lines, i, methodIndent),
          params: parseParams(methodMatch[4]),
          returnType: methodMatch[5]?.trim() || null,
          decorators: methodDecorators,
          signature: `def ${methodMatch[3]}(${methodMatch[4]})`,
          isStatic: methodDecorators.some(d => d.name === 'staticmethod'),
          isClassMethod: methodDecorators.some(d => d.name === 'classmethod'),
          isProperty: methodDecorators.some(d => d.name === 'property')
        };

        methodInfo.lineCount = methodInfo.endLine - methodInfo.line + 1;

        classInfo.methods.push(methodInfo);
        allFunctions.push(methodInfo);
      }
    }
  }
}

/**
 * Parse function parameters
 */
function parseParams(paramsStr) {
  if (!paramsStr || !paramsStr.trim()) return [];

  const params = [];
  let depth = 0;
  let current = '';

  for (const char of paramsStr) {
    if (char === '[' || char === '(') depth++;
    else if (char === ']' || char === ')') depth--;
    else if (char === ',' && depth === 0) {
      if (current.trim()) {
        params.push(parseParam(current.trim()));
      }
      current = '';
      continue;
    }
    current += char;
  }

  if (current.trim()) {
    params.push(parseParam(current.trim()));
  }

  return params;
}

/**
 * Parse a single parameter
 */
function parseParam(paramStr) {
  // Handle: name, name: type, name = default, name: type = default, *args, **kwargs
  const match = paramStr.match(/^(\*{0,2})(\w+)(?:\s*:\s*([^=]+))?(?:\s*=\s*(.+))?$/);
  if (match) {
    return {
      name: match[2],
      type: match[3]?.trim() || null,
      default: match[4]?.trim() || null,
      isVararg: match[1] === '*',
      isKwarg: match[1] === '**'
    };
  }
  return { name: paramStr, type: null };
}

/**
 * Find end of indented block
 */
function findIndentBlockEnd(lines, startIndex, baseIndent) {
  const firstLine = lines[startIndex];
  const firstIndent = firstLine.match(/^(\s*)/)[1].length;

  // If we're looking for module-level block end, use the function's indent
  const targetIndent = baseIndent === 0 ? firstIndent : baseIndent;

  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];

    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) {
      continue;
    }

    // Check indent
    const indent = line.match(/^(\s*)/)[1].length;

    // If we find a line with less or equal indent (for non-module level)
    // or less indent (for module level), block ends
    if (baseIndent === 0) {
      // Module-level function: ends when we see another module-level statement
      if (indent === 0 && line.trim()) {
        return i;
      }
    } else {
      // Class/nested: ends when we see something at class level or less
      if (indent <= targetIndent && line.trim()) {
        return i;
      }
    }
  }

  return lines.length;
}

/**
 * Extract code between line numbers
 */
function extractCode(content, startLine, endLine) {
  const lines = content.split('\n');
  return lines.slice(startLine - 1, endLine).join('\n');
}

/**
 * Create empty result
 */
function createEmptyResult(filePath, relativePath, error) {
  return {
    file: { path: filePath, relativePath },
    content: '',
    functions: [],
    classes: [],
    exports: [],
    imports: [],
    annotations: [],
    lines: 0,
    size: 0,
    error,
    parseMethod: 'none'
  };
}

/**
 * Check if a Python class is a framework component
 */
export function isFrameworkComponent(classInfo, parseResult) {
  // Django Model
  if (classInfo.baseClasses.some(b => b.includes('Model') || b.includes('models.Model'))) {
    return { is: true, framework: 'django', type: 'model' };
  }

  // Django View
  if (classInfo.baseClasses.some(b =>
    b.includes('View') || b.includes('APIView') || b.includes('ViewSet') ||
    b.includes('GenericAPIView') || b.includes('ModelViewSet')
  )) {
    return { is: true, framework: 'django', type: 'view' };
  }

  // Django Admin
  if (classInfo.baseClasses.some(b => b.includes('ModelAdmin') || b.includes('admin.ModelAdmin'))) {
    return { is: true, framework: 'django', type: 'admin' };
  }

  // Django Form
  if (classInfo.baseClasses.some(b =>
    b.includes('Form') || b.includes('ModelForm') || b.includes('forms.Form')
  )) {
    return { is: true, framework: 'django', type: 'form' };
  }

  // FastAPI/Flask router decorators on functions
  for (const decorator of classInfo.decorators || []) {
    if (decorator.name.includes('router.') || decorator.name.includes('app.')) {
      return { is: true, framework: 'fastapi', type: 'route' };
    }
  }

  return { is: false };
}

/**
 * Check if a Python file is an entry point
 */
export function isEntryPoint(parseResult) {
  // Has if __name__ == "__main__"
  if (parseResult.metadata?.hasMainBlock) {
    return { isEntry: true, reason: 'Has __main__ block' };
  }

  // Django manage.py style
  const fileName = parseResult.file?.relativePath || '';
  if (fileName.endsWith('manage.py')) {
    return { isEntry: true, reason: 'Is Django manage.py' };
  }

  // Django wsgi.py/asgi.py
  if (fileName.endsWith('wsgi.py') || fileName.endsWith('asgi.py')) {
    return { isEntry: true, reason: 'Is WSGI/ASGI entry point' };
  }

  // Celery tasks are entry points (executed by worker)
  if (parseResult.metadata?.isCelery) {
    return { isEntry: true, reason: 'Has Celery task decorators' };
  }

  return { isEntry: false };
}

export default {
  parse,
  isFrameworkComponent,
  isEntryPoint
};
