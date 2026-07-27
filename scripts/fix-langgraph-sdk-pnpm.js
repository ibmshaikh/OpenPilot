#!/usr/bin/env node
/**
 * @langchain/langgraph-sdk@1.9.x ships async_caller with broken pnpm-absolute
 * requires (../node_modules/.pnpm/p-retry@... and p-queue@...). Those paths
 * exist only in the package author's pnpm store, so Electron asar builds crash
 * on Windows/macOS with "Cannot find module .../.pnpm/p-retry@...".
 *
 * Rewrite those requires to local CJS-safe vendors / the hoisted p-queue@6.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const sdkUtils = path.join(
  root,
  'node_modules',
  '@langchain',
  'langgraph-sdk',
  'dist',
  'utils'
);
const coreUtils = path.join(
  root,
  'node_modules',
  '@langchain',
  'core',
  'dist',
  'utils'
);

const BROKEN_CJS = /require\(["']\.\.\/node_modules\/\.pnpm\/p-retry@[^"']+["']\)/;
const BROKEN_ESM = /from ["']\.\.\/node_modules\/\.pnpm\/p-retry@[^"']+["']/;

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    if (fs.statSync(from).isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function ensureVendor() {
  const vendor = path.join(sdkUtils, 'vendor');
  for (const dir of ['p-retry', 'is-network-error']) {
    const src = path.join(coreUtils, dir);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing vendor source: ${src}`);
    }
    copyDir(src, path.join(vendor, dir));
  }
}

function patchCjs(filePath) {
  let src = fs.readFileSync(filePath, 'utf8');
  if (!BROKEN_CJS.test(src) && !src.includes('.pnpm/p-queue@')) return false;

  src = src
    .replace(
      /const require_index = require\(["']\.\.\/node_modules\/\.pnpm\/p-retry@[^"']+["']\);/,
      'const require_index = require("./vendor/p-retry/index.cjs");'
    )
    .replace(
      /const require_index\$1 = require\(["']\.\.\/node_modules\/\.pnpm\/p-queue@[^"']+["']\);/,
      // Hoisted p-queue@6 is CJS-safe; nested p-queue@9 under langgraph-sdk is ESM-only.
      'const require_index$1 = { default: require("../../../../p-queue") };'
    );

  if (src.includes('.pnpm/p-retry@') || src.includes('.pnpm/p-queue@')) {
    throw new Error(`Failed to fully patch ${filePath}`);
  }
  fs.writeFileSync(filePath, src);
  return true;
}

function patchEsm(filePath) {
  let src = fs.readFileSync(filePath, 'utf8');
  if (!BROKEN_ESM.test(src) && !src.includes('.pnpm/p-queue@')) return false;

  src = src
    .replace(
      /import pRetry\$1 from ["']\.\.\/node_modules\/\.pnpm\/p-retry@[^"']+["'];/,
      'import pRetry$1 from "./vendor/p-retry/index.js";'
    )
    .replace(
      /import PQueue from ["']\.\.\/node_modules\/\.pnpm\/p-queue@[^"']+["'];/,
      'import PQueue from "../../../../p-queue/dist/index.js";'
    );

  if (src.includes('.pnpm/p-retry@') || src.includes('.pnpm/p-queue@')) {
    throw new Error(`Failed to fully patch ${filePath}`);
  }
  fs.writeFileSync(filePath, src);
  return true;
}

function main() {
  if (!fs.existsSync(sdkUtils)) {
    console.log('[fix-langgraph-sdk] @langchain/langgraph-sdk not installed; skip');
    return;
  }

  const cjs = path.join(sdkUtils, 'async_caller.cjs');
  const esm = path.join(sdkUtils, 'async_caller.js');
  const needsFix =
    (fs.existsSync(cjs) && fs.readFileSync(cjs, 'utf8').includes('.pnpm/p-retry@')) ||
    (fs.existsSync(esm) && fs.readFileSync(esm, 'utf8').includes('.pnpm/p-retry@'));

  if (!needsFix) {
    console.log('[fix-langgraph-sdk] async_caller already OK');
    return;
  }

  ensureVendor();
  const changed = [];
  if (fs.existsSync(cjs) && patchCjs(cjs)) changed.push('async_caller.cjs');
  if (fs.existsSync(esm) && patchEsm(esm)) changed.push('async_caller.js');
  console.log(`[fix-langgraph-sdk] patched ${changed.join(', ')}`);
}

main();
