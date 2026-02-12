// src/scanner/parse-worker.mjs
// Worker thread for parallel file parsing
// Receives a chunk of files and a parser type, returns parsed results

import { parentPort, workerData } from 'worker_threads';

const { files, parserType } = workerData;

const BATCH_SIZE = 200;  // Send results in batches to reduce structured clone overhead

async function run() {
  let parseFn;

  switch (parserType) {
    case 'javascript': {
      const mod = await import('./parsers/javascript.mjs');
      parseFn = mod.parseJavaScript;
      break;
    }
    case 'css': {
      const mod = await import('./parsers/css.mjs');
      parseFn = mod.parseCSS;
      break;
    }
    case 'assets': {
      const mod = await import('./parsers/assets.mjs');
      parseFn = mod.analyseAssets;
      break;
    }
    case 'other': {
      const mod = await import('./parsers/registry.mjs');
      parseFn = mod.parseFile;
      break;
    }
    default:
      throw new Error(`Unknown parser type: ${parserType}`);
  }

  const batch = [];

  for (let i = 0; i < files.length; i++) {
    try {
      const result = await parseFn(files[i]);
      if (result) {
        // B1: Strip content and function/method bodies before postMessage
        // Content is only needed for DI/C# analysis in deadcode.mjs — those will re-read from disk
        result.content = null;
        if (result.functions) {
          for (const fn of result.functions) { fn.body = undefined; }
        }
        if (result.classes) {
          for (const cls of result.classes) {
            cls.body = undefined;
            if (cls.methods) {
              for (const m of cls.methods) { m.body = undefined; }
            }
          }
        }
        batch.push(result);
      }
    } catch {
      // Skip files that fail to parse
    }

    // Report progress every 100 files
    if ((i + 1) % 100 === 0 || i === files.length - 1) {
      parentPort.postMessage({ type: 'progress', done: i + 1, total: files.length });
    }

    // Send results in batches of BATCH_SIZE to reduce peak structured clone memory
    if (batch.length >= BATCH_SIZE) {
      parentPort.postMessage({ type: 'batch', results: batch.splice(0) });
    }
  }

  // Send any remaining results and signal completion
  parentPort.postMessage({ type: 'done', results: batch });
}

run().catch(err => {
  parentPort.postMessage({ type: 'error', message: err.message });
});
