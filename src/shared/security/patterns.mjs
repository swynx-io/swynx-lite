// src/security/patterns.mjs
// CWE pattern definitions for security analysis across all code

/**
 * CWE patterns for detecting dangerous code patterns.
 * Each pattern has: id, cwe, cweName, severity, pattern (RegExp), description, risk, languages (empty = all)
 */
export const CWE_PATTERNS = [
  // ═══════════════════════════════════════════════════════════════════════════
  // CWE-78: OS Command Injection
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'CWE-78-exec',
    cwe: 'CWE-78',
    cweName: 'OS Command Injection',
    severity: 'CRITICAL',
    pattern: /child_process\.(exec|execSync)\s*\(/,
    description: 'child_process.exec() with potential command injection',
    risk: 'Dead code with command execution could be revived without security review',
    languages: ['js', 'ts']
  },
  {
    id: 'CWE-78-spawn-shell',
    cwe: 'CWE-78',
    cweName: 'OS Command Injection',
    severity: 'CRITICAL',
    pattern: /child_process\.spawn\s*\([^)]*shell\s*:\s*true/,
    description: 'child_process.spawn() with shell: true',
    risk: 'Shell mode spawn in dead code enables injection if revived',
    languages: ['js', 'ts']
  },
  {
    id: 'CWE-78-os-system',
    cwe: 'CWE-78',
    cweName: 'OS Command Injection',
    severity: 'CRITICAL',
    pattern: /os\.system\s*\(|subprocess\.(Popen|call|run)\s*\(/,
    description: 'Python OS command execution',
    risk: 'Dead code with system calls could be revived without security review',
    languages: ['py']
  },
  {
    id: 'CWE-78-go-exec',
    cwe: 'CWE-78',
    cweName: 'OS Command Injection',
    severity: 'CRITICAL',
    pattern: /exec\.Command\s*\(/,
    description: 'Go exec.Command() call',
    risk: 'Dead code with command execution could be revived without security review',
    languages: ['go']
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CWE-94: Code Injection
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'CWE-94-eval',
    cwe: 'CWE-94',
    cweName: 'Code Injection',
    severity: 'CRITICAL',
    pattern: /\beval\s*\(/,
    description: 'eval() with dynamic code execution',
    risk: 'Dead eval() could be exploited if code is revived or imported',
    languages: ['js', 'ts', 'py']
  },
  {
    id: 'CWE-94-new-function',
    cwe: 'CWE-94',
    cweName: 'Code Injection',
    severity: 'CRITICAL',
    pattern: /new\s+Function\s*\(/,
    description: 'new Function() constructor for dynamic code',
    risk: 'Dynamic function creation in dead code increases attack surface',
    languages: ['js', 'ts']
  },
  {
    id: 'CWE-94-vm-run',
    cwe: 'CWE-94',
    cweName: 'Code Injection',
    severity: 'CRITICAL',
    pattern: /vm\.(runInNewContext|runInThisContext|runInContext|compileFunction)\s*\(/,
    description: 'Node.js vm module execution',
    risk: 'VM context execution in dead code is a sandbox escape risk',
    languages: ['js', 'ts']
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CWE-798: Hardcoded Credentials
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'CWE-798-password',
    cwe: 'CWE-798',
    cweName: 'Hardcoded Credentials',
    severity: 'CRITICAL',
    pattern: /(password|passwd|secret|api_key|apikey|api_secret)\s*[:=]\s*["'][^"']{4,}/i,
    description: 'Hardcoded password or secret',
    risk: 'Credentials in dead code are often forgotten and exposed in version control',
    languages: []
  },
  {
    id: 'CWE-798-aws-key',
    cwe: 'CWE-798',
    cweName: 'Hardcoded Credentials',
    severity: 'CRITICAL',
    pattern: /AKIA[0-9A-Z]{16}/,
    description: 'AWS Access Key ID',
    risk: 'AWS credentials in dead code may still be active',
    languages: []
  },
  {
    id: 'CWE-798-private-key',
    cwe: 'CWE-798',
    cweName: 'Hardcoded Credentials',
    severity: 'CRITICAL',
    pattern: /-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----/,
    description: 'Embedded private key',
    risk: 'Private keys in dead code are often overlooked during rotation',
    languages: []
  },
  {
    id: 'CWE-798-openai-key',
    cwe: 'CWE-798',
    cweName: 'Hardcoded Credentials',
    severity: 'HIGH',
    pattern: /sk-[a-zA-Z0-9]{20,}/,
    description: 'Potential API key (sk-... pattern)',
    risk: 'API keys in dead code may remain active and billable',
    languages: []
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CWE-22: Path Traversal
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'CWE-22-path-join-params',
    cwe: 'CWE-22',
    cweName: 'Path Traversal',
    severity: 'HIGH',
    pattern: /path\.join\s*\([^)]*req\.(params|query|body)/,
    description: 'path.join with user input from request',
    risk: 'Path traversal in dead code could be revived as a file access vulnerability',
    languages: ['js', 'ts']
  },
  {
    id: 'CWE-22-readfile-params',
    cwe: 'CWE-22',
    cweName: 'Path Traversal',
    severity: 'HIGH',
    pattern: /(readFile|readFileSync|createReadStream)\s*\([^)]*req\.(params|query|body)/,
    description: 'File read with user-controlled path',
    risk: 'Unvalidated file read in dead code is a path traversal risk if revived',
    languages: ['js', 'ts']
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CWE-502: Unsafe Deserialization
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'CWE-502-pickle',
    cwe: 'CWE-502',
    cweName: 'Unsafe Deserialization',
    severity: 'HIGH',
    pattern: /pickle\.(load|loads)\s*\(/,
    description: 'Python pickle deserialization',
    risk: 'pickle.load() in dead code can execute arbitrary code if revived',
    languages: ['py']
  },
  {
    id: 'CWE-502-yaml-load',
    cwe: 'CWE-502',
    cweName: 'Unsafe Deserialization',
    severity: 'HIGH',
    pattern: /yaml\.load\s*\([^)]*(?!Loader\s*=\s*yaml\.SafeLoader)/,
    description: 'yaml.load() without SafeLoader',
    risk: 'Unsafe YAML loading in dead code can execute arbitrary code',
    languages: ['py']
  },
  {
    id: 'CWE-502-unserialize',
    cwe: 'CWE-502',
    cweName: 'Unsafe Deserialization',
    severity: 'HIGH',
    pattern: /\bunserialize\s*\(/,
    description: 'PHP unserialize() call',
    risk: 'Unsafe deserialization in dead code enables object injection if revived',
    languages: ['php']
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CWE-79: Cross-Site Scripting (XSS)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'CWE-79-innerhtml',
    cwe: 'CWE-79',
    cweName: 'Cross-Site Scripting',
    severity: 'HIGH',
    pattern: /\.innerHTML\s*=/,
    description: 'Direct innerHTML assignment',
    risk: 'innerHTML in dead code could introduce XSS if component is re-enabled',
    languages: ['js', 'ts']
  },
  {
    id: 'CWE-79-dangerously',
    cwe: 'CWE-79',
    cweName: 'Cross-Site Scripting',
    severity: 'HIGH',
    pattern: /dangerouslySetInnerHTML/,
    description: 'React dangerouslySetInnerHTML',
    risk: 'Dangerous React prop in dead component could introduce XSS if revived',
    languages: ['js', 'ts']
  },
  {
    id: 'CWE-79-document-write',
    cwe: 'CWE-79',
    cweName: 'Cross-Site Scripting',
    severity: 'HIGH',
    pattern: /document\.write\s*\(/,
    description: 'document.write() call',
    risk: 'document.write in dead code bypasses CSP if revived',
    languages: ['js', 'ts']
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CWE-327: Broken Cryptography
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'CWE-327-md5',
    cwe: 'CWE-327',
    cweName: 'Broken Cryptography',
    severity: 'MEDIUM',
    pattern: /createHash\s*\(\s*['"]md5['"]\s*\)/,
    description: 'MD5 hash usage',
    risk: 'Weak hash in dead code may be copied to new code without upgrading',
    languages: ['js', 'ts']
  },
  {
    id: 'CWE-327-sha1',
    cwe: 'CWE-327',
    cweName: 'Broken Cryptography',
    severity: 'MEDIUM',
    pattern: /hashlib\.(md5|sha1)\s*\(/,
    description: 'Python weak hash algorithm',
    risk: 'Weak hash in dead code may be copied to new code without upgrading',
    languages: ['py']
  },
  {
    id: 'CWE-327-des-rc4',
    cwe: 'CWE-327',
    cweName: 'Broken Cryptography',
    severity: 'MEDIUM',
    pattern: /createCipher(iv)?\s*\(\s*['"](des|rc4|des-ede|des-ede3)['"]/i,
    description: 'Weak cipher algorithm (DES/RC4)',
    risk: 'Broken cipher in dead code sets bad precedent if used as reference',
    languages: ['js', 'ts']
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CWE-918: Server-Side Request Forgery (SSRF)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'CWE-918-fetch-params',
    cwe: 'CWE-918',
    cweName: 'Server-Side Request Forgery',
    severity: 'HIGH',
    pattern: /fetch\s*\(\s*req\.(params|query|body)/,
    description: 'fetch() with user-controlled URL',
    risk: 'SSRF in dead code could be revived to access internal services',
    languages: ['js', 'ts']
  },
  {
    id: 'CWE-918-requests-dynamic',
    cwe: 'CWE-918',
    cweName: 'Server-Side Request Forgery',
    severity: 'MEDIUM',
    pattern: /requests\.(get|post|put|delete)\s*\(\s*f?["']/,
    description: 'Python requests with potentially dynamic URL',
    risk: 'Outbound requests in dead code may target internal services if revived',
    languages: ['py']
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CWE-200: Information Exposure
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'CWE-200-console-sensitive',
    cwe: 'CWE-200',
    cweName: 'Information Exposure',
    severity: 'LOW',
    pattern: /console\.(log|debug|info)\s*\([^)]*\b(password|secret|token|key|credential)/i,
    description: 'Logging potentially sensitive data',
    risk: 'Sensitive data logging in dead code may leak if code is re-enabled',
    languages: ['js', 'ts']
  },
  {
    id: 'CWE-200-stack-trace',
    cwe: 'CWE-200',
    cweName: 'Information Exposure',
    severity: 'LOW',
    pattern: /res\.(send|json)\s*\(\s*(err|error)\.(stack|message)/,
    description: 'Stack trace exposure in response',
    risk: 'Error detail exposure in dead endpoint leaks info if route is re-enabled',
    languages: ['js', 'ts']
  }
];

/**
 * Extension to language mapping
 */
const EXT_TO_LANG = {
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'js',
  '.ts': 'ts',
  '.tsx': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.py': 'py',
  '.go': 'go',
  '.php': 'php',
  '.rb': 'rb',
  '.java': 'java',
  '.kt': 'kt',
  '.kts': 'kt',
  '.cs': 'cs',
  '.rs': 'rs',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp'
};

/**
 * Get CWE patterns applicable to a file extension.
 * Returns all language-agnostic patterns plus language-specific ones.
 */
export function getPatternsForLanguage(ext) {
  const lang = EXT_TO_LANG[ext];

  return CWE_PATTERNS.filter(p => {
    // Language-agnostic patterns apply to all files
    if (p.languages.length === 0) return true;
    // No mapping for this extension — only return language-agnostic
    if (!lang) return false;
    // JS and TS share patterns
    if ((lang === 'js' || lang === 'ts') && (p.languages.includes('js') || p.languages.includes('ts'))) return true;
    return p.languages.includes(lang);
  });
}
