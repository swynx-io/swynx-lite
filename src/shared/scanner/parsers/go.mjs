// src/scanner/parsers/go.mjs
// Go parser with Wire, Fx, Dig DI framework support

import { readFileSync, existsSync } from 'fs';

/**
 * Parse a Go file and extract functions, types, imports
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
    const classes = [];  // Structs and interfaces in Go
    const exports = [];
    const imports = [];
    let packageName = null;

    // Extract package declaration
    const packageMatch = content.match(/^\s*package\s+(\w+)/m);
    if (packageMatch) {
      packageName = packageMatch[1];
    }

    // Extract imports
    // Single import: import "fmt"
    // Multiple imports: import ( "fmt" \n "os" )
    const singleImportPattern = /^\s*import\s+"([^"]+)"/gm;
    let match;
    while ((match = singleImportPattern.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      imports.push({
        module: match[1],
        type: 'single',
        line: lineNum
      });
    }

    // Multi-import block
    const importBlockMatch = content.match(/import\s*\(([\s\S]*?)\)/);
    if (importBlockMatch) {
      const blockStart = content.indexOf(importBlockMatch[0]);
      const blockLines = importBlockMatch[1].split('\n');
      let blockLineNum = content.substring(0, blockStart).split('\n').length;

      for (const importLine of blockLines) {
        blockLineNum++;
        const importMatch = importLine.match(/^\s*(?:(\w+)\s+)?["']([^"']+)["']/);
        if (importMatch) {
          imports.push({
            module: importMatch[2],
            alias: importMatch[1] || null,
            type: 'block',
            line: blockLineNum
          });
        }
      }
    }

    // Parse functions and methods
    const funcPattern = /^func\s+(?:\(([^)]+)\)\s+)?(\w+)\s*\(([^)]*)\)(?:\s*\(([^)]*)\)|\s*(\w+))?/gm;
    while ((match = funcPattern.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      const receiver = match[1] || null;
      const funcName = match[2];
      const params = match[3] || '';
      const returnType = match[4] || match[5] || null;

      const funcInfo = {
        name: funcName,
        type: receiver ? 'method' : 'function',
        receiver: receiver ? parseReceiver(receiver) : null,
        line: lineNum,
        endLine: findBlockEnd(lines, lineNum - 1),
        params: parseGoParams(params),
        returnType,
        signature: `func ${receiver ? `(${receiver}) ` : ''}${funcName}(${params})`,
        exported: funcName[0] === funcName[0].toUpperCase()  // Exported if starts with uppercase
      };

      funcInfo.lineCount = funcInfo.endLine - funcInfo.line + 1;

      // Check for main function
      if (funcName === 'main' && packageName === 'main' && !receiver) {
        funcInfo.isMainFunction = true;
      }

      // Check for init function
      if (funcName === 'init' && !receiver) {
        funcInfo.isInitFunction = true;
      }

      functions.push(funcInfo);

      // Add method to corresponding struct
      if (receiver && classes.length > 0) {
        const receiverType = funcInfo.receiver?.type?.replace('*', '');
        const struct = classes.find(c => c.name === receiverType);
        if (struct) {
          struct.methods.push(funcInfo);
        }
      }
    }

    // Parse struct types
    const structPattern = /^type\s+(\w+)\s+struct\s*\{/gm;
    while ((match = structPattern.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      const structName = match[1];

      const structInfo = {
        name: structName,
        type: 'struct',
        line: lineNum,
        endLine: findBlockEnd(lines, lineNum - 1),
        fields: [],
        methods: [],
        exported: structName[0] === structName[0].toUpperCase()
      };

      structInfo.lineCount = structInfo.endLine - structInfo.line + 1;

      // Parse fields
      parseStructFields(lines, structInfo);

      // Find methods already parsed
      structInfo.methods = functions.filter(f =>
        f.receiver?.type?.replace('*', '') === structName
      );

      classes.push(structInfo);
    }

    // Parse interface types
    const interfacePattern = /^type\s+(\w+)\s+interface\s*\{/gm;
    while ((match = interfacePattern.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      const interfaceName = match[1];

      const interfaceInfo = {
        name: interfaceName,
        type: 'interface',
        line: lineNum,
        endLine: findBlockEnd(lines, lineNum - 1),
        methods: [],
        exported: interfaceName[0] === interfaceName[0].toUpperCase()
      };

      interfaceInfo.lineCount = interfaceInfo.endLine - interfaceInfo.line + 1;

      // Parse interface methods
      parseInterfaceMethods(lines, interfaceInfo);

      classes.push(interfaceInfo);
    }

    // Determine exports (public functions, types, and constants)
    exports.push(
      ...functions.filter(f => f.exported && !f.receiver).map(f => ({
        name: f.name,
        type: 'function',
        line: f.line
      })),
      ...classes.filter(c => c.exported).map(c => ({
        name: c.name,
        type: c.type,
        line: c.line
      }))
    );

    // Parse const and var declarations
    const constPattern = /^(?:const|var)\s+(\w+)\s+/gm;
    while ((match = constPattern.exec(content)) !== null) {
      const name = match[1];
      if (name[0] === name[0].toUpperCase()) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        exports.push({
          name,
          type: 'const/var',
          line: lineNum
        });
      }
    }

    // Check for DI framework usage
    const usesWire = content.includes('wire.Build') || content.includes('wire.NewSet');
    const usesFx = content.includes('fx.New') || content.includes('fx.Provide');
    const usesDig = content.includes('dig.New') || content.includes('container.Provide');

    return {
      file: { path: filePath, relativePath },
      content,
      functions,
      classes,
      exports,
      imports,
      annotations: [],  // Go doesn't have decorators
      lines: lines.length,
      size: content.length,
      parseMethod: 'go-regex',
      metadata: {
        packageName,
        hasMainFunction: functions.some(f => f.isMainFunction),
        hasInitFunction: functions.some(f => f.isInitFunction),
        isMainPackage: packageName === 'main',
        usesWire,
        usesFx,
        usesDig,
        isTestFile: relativePath.endsWith('_test.go')
      }
    };

  } catch (error) {
    return createEmptyResult(filePath, relativePath, `Parse error: ${error.message}`);
  }
}

/**
 * Parse method receiver
 */
