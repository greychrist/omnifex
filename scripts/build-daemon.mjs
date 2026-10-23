// Build the two Node entry points the app ships: the daemon
// (`omnifex-server.js`) and the Brain MCP server the Claude CLI spawns
// (`brain-mcp.js`). Both land in .vite/build/ as CommonJS with node builtins
// and the runtime packages external — `npm run package` copies them into the
// app beside those packages, and in a checkout `scripts/omnifex-server` runs
// them from here.
//
// `ws` and `web-push` stay external: bundling `ws` rewrites the module object
// its optional native fallback (bufferutil) is looked up on, and the daemon
// then throws `bufferUtil.unmask is not a function` on the first inbound
// frame. Anything left external here must be copied by the package script
// (EXTERNAL_MODULES in packaging/app-bundle.ts) — a missing one shows only as
// `Cannot find module` in the packaged daemon, never in dev.
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
        entry: path.join(root, `electron/${entry}.ts`),
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
