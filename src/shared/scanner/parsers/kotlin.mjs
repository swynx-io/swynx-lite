// src/scanner/parsers/kotlin.mjs
// Kotlin parser with Spring Boot annotation support

import { readFileSync, existsSync } from 'fs';

/**
 * Parse a Kotlin file and extract classes, functions, annotations, imports
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
    const annotations = [];
    const imports = [];
    let packageName = null;

    // Extract package declaration
    const packageMatch = content.match(/^\s*package\s+([\w.]+)/m);
    if (packageMatch) {
      packageName = packageMatch[1];
    }

    // Extract imports
    const importPattern = /^\s*import\s+([\w.*]+)(?:\s+as\s+(\w+))?/gm;
    let importMatch;
    while ((importMatch = importPattern.exec(content)) !== null) {
      const lineNum = content.substring(0, importMatch.index).split('\n').length;
      imports.push({
        module: importMatch[1],
        alias: importMatch[2] || null,
        type: 'normal',
        line: lineNum
      });
    }

    // Track annotations on current element
    let pendingAnnotations = [];

    // Parse line by line
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Detect annotations
      const annotationPattern = /@(\w+)(?:\s*\(([^)]*)\))?/g;
      let annotationMatch;
      while ((annotationMatch = annotationPattern.exec(line)) !== null) {
        const annotation = {
          name: annotationMatch[1],
          args: annotationMatch[2] || null,
          line: lineNum
        };
        annotations.push(annotation);
        pendingAnnotations.push(annotation);
      }

      // Detect class/interface/object declaration
      const classMatch = line.match(/^\s*(public|private|protected|internal)?\s*(open|abstract|sealed|final|data|enum|annotation)?\s*(class|interface|object)\s+(\w+)(?:<[^>]+>)?(?:\s*:\s*([^{]+))?/);
      if (classMatch) {
        const classInfo = {
          name: classMatch[4],
          type: classMatch[3],
          visibility: classMatch[1] || 'public',
          modifiers: classMatch[2] ? [classMatch[2]] : [],
          line: lineNum,
          endLine: findBlockEnd(lines, i),
          superTypes: classMatch[5] ? classMatch[5].split(',').map(s => s.trim().split('(')[0].trim()) : [],
          decorators: [...pendingAnnotations],
          annotations: [...pendingAnnotations],
          methods: [],
          exported: classMatch[1] !== 'private' && classMatch[1] !== 'internal'
        };

        classInfo.lineCount = classInfo.endLine - classInfo.line + 1;
        classInfo.sizeBytes = extractCode(content, classInfo.line, classInfo.endLine).length;

        classes.push(classInfo);
        pendingAnnotations = [];
      }

      // Detect function declaration
      const funcMatch = line.match(/^\s*(public|private|protected|internal)?\s*(open|override|final|suspend)?\s*fun\s+(?:<[^>]+>\s+)?(\w+)\s*\(([^)]*)\)(?:\s*:\s*([\w<>,\s?*]+))?/);
      if (funcMatch) {
        const funcInfo = {
          name: funcMatch[3],
          type: funcMatch[2] === 'suspend' ? 'suspend function' : 'function',
          visibility: funcMatch[1] || 'public',
          modifiers: funcMatch[2] ? [funcMatch[2]] : [],
          line: lineNum,
          endLine: findBlockEnd(lines, i),
          params: parseParams(funcMatch[4]),
          returnType: funcMatch[5]?.trim() || null,
          decorators: [...pendingAnnotations],
          annotations: [...pendingAnnotations],
          signature: `fun ${funcMatch[3]}(${funcMatch[4]})`
        };

        funcInfo.lineCount = funcInfo.endLine - funcInfo.line + 1;
        funcInfo.sizeBytes = extractCode(content, funcInfo.line, funcInfo.endLine).length;

        // Check for main function
        if (funcMatch[3] === 'main') {
          funcInfo.isMainFunction = true;
        }

        functions.push(funcInfo);

        // Add to current class if we're inside one
        if (classes.length > 0) {
          const currentClass = classes[classes.length - 1];
          if (lineNum > currentClass.line && lineNum < currentClass.endLine) {
            currentClass.methods.push(funcInfo);
          }
        }

        pendingAnnotations = [];
      }

      // Clear pending annotations if we hit a non-annotation line
      if (line.trim() && !line.trim().startsWith('@') && !line.trim().startsWith('//') && !line.trim().startsWith('/*')) {
        if (!classMatch && !funcMatch) {
          pendingAnnotations = [];
        }
      }
    }

    // Determine exports (public classes and functions)
    const exports = [
      ...classes.filter(c => c.exported).map(c => ({
        name: c.name,
        type: c.type,
        line: c.line
      })),
      ...functions.filter(f => f.visibility !== 'private' && f.visibility !== 'internal').map(f => ({
        name: f.name,
        type: 'function',
        line: f.line
      }))
    ];

    return {
      file: { path: filePath, relativePath },
      content,
      functions,
      classes,
      exports,
      imports,
      annotations,
      lines: lines.length,
      size: content.length,
      parseMethod: 'kotlin-regex',
      metadata: {
        packageName,
        hasMainFunction: functions.some(f => f.isMainFunction),
        isSpringComponent: annotations.some(a =>
          ['Component', 'Service', 'Repository', 'Controller', 'RestController', 'Configuration', 'SpringBootApplication',
           'ApplicationScoped', 'RequestScoped', 'SessionScoped', 'Dependent', 'Singleton', 'Named',
           'Stateless', 'Stateful', 'MessageDriven', 'Path', 'Provider',
           'QuarkusMain', 'Entity', 'MappedSuperclass', 'Converter'].includes(a.name)
        )
      }
    };

  } catch (error) {
    return createEmptyResult(filePath, relativePath, `Parse error: ${error.message}`);
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
    if (char === '<' || char === '(') depth++;
    else if (char === '>' || char === ')') depth--;
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
  // Handle: name: Type, name: Type = default, vararg name: Type
  const match = paramStr.match(/^(vararg\s+)?(\w+)\s*:\s*(.+?)(?:\s*=\s*(.+))?$/);
  if (match) {
    return {
      name: match[2],
      type: match[3].trim(),
      default: match[4]?.trim() || null,
      isVararg: !!match[1]
    };
  }
  return { name: paramStr, type: null };
}

/**
 * Find end of a code block (matching braces)
 */
