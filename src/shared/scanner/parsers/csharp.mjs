// src/scanner/parsers/csharp.mjs
// C#/.NET parser with ASP.NET Core, Entity Framework support

import { readFileSync, existsSync } from 'fs';

/**
 * Parse a C# file and extract classes, methods, attributes, usings
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
    const annotations = [];  // Called 'attributes' in C#
    const imports = [];      // Called 'usings' in C#
    let namespace = null;

    // Extract namespace
    const namespaceMatch = content.match(/^\s*namespace\s+([\w.]+)/m);
    if (namespaceMatch) {
      namespace = namespaceMatch[1];
    }

    // File-scoped namespace (C# 10+)
    const fileScopedNsMatch = content.match(/^\s*namespace\s+([\w.]+)\s*;/m);
    if (fileScopedNsMatch) {
      namespace = fileScopedNsMatch[1];
    }

    // Extract using statements
    const usingPattern = /^\s*using\s+(static\s+)?(global\s+)?([\w.]+)(?:\s*=\s*([\w.]+))?\s*;/gm;
    let usingMatch;
    while ((usingMatch = usingPattern.exec(content)) !== null) {
      const lineNum = content.substring(0, usingMatch.index).split('\n').length;
      imports.push({
        module: usingMatch[3],
        alias: usingMatch[4] || null,
        type: usingMatch[1] ? 'static' : (usingMatch[2] ? 'global' : 'normal'),
        line: lineNum
      });
    }

    // Track attributes on current element
    let pendingAttributes = [];

    // Parse line by line
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Detect attributes [Attribute] or [Attribute(args)]
      const attributePattern = /\[(\w+)(?:\s*\(([^)\]]*)\))?\]/g;
      let attrMatch;
      while ((attrMatch = attributePattern.exec(line)) !== null) {
        const attr = {
          name: attrMatch[1],
          args: attrMatch[2] || null,
          line: lineNum
        };
        annotations.push(attr);
        pendingAttributes.push(attr);
      }

      // Detect class/struct/interface/record declaration
      const classMatch = line.match(/^\s*(public|private|protected|internal)?\s*(sealed|abstract|static|partial)?\s*(class|struct|interface|record)\s+(\w+)(?:<[^>]+>)?(?:\s*:\s*([\w<>,\s]+))?/);
      if (classMatch) {
        const baseTypes = classMatch[5] ? classMatch[5].split(',').map(s => s.trim()) : [];

        const classInfo = {
          name: classMatch[4],
          type: classMatch[3],  // class, struct, interface, record
          visibility: classMatch[1] || 'internal',
          modifiers: classMatch[2] ? classMatch[2].split(/\s+/).filter(m => m) : [],
          line: lineNum,
          endLine: findBlockEnd(lines, i),
          baseTypes,
          decorators: [...pendingAttributes],
          attributes: [...pendingAttributes],
          methods: [],
          properties: [],
          exported: ['public', 'protected', 'internal'].includes(classMatch[1])
        };

        classInfo.lineCount = classInfo.endLine - classInfo.line + 1;
        classInfo.sizeBytes = extractCode(content, classInfo.line, classInfo.endLine).length;

        classes.push(classInfo);
        pendingAttributes = [];
      }

      // Detect method declaration
      const methodMatch = line.match(/^\s*(public|private|protected|internal)?\s*(static|virtual|override|abstract|async|sealed)?\s*(?:([\w<>[\],?\s]+)\s+)?(\w+)\s*\(([^)]*)\)/);
      if (methodMatch && !line.includes(' class ') && !line.includes(' struct ') && !line.includes(' new ') && !line.includes(' => ')) {
        const methodInfo = {
          name: methodMatch[4],
          type: 'method',
          visibility: methodMatch[1] || 'private',
          modifiers: methodMatch[2] ? [methodMatch[2]] : [],
          returnType: methodMatch[3]?.trim() || 'void',
          params: parseParams(methodMatch[5]),
          line: lineNum,
          endLine: findMethodEnd(lines, i),
          decorators: [...pendingAttributes],
          attributes: [...pendingAttributes],
          signature: `${methodMatch[3] || 'void'} ${methodMatch[4]}(${methodMatch[5]})`
        };

        // Check for Main method
        if (methodMatch[4] === 'Main' && (methodMatch[2] === 'static' || line.includes('static'))) {
          methodInfo.isMainMethod = true;
        }

        // Check for async Main
        if (methodMatch[4] === 'Main' && methodMatch[2] === 'async') {
          methodInfo.isMainMethod = true;
        }

        functions.push(methodInfo);

        // Add to current class
        if (classes.length > 0) {
          const currentClass = classes[classes.length - 1];
          if (lineNum > currentClass.line && lineNum < currentClass.endLine) {
            currentClass.methods.push(methodInfo);
          }
        }

        pendingAttributes = [];
      }

      // Detect properties
      const propMatch = line.match(/^\s*(public|private|protected|internal)?\s*(static|virtual|override|abstract)?\s*([\w<>[\],?\s]+)\s+(\w+)\s*\{/);
      if (propMatch && !line.includes('(') && !line.includes(' class ')) {
        const propInfo = {
          name: propMatch[4],
          type: propMatch[3]?.trim(),
          visibility: propMatch[1] || 'private',
          line: lineNum,
          attributes: [...pendingAttributes]
        };

        if (classes.length > 0) {
          const currentClass = classes[classes.length - 1];
          if (lineNum > currentClass.line && lineNum < currentClass.endLine) {
            currentClass.properties.push(propInfo);
          }
        }

        pendingAttributes = [];
      }

      // Clear pending attributes
      if (line.trim() && !line.trim().startsWith('[') && !line.trim().startsWith('//') && !line.trim().startsWith('/*')) {
        if (!classMatch && !methodMatch && !propMatch) {
          pendingAttributes = [];
        }
      }
    }

    // Check for top-level statements (C# 9+)
    const hasTopLevelStatements = !content.match(/^\s*(namespace|class|interface|struct|record)\s+\w+/m) &&
                                   content.match(/^\s*(var|await|Console|app\.|builder\.)/m);

    // Determine exports (public types)
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
      parseMethod: 'csharp-regex',
      metadata: {
        namespace,
        hasMainMethod: functions.some(f => f.isMainMethod),
        hasTopLevelStatements,
        isController: annotations.some(a =>
          ['Controller', 'ApiController', 'ControllerBase'].includes(a.name)
        ),
        isAspNetCore: annotations.some(a =>
          ['ApiController', 'Controller', 'HttpGet', 'HttpPost', 'Route', 'Authorize'].includes(a.name)
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
  let depth = 0;
  let current = '';

  for (const char of paramsStr) {
    if (char === '<' || char === '[') depth++;
    else if (char === '>' || char === ']') depth--;
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
  // Remove attributes
  const withoutAttrs = paramStr.replace(/\[\w+(?:\([^)]*\))?\]\s*/g, '');
  // Handle modifiers like 'out', 'ref', 'in', 'params'
  const parts = withoutAttrs.trim().split(/\s+/);

  // Find the name (last part) and type (everything before, excluding modifiers)
  const modifiers = ['out', 'ref', 'in', 'params', 'this'];
  let nameIndex = parts.length - 1;

  // Check for default value
  const defaultIdx = parts.findIndex(p => p.includes('='));
  if (defaultIdx !== -1) {
    nameIndex = defaultIdx - 1;
  }

  const name = parts[nameIndex] || '';
  const typeParts = parts.slice(0, nameIndex).filter(p => !modifiers.includes(p));

  return {
    type: typeParts.join(' '),
    name: name.replace(/\s*=.*$/, ''),
    modifiers: parts.filter(p => modifiers.includes(p))
  };
}

