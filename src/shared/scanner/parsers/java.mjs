// src/scanner/parsers/java.mjs
// Java/JVM parser with Spring, Guice, Dagger annotation support

import { readFileSync, existsSync } from 'fs';

/**
 * Parse a Java file and extract classes, methods, annotations, imports
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
    const packageMatch = content.match(/^\s*package\s+([\w.]+)\s*;/m);
    if (packageMatch) {
      packageName = packageMatch[1];
    }

    // Extract imports
    const importPattern = /^\s*import\s+(static\s+)?([\w.*]+)\s*;/gm;
    let importMatch;
    while ((importMatch = importPattern.exec(content)) !== null) {
      const lineNum = content.substring(0, importMatch.index).split('\n').length;
      imports.push({
        module: importMatch[2],
        type: importMatch[1] ? 'static' : 'normal',
        line: lineNum
      });
    }

    // Track annotations on current element
    let pendingAnnotations = [];

    // Parse line by line for better accuracy
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

      // Detect class declaration
      const classMatch = line.match(/^\s*(public|private|protected)?\s*(abstract|final|static)?\s*(class|interface|enum|record)\s+(\w+)(?:<[^>]+>)?(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?/);
      if (classMatch) {
        const classInfo = {
          name: classMatch[4],
          type: classMatch[3],  // class, interface, enum, record
          visibility: classMatch[1] || 'package-private',
          modifiers: classMatch[2] ? [classMatch[2]] : [],
          line: lineNum,
          endLine: findBlockEnd(lines, i),
          superClass: classMatch[5] || null,
          interfaces: classMatch[6] ? classMatch[6].split(',').map(s => s.trim()) : [],
          decorators: [...pendingAnnotations],  // Use same field name as JS for consistency
          annotations: [...pendingAnnotations],
          methods: [],
          exported: classMatch[1] === 'public'
        };

        classInfo.lineCount = classInfo.endLine - classInfo.line + 1;
        classInfo.sizeBytes = extractCode(content, classInfo.line, classInfo.endLine).length;

        classes.push(classInfo);
        pendingAnnotations = [];
      }

      // Detect method declaration
      const methodMatch = line.match(/^\s*(public|private|protected)?\s*(static|final|abstract|synchronized|native)?\s*(?:<[\w\s,<>?]+>\s+)?(\w+(?:<[\w\s,<>?]+>)?(?:\[\])?)\s+(\w+)\s*\(([^)]*)\)/);
      if (methodMatch && !line.includes(' class ') && !line.includes(' interface ') && !line.includes(' new ')) {
        const methodInfo = {
          name: methodMatch[4],
          type: 'method',
          visibility: methodMatch[1] || 'package-private',
          modifiers: methodMatch[2] ? [methodMatch[2]] : [],
          returnType: methodMatch[3],
          params: parseParams(methodMatch[5]),
          line: lineNum,
          endLine: findBlockEnd(lines, i),
          decorators: [...pendingAnnotations],
          annotations: [...pendingAnnotations],
          signature: `${methodMatch[3]} ${methodMatch[4]}(${methodMatch[5]})`
        };

        methodInfo.lineCount = methodInfo.endLine - methodInfo.line + 1;
        methodInfo.sizeBytes = extractCode(content, methodInfo.line, methodInfo.endLine).length;

        // Check if it's a main method
        if (methodMatch[4] === 'main' && methodMatch[2] === 'static' && methodMatch[1] === 'public') {
          methodInfo.isMainMethod = true;
        }

        functions.push(methodInfo);

        // Add to current class if we're inside one
        if (classes.length > 0) {
          const currentClass = classes[classes.length - 1];
          if (lineNum > currentClass.line && lineNum < currentClass.endLine) {
            currentClass.methods.push(methodInfo);
          }
        }

        pendingAnnotations = [];
      }

      // Clear pending annotations if we hit a non-annotation line that isn't whitespace
      if (line.trim() && !line.trim().startsWith('@') && !line.trim().startsWith('//') && !line.trim().startsWith('/*')) {
        if (!classMatch && !methodMatch) {
          pendingAnnotations = [];
        }
      }
    }

    // Determine exports (public classes in Java)
    const exports = classes
      .filter(c => c.exported)
      .map(c => ({
        name: c.name,
        type: c.type,
        line: c.line
      }));

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
      parseMethod: 'java-regex',
      metadata: {
        packageName,
        hasMainMethod: functions.some(f => f.isMainMethod),
        isSpringComponent: annotations.some(a =>
          ['Component', 'Service', 'Repository', 'Controller', 'RestController', 'Configuration', 'SpringBootApplication',
           'ApplicationScoped', 'RequestScoped', 'SessionScoped', 'Dependent', 'Singleton', 'Named',
           'Stateless', 'Stateful', 'MessageDriven', 'Path', 'Provider',
           'QuarkusMain', 'Entity', 'MappedSuperclass', 'Converter',
           'BuildStep', 'BuildSteps', 'Recorder'].includes(a.name)
        )
      }
    };

  } catch (error) {
    return createEmptyResult(filePath, relativePath, `Parse error: ${error.message}`);
  }
}

/**
 * Parse method parameters
 */
