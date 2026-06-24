// Bundles the ESM backend into a single CommonJS file for @yao-pkg/pkg.
//
// pkg consumes a single CJS entry most reliably; squash's source is NodeNext ESM
// spread across many files, so esbuild flattens it first. node-pty is a native
// addon and is kept EXTERNAL — pkg embeds its prebuilt binary as an asset (see
// the `pkg` config in package.json) and the bundle `require()`s it at runtime.
//
// Output: dist-bin/server.cjs  (consumed by `npm run package:exe`)

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

await build({
  entryPoints: [path.join(rootDir, 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  outfile: path.join(rootDir, 'dist-bin', 'server.cjs'),
  // Native addon: pkg ships node-pty's prebuilt binary as an asset instead.
  external: ['node-pty'],
  // esbuild leaves `import.meta.url` empty in CJS output; paths.ts relies on it
  // to locate the app root. Re-create it from CJS's __filename via a banner const.
  banner: { js: "const __squashImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__squashImportMetaUrl' },
  // Keep readable output; pkg handles size/bytecode itself.
  minify: false,
  sourcemap: false,
  logLevel: 'info'
});

console.log('[bundle] wrote dist-bin/server.cjs');