/**
 * Find the end of a code block
 */
function findBlockEnd(lines, startIndex) {
  let braceCount = 0;
  let started = false;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];

    for (let j = 0; j < line.length; j++) {
      const char = line[j];

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
 * Find the end of a method (handles expression-bodied members)
 */
function findMethodEnd(lines, startIndex) {
  const line = lines[startIndex];

  // Expression-bodied member: void Foo() => expr;
  if (line.includes('=>') && line.includes(';')) {
    return startIndex + 1;
  }

  // Abstract/interface method: void Foo();
  if (line.trim().endsWith(';')) {
    return startIndex + 1;
  }

  return findBlockEnd(lines, startIndex);
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
 * Check if a C# class has DI/framework attributes
 */
export function hasDIAttributes(classInfo, diAttributes = []) {
  const defaultAttributes = [
    'Controller', 'ApiController', 'ControllerBase',
    'Service', 'Scoped', 'Singleton', 'Transient',
    'Entity', 'Table', 'DbContext',
    'Injectable'
  ];

  const checkAttributes = new Set([...defaultAttributes, ...diAttributes]);
  const classAttrs = (classInfo.attributes || classInfo.decorators || []).map(a => a.name);

  const matched = classAttrs.filter(a => checkAttributes.has(a));

  return {
    hasDI: matched.length > 0,
    attributes: matched
  };
}

/**
 * Check if a C# file is an entry point
 */
export function isEntryPoint(parseResult) {
  // Main method
  if (parseResult.metadata?.hasMainMethod) {
    return { isEntry: true, reason: 'Has Main() method' };
  }

  // Top-level statements (C# 9+)
  if (parseResult.metadata?.hasTopLevelStatements) {
    return { isEntry: true, reason: 'Has top-level statements' };
  }

  // Program.cs or Startup.cs
  const fileName = parseResult.file?.relativePath || '';
  if (fileName.endsWith('Program.cs') || fileName.endsWith('Startup.cs')) {
    return { isEntry: true, reason: 'Is Program.cs or Startup.cs' };
  }

  return { isEntry: false };
}

export default {
  parse,
  hasDIAttributes,
  isEntryPoint
};