function parseParams(paramsStr) {
  if (!paramsStr || !paramsStr.trim()) return [];

  const params = [];
  // Simple split by comma, accounting for generics
  let depth = 0;
  let current = '';

  for (const char of paramsStr) {
    if (char === '<') depth++;
    else if (char === '>') depth--;
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
  // Remove annotations
  const withoutAnnotations = paramStr.replace(/@\w+(?:\([^)]*\))?\s*/g, '');
  const parts = withoutAnnotations.trim().split(/\s+/);

  if (parts.length >= 2) {
    return {
      type: parts.slice(0, -1).join(' '),
      name: parts[parts.length - 1]
    };
  }
  return { type: paramStr, name: '' };
}

/**
 * Find the end of a code block (matching braces)
 */
function findBlockEnd(lines, startIndex) {
  let braceCount = 0;
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

      // Handle single-line comments
      if (char === '/' && nextChar === '/') break;

      // Count braces
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
    annotations: [],
    lines: 0,
    size: 0,
    error,
    parseMethod: 'none'
  };
}

/**
 * Check if a Java class has Spring/DI annotations
 * @param {Object} classInfo - Parsed class info
 * @param {string[]} diAnnotations - List of DI annotation names
 * @returns {Object} - { hasDI: boolean, annotations: string[] }
 */
export function hasDIAnnotations(classInfo, diAnnotations = []) {
  const defaultAnnotations = [
    'Component', 'Service', 'Repository', 'Controller', 'RestController',
    'Configuration', 'Bean', 'SpringBootApplication',
    'Inject', 'Singleton', 'Module', 'Provides',
    'Named', 'ApplicationScoped', 'RequestScoped'
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
 * Check if a Java file is an entry point
 * @param {Object} parseResult - Parse result from parse()
 * @returns {Object} - { isEntry: boolean, reason: string }
 */
export function isEntryPoint(parseResult) {
  // Check for main method
  if (parseResult.metadata?.hasMainMethod) {
    return { isEntry: true, reason: 'Has public static void main()' };
  }

  // Check for @SpringBootApplication
  if (parseResult.metadata?.isSpringComponent) {
    const springApp = parseResult.annotations.find(a => a.name === 'SpringBootApplication');
    if (springApp) {
      return { isEntry: true, reason: 'Has @SpringBootApplication annotation' };
    }
  }

  // Check for servlet annotations
  const servletAnnotations = ['WebServlet', 'WebFilter', 'WebListener'];
  const hasServlet = parseResult.annotations.some(a => servletAnnotations.includes(a.name));
  if (hasServlet) {
    return { isEntry: true, reason: 'Has servlet annotation' };
  }

  return { isEntry: false };
}

export default {
  parse,
  hasDIAnnotations,
  isEntryPoint
};
