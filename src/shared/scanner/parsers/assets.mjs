// src/scanner/parsers/assets.mjs
// Asset file analyser

import { statSync, existsSync } from 'fs';
import { extname, basename } from 'path';

/**
 * Analyse an asset file
 */
export async function analyseAssets(file) {
  const filePath = typeof file === 'string' ? file : file.path;
  const relativePath = typeof file === 'string' ? file : file.relativePath;

  if (!existsSync(filePath)) {
    return {
      file: { path: filePath, relativePath },
      type: 'unknown',
      size: 0
    };
  }

  const ext = extname(filePath).toLowerCase();
  const stats = statSync(filePath);

  let type = 'other';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico'].includes(ext)) {
    type = 'image';
  } else if (['.woff', '.woff2', '.ttf', '.eot', '.otf'].includes(ext)) {
    type = 'font';
  } else if (['.mp4', '.webm', '.ogg', '.mp3', '.wav'].includes(ext)) {
    type = 'media';
  }

  return {
    file: { path: filePath, relativePath },
    name: basename(filePath),
    type,
    ext,
    size: stats.size,
    sizeBytes: stats.size
  };
}

export default { analyseAssets };