function findBlockEnd(lines, startIndex) {
  let braceCount = 0;
  let started = false;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];

    let inString = false;
    let stringChar = '';

    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      const nextChar = line[j + 1];

      if (!inString && (char === '"' || char === "'")) {
        inString = true;
        stringChar = char;
        continue;
      }
      if (inString && char === stringChar && line[j - 1] !== '\\') {
        inString = false;
        continue;
      }
      if (inString) continue;

      if (char === '/' && nextChar === '/') break;

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
  }

  return startIndex + 1;
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
 * Check if a Kotlin class has Spring/DI annotations
 */
export function hasDIAnnotations(classInfo, diAnnotations = []) {
  const defaultAnnotations = [
    'Component', 'Service', 'Repository', 'Controller', 'RestController',
    'Configuration', 'Bean', 'SpringBootApplication',
    'Inject', 'Singleton', 'Module', 'Provides'
  ];

  const checkAnnotations = new Set([...defaultAnnotations, ...diAnnotations]);
  const classAnnotations = (classInfo.annotations || classInfo.decorators || []).map(a => a.name);

  const matched = classAnnotations.filter(a => checkAnnotations.has(a));

  return {
    hasDI: matched.length > 0,
    annotations: matched
  };
}

/**
 * Check if a Kotlin file is an entry point
 */
export function isEntryPoint(parseResult) {
  // Check for main function
  if (parseResult.metadata?.hasMainFunction) {
    return { isEntry: true, reason: 'Has fun main()' };
  }

  // Check for @SpringBootApplication
  if (parseResult.metadata?.isSpringComponent) {
    const springApp = parseResult.annotations.find(a => a.name === 'SpringBootApplication');
    if (springApp) {
      return { isEntry: true, reason: 'Has @SpringBootApplication annotation' };
    }
  }

  return { isEntry: false };
}

export default {
  parse,
  hasDIAnnotations,
  isEntryPoint
};