function parseReceiver(receiver) {
  const match = receiver.match(/(\w+)\s+([\w*]+)/);
  if (match) {
    return {
      name: match[1],
      type: match[2]
    };
  }
  return { name: '', type: receiver.trim() };
}

/**
 * Parse Go function parameters
 */
function parseGoParams(paramsStr) {
  if (!paramsStr || !paramsStr.trim()) return [];

  const params = [];
  let current = '';
  let depth = 0;

  for (const char of paramsStr) {
    if (char === '[' || char === '(' || char === '{') depth++;
    else if (char === ']' || char === ')' || char === '}') depth--;
    else if (char === ',' && depth === 0) {
      if (current.trim()) {
        params.push(parseGoParam(current.trim()));
      }
      current = '';
      continue;
    }
    current += char;
  }

  if (current.trim()) {
    params.push(parseGoParam(current.trim()));
  }

  return params;
}

/**
 * Parse a single Go parameter
 */
function parseGoParam(paramStr) {
  // Handle: name type, name, name ...type
  const parts = paramStr.trim().split(/\s+/);
  if (parts.length >= 2) {
    return {
      name: parts[0],
      type: parts.slice(1).join(' ')
    };
  }
  return { name: '', type: parts[0] };
}

/**
 * Parse struct fields
 */
function parseStructFields(lines, structInfo) {
  for (let i = structInfo.line; i < structInfo.endLine - 1 && i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip empty lines, comments, and the struct declaration itself
    if (!line || line.startsWith('//') || line.startsWith('/*') || line === '{') {
      continue;
    }

    // Field pattern: Name Type `json:"name"`
    const fieldMatch = line.match(/^(\w+)\s+([\w*\[\].]+)(?:\s+`([^`]+)`)?/);
    if (fieldMatch) {
      structInfo.fields.push({
        name: fieldMatch[1],
        type: fieldMatch[2],
        tags: fieldMatch[3] || null,
        exported: fieldMatch[1][0] === fieldMatch[1][0].toUpperCase()
      });
    }

    // Embedded type: *EmbeddedStruct
    const embeddedMatch = line.match(/^\*?(\w+)$/);
    if (embeddedMatch) {
      structInfo.fields.push({
        name: embeddedMatch[1],
        type: embeddedMatch[1],
        embedded: true
      });
    }
  }
}

/**
 * Parse interface methods
 */
function parseInterfaceMethods(lines, interfaceInfo) {
  for (let i = interfaceInfo.line; i < interfaceInfo.endLine - 1 && i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line || line.startsWith('//') || line === '{') continue;

    // Method pattern: MethodName(params) (returns)
    const methodMatch = line.match(/^(\w+)\s*\(([^)]*)\)(?:\s*\(([^)]*)\)|\s*(\w+))?/);
    if (methodMatch) {
      interfaceInfo.methods.push({
        name: methodMatch[1],
        params: parseGoParams(methodMatch[2]),
        returnType: methodMatch[3] || methodMatch[4] || null
      });
    }
  }
}

/**
 * Find end of a block (matching braces)
 */
function findBlockEnd(lines, startIndex) {
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
  }

  return startIndex + 1;
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
 * Check if a Go file is an entry point
 */
export function isEntryPoint(parseResult) {
  // main package with main function
  if (parseResult.metadata?.isMainPackage && parseResult.metadata?.hasMainFunction) {
    return { isEntry: true, reason: 'Is main package with main()' };
  }

  // Test files
  if (parseResult.metadata?.isTestFile) {
    return { isEntry: true, reason: 'Is test file' };
  }

  // Wire, Fx, Dig providers are entry points for DI
  if (parseResult.metadata?.usesWire || parseResult.metadata?.usesFx || parseResult.metadata?.usesDig) {
    return { isEntry: true, reason: 'Uses DI framework (Wire/Fx/Dig)' };
  }

  return { isEntry: false };
}

/**
 * Check if a struct/type has DI registrations
 */
export function hasDIRegistration(parseResult, typeName) {
  const content = parseResult.content || '';

  // Check for Wire providers
  if (content.includes(`wire.Struct(new(${typeName})`) ||
      content.includes(`wire.Bind(new(${typeName})`)) {
    return { hasDI: true, framework: 'wire' };
  }

  // Check for Fx provides
  if (content.includes(`fx.Provide(New${typeName}`) ||
      content.includes(`fx.Provide(func() *${typeName}`)) {
    return { hasDI: true, framework: 'fx' };
  }

  // Check for Dig provides
  if (content.includes(`Provide(func() *${typeName}`)) {
    return { hasDI: true, framework: 'dig' };
  }

  return { hasDI: false };
}

export default {
  parse,
  isEntryPoint,
  hasDIRegistration
};
