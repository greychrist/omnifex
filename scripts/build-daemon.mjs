// `ws` stays external: bundling it rewrites the module object bufferutil is looked up on, and the
// daemon throws `bufferUtil.unmask is not a function` on the first frame. Every external must be
// copied by the package script (JS_EXTERNAL_MODULES in packaging/app-bundle.ts), or the packaged
// daemon fails with `Cannot find module`, never dev.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builtins = builtinModules.flatMap((m) => [m, `node:${m}`]);

export const EXTERNAL = ['better-sqlite3', 'node-pty', 'ws', 'web-push'];

for (const entry of ['omnifex-server', 'brain-mcp']) {
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    resolve: {
      alias: { '@': path.join(root, 'src') },
      conditions: ['node'],
      mainFields: ['module', 'jsnext:main', 'jsnext'],
    },
    build: {
      outDir: '.vite/build',
      emptyOutDir: false,
      copyPublicDir: false,
      minify: false,
      sourcemap: true,
      lib: {
        entry: path.join(root, `daemon/${entry}.ts`),
        fileName: () => `${entry}.js`,
        formats: ['cjs'],
      },
      rollupOptions: {
        external: [...builtins, ...EXTERNAL],
        // One file per entry: the package script copies exactly these two.
        output: { inlineDynamicImports: true },
      },
    },
  });
  console.log(`built .vite/build/${entry}.js`);
}
