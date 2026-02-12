# swynx-lite

Dead code detection and cleanup for 35 languages. One command, zero config.

```bash
npx swynx-lite
```

Like [Knip](https://knip.dev), but for every language. Plus security scanning. Plus it cleans up for you.

## What it does

- **Detects dead code** across JS/TS, Python, Go, Java, Kotlin, Rust, C#, PHP, Ruby, Swift, and 25 more languages
- **Scans for security vulnerabilities** (CWE patterns) hiding in dead code
- **Removes dead code** with a quarantine safety net — undo anytime
- **Works in CI** with exit codes and configurable thresholds

## Install

```bash
npm install -g swynx-lite
```

Or run directly:

```bash
npx swynx-lite
```

## Usage

```bash
swynx-lite                     # Scan current directory
swynx-lite scan ./src          # Scan a specific path
swynx-lite scan --json         # Machine-readable output
swynx-lite scan --ci           # CI mode (exit 1 if dead code found)
swynx-lite clean               # Remove dead code (with quarantine)
swynx-lite clean --dry-run     # Preview what would be removed
swynx-lite restore             # Undo the last clean
swynx-lite purge               # Permanently delete quarantined files
swynx-lite init                # Create a config file
```

## Example output

```
  swynx lite v1.0.0

  -- Summary -----------------------------------------------

   Files scanned    1,247
   Entry points        18
   Reachable        1,198
   Dead files          49  (3.93%)
   Dead code size   284 KB

  -- Dead Files ---------------------------------------------

   src/utils/old-parser.ts            12.4 KB   318 lines
   src/helpers/deprecated-auth.ts      8.1 KB   195 lines
   src/lib/unused-validator.js         6.3 KB   142 lines
   ... and 46 more

  -- Security -----------------------------------------------

   2 findings in dead code

   CRITICAL  src/utils/old-parser.ts:42
             CWE-94 Code Injection - eval() with dynamic input

  -- What Next ----------------------------------------------

   Run  swynx-lite clean  to remove 49 dead files (saves 284 KB)
```

## CI Integration

```yaml
# GitHub Actions
- run: npx swynx-lite scan --ci --threshold 5
```

Exit code 0 if dead code rate is below the threshold, 1 if above.

## Config

Create a `.swynx-lite.json` in your project root (or run `swynx-lite init`):

```json
{
  "ignore": [
    "**/__tests__/**",
    "**/*.test.*",
    "scripts/**"
  ],
  "ci": {
    "threshold": 5,
    "failOnSecurity": true
  }
}
```

You can also use a `.swynxignore` file (gitignore-style).

## Swynx Pro

Swynx Lite is free forever. No telemetry, no tracking, fully offline.

For teams that need dashboards, predictive intelligence, dependency scanning, and enterprise reporting: [swynx.io/pro](https://swynx.io/pro)

## License

BSL 1.1 (converts to Apache 2.0 after 4 years)
