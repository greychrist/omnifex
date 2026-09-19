/**
 * Map a file path to a Prism language id for the diff viewer.
 *
 * Deliberately a lookup table rather than content sniffing: the diff viewer
 * already knows the path, and a wrong guess only costs colour. `text` is the
 * fallback — Prism accepts it and renders the line unhighlighted, which is
 * what an unknown file type should look like.
 */

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  mdx: 'markdown',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  vue: 'markup',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  dockerfile: 'docker',
  tf: 'hcl',
  hcl: 'hcl',
  lua: 'lua',
  r: 'r',
  pl: 'perl',
  diff: 'diff',
  patch: 'diff',
};

export function languageForPath(path: string): string {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  // `dot <= 0` covers both "no extension" and a dotfile like `.gitignore`,
  // whose leading dot starts the name rather than an extension.
  if (dot <= 0) return 'text';
  const ext = name.slice(dot + 1).toLowerCase();
  return BY_EXTENSION[ext] ?? 'text';
}
