import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// Read the installed @anthropic-ai/claude-agent-sdk version at config-load
// time so we can bake it into the main-process bundle. In the packaged app
// the SDK is tree-shaken into main.js and its package.json isn't shipped as
// a loose file, so a runtime filesystem read fails and the "Referenced SDK"
// titlebar badge goes blank. Embedding it as a constant avoids that.
function resolveReferencedSdkVersion(): string {
  try {
    const pkgPath = path.resolve(
      __dirname,
      'node_modules/@anthropic-ai/claude-agent-sdk/package.json',
    );
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '';
  } catch {
    return '';
  }
}

export default defineConfig({
  define: {
    __GREYCHRIST_REFERENCED_SDK_VERSION__: JSON.stringify(resolveReferencedSdkVersion()),
  },
  build: {
    rollupOptions: {
      external: ['better-sqlite3', 'node-pty'],
    },
  },
});
