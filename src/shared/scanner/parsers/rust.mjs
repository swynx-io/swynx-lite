// src/scanner/parsers/rust.mjs
// Rust parser with workspace and module support

import { readFileSync, existsSync } from 'fs';

/**
 * Parse a Rust file and extract functions, structs, traits, impl blocks, imports
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
    const classes = [];  // Structs, enums, traits
    const exports = [];
    const imports = [];
    const mods = [];  // Module declarations

    // Track attributes for next item
    let pendingAttributes = [];

    // Extract use statements
    const usePattern = /^\s*(?:pub\s+)?use\s+([\w:]+(?:::\{[^}]+\}|::\*)?)\s*;/gm;
    let match;
    while ((match = usePattern.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      imports.push({
        module: match[1],
        type: 'use',
        line: lineNum
      });
    }

    // Extract mod declarations (supports pub, pub(crate), pub(super), pub(in path))
    // Also handles attributes before mod: #[macro_use] mod foo; #[cfg(...)] mod bar;
    const modPattern = /^\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]+\))?\s+)?mod\s+(\w+)\s*[;{]/gm;
    while ((match = modPattern.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      mods.push({
        name: match[1],
        public: match[0].includes('pub'),
        line: lineNum
      });
    }

    // Extract #[path = "..."] mod declarations — custom file paths for modules
    // Pattern: #[path = "filename.rs"] mod name; or #[cfg_attr(..., path = "...")] mod name;
    const pathModPattern = /^\s*#\[(?:cfg_attr\([^,]+,\s*)?path\s*=\s*"([^"]+)"\)?\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]+\))?\s+)?mod\s+(\w+)\s*[;{]/gm;
    while ((match = pathModPattern.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      // Store path-remapped mod with the target filename
      const existing = mods.find(m => m.name === match[2] && m.line === lineNum);
      if (existing) {
        existing.pathOverride = match[1]; // e.g., "unix.rs", "windows/mod.rs"
      } else {
        mods.push({
          name: match[2],
          public: match[0].includes('pub'),
          line: lineNum,
          pathOverride: match[1]
        });
      }
    }

    // Parse line by line
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Detect attributes (#[...])
      const attrMatch = line.match(/^\s*#\[([^\]]+)\]/);
      if (attrMatch) {
        pendingAttributes.push({
          name: attrMatch[1],
          line: lineNum
        });
        continue;
      }

      // Detect function declaration
      const funcMatch = line.match(/^\s*(pub(?:\([^)]+\))?\s+)?(async\s+)?fn\s+(\w+)(?:<[^>]+>)?\s*\(([^)]*)\)(?:\s*->\s*([\w<>,\s&']+))?/);
      if (funcMatch) {
        const funcInfo = {
          name: funcMatch[3],
          type: funcMatch[2] ? 'async function' : 'function',
          visibility: funcMatch[1] ? 'public' : 'private',
          async: !!funcMatch[2],
          line: lineNum,
          endLine: findBlockEnd(lines, i),
          params: parseParams(funcMatch[4]),
          returnType: funcMatch[5]?.trim() || null,
          decorators: [...pendingAttributes],
          attributes: [...pendingAttributes],
          signature: `fn ${funcMatch[3]}(${funcMatch[4]})`,
          exported: !!funcMatch[1]
        };

        funcInfo.lineCount = funcInfo.endLine - funcInfo.line + 1;
        funcInfo.sizeBytes = extractCode(content, funcInfo.line, funcInfo.endLine).length;

        // Check for main function
        if (funcMatch[3] === 'main' && !funcMatch[1]) {
          funcInfo.isMainFunction = true;
        }

        functions.push(funcInfo);
        pendingAttributes = [];
      }

      // Detect struct declaration
      const structMatch = line.match(/^\s*(pub(?:\([^)]+\))?\s+)?struct\s+(\w+)(?:<[^>]+>)?/);
      if (structMatch) {
        const structInfo = {
          name: structMatch[2],
          type: 'struct',
          visibility: structMatch[1] ? 'public' : 'private',
          line: lineNum,
          endLine: findBlockEnd(lines, i),
          decorators: [...pendingAttributes],
          attributes: [...pendingAttributes],
          methods: [],
          exported: !!structMatch[1]
        };

        structInfo.lineCount = structInfo.endLine - structInfo.line + 1;
        structInfo.sizeBytes = extractCode(content, structInfo.line, structInfo.endLine).length;

        classes.push(structInfo);
        pendingAttributes = [];
      }

      // Detect enum declaration
      const enumMatch = line.match(/^\s*(pub(?:\([^)]+\))?\s+)?enum\s+(\w+)(?:<[^>]+>)?/);
      if (enumMatch) {
        const enumInfo = {
          name: enumMatch[2],
          type: 'enum',
          visibility: enumMatch[1] ? 'public' : 'private',
          line: lineNum,
          endLine: findBlockEnd(lines, i),
          decorators: [...pendingAttributes],
          attributes: [...pendingAttributes],
          exported: !!enumMatch[1]
        };

        enumInfo.lineCount = enumInfo.endLine - enumInfo.line + 1;
        enumInfo.sizeBytes = extractCode(content, enumInfo.line, enumInfo.endLine).length;

        classes.push(enumInfo);
        pendingAttributes = [];
      }

      // Detect trait declaration
      const traitMatch = line.match(/^\s*(pub(?:\([^)]+\))?\s+)?trait\s+(\w+)(?:<[^>]+>)?/);
      if (traitMatch) {
        const traitInfo = {
          name: traitMatch[2],
          type: 'trait',
          visibility: traitMatch[1] ? 'public' : 'private',
          line: lineNum,
          endLine: findBlockEnd(lines, i),
          decorators: [...pendingAttributes],
          attributes: [...pendingAttributes],
          methods: [],
          exported: !!traitMatch[1]
        };

        traitInfo.lineCount = traitInfo.endLine - traitInfo.line + 1;
        traitInfo.sizeBytes = extractCode(content, traitInfo.line, traitInfo.endLine).length;

        classes.push(traitInfo);
        pendingAttributes = [];
      }

      // Detect impl block
      const implMatch = line.match(/^\s*impl(?:<[^>]+>)?\s+(?:(\w+)\s+for\s+)?(\w+)(?:<[^>]+>)?/);
      if (implMatch && !line.includes('fn ')) {
        const implInfo = {
          name: implMatch[2],
          trait: implMatch[1] || null,
          type: 'impl',
          line: lineNum,
          endLine: findBlockEnd(lines, i),
          methods: []
        };

        // Find the struct/enum this impl is for and add methods
        const target = classes.find(c => c.name === implInfo.name);
        if (target) {
          // Parse impl methods would go here
        }

        pendingAttributes = [];
      }

      // Clear pending attributes if we hit something else
      if (line.trim() && !line.trim().startsWith('#[') && !line.trim().startsWith('//')) {
        if (!funcMatch && !structMatch && !enumMatch && !traitMatch && !implMatch) {
          pendingAttributes = [];
        }
      }
    }

    // Determine exports (public items)
    exports.push(
      ...functions.filter(f => f.exported).map(f => ({
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

    // Check if this is a main.rs or lib.rs
    const isMainFile = relativePath.endsWith('main.rs');
    const isLibFile = relativePath.endsWith('lib.rs');
    const isModFile = relativePath.endsWith('mod.rs');

    return {
      file: { path: filePath, relativePath },
      content,
      functions,
      classes,
      exports,
      imports,
      annotations: pendingAttributes,  // Rust uses attributes instead of annotations
      mods,
      lines: lines.length,
      size: content.length,
      parseMethod: 'rust-regex',
      metadata: {
        hasMainFunction: functions.some(f => f.isMainFunction),
        isMainFile,
        isLibFile,
        isModFile,
        isBinaryCrate: isMainFile && functions.some(f => f.isMainFunction),
        isLibraryCrate: isLibFile,
        publicMods: mods.filter(m => m.public).map(m => m.name),
        privateMods: mods.filter(m => !m.public).map(m => m.name)
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
    if (char === '<' || char === '(' || char === '[') depth++;
    else if (char === '>' || char === ')' || char === ']') depth--;
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
  // Handle: name: Type, &self, &mut self, mut name: Type
  if (paramStr === 'self' || paramStr === '&self' || paramStr === '&mut self') {
    return { name: 'self', type: 'self', isSelf: true };
  }

  const match = paramStr.match(/^(mut\s+)?(\w+)\s*:\s*(.+)$/);
  if (match) {
    return {
      name: match[2],
      type: match[3].trim(),
      mutable: !!match[1]
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

      if (!inString && char === '"') {
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
    mods: [],
    lines: 0,
    size: 0,
    error,
    parseMethod: 'none'
  };
}

/**
 * Check if a Rust file is an entry point
 */
export function isEntryPoint(parseResult) {
  // Binary crate with main function
  if (parseResult.metadata?.isBinaryCrate) {
    return { isEntry: true, reason: 'Is binary crate (main.rs with fn main)' };
  }

  // Library crate entry
  if (parseResult.metadata?.isLibraryCrate) {
    return { isEntry: true, reason: 'Is library crate entry (lib.rs)' };
  }

  // Test files
  const hasTestAttr = parseResult.functions.some(f =>
    f.attributes?.some(a => a.name.includes('test'))
  );
  if (hasTestAttr) {
    return { isEntry: true, reason: 'Has #[test] functions' };
  }

  return { isEntry: false };
}

/**
 * Check if module is publicly declared
 */
export function isPublicModule(parseResult, modName) {
  const mod = parseResult.mods?.find(m => m.name === modName);
  return mod?.public ?? false;
}

export default {
  parse,
  isEntryPoint,
  isPublicModule
};
