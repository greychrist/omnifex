// `no-restricted-syntax` entries that keep bare command names out of every
// child_process / node-pty call in the main and daemon processes.
//
// libuv on macOS walks PATH itself for a bare name, posix_spawning once per
// entry, and XNU creates a real process — assessed by syspolicyd — for every
// miss. It regressed three times (git watcher, the /usage scraper's MCP
// servers, limactl) before electron/services/util/spawn.ts existed. Use that
// helper for user-installed tools, or spell a SIP-guaranteed system tool
// absolute (`/usr/bin/afplay`).
//
// Syntax-only: a command held in a variable passes. Those come from resolvers
// (gitBinary(), claude-binary.ts) that return absolute paths.

const SPAWNERS = 'execFile|execFileSync|execFileAsync|spawn|spawnSync|spawnChild|ptySpawn';
const MEMBER_SPAWNERS = 'execFile|execFileSync|spawn|spawnSync';
const BARE_LITERAL = "[arguments.0.type='Literal'][arguments.0.value=/^[^/]/]";
const BARE_TEMPLATE = "[arguments.0.type='TemplateLiteral'][arguments.0.quasis.0.value.raw=/^[^/]/]";

const BARE_MESSAGE =
  'Spawn by absolute path, never a bare command name: each PATH miss is a throwaway process ' +
  'syspolicyd logs. Use execFileOnPath()/resolveCommand() from electron/services/util/spawn, ' +
  'or an absolute path for a system tool.';

export const noBareSpawn = [
  ...[BARE_LITERAL, BARE_TEMPLATE].flatMap((arg) => [
    { selector: `CallExpression[callee.name=/^(${SPAWNERS})$/]${arg}`, message: BARE_MESSAGE },
    { selector: `CallExpression[callee.property.name=/^(${MEMBER_SPAWNERS})$/]${arg}`, message: BARE_MESSAGE },
  ]),
  {
    selector: "CallExpression[callee.name=/^(exec|execSync)$/][arguments.0.type=/^(Literal|TemplateLiteral)$/]",
    message:
      'No shell command strings: /bin/sh resolves the command by PATH and adds a process. ' +
      'Use execFile/execFileSync with an absolute path (see electron/services/util/spawn).',
  },
  {
    selector: "Property[key.name='shell'][value.value=true]",
    message: 'No shell: true — it hands the command to /bin/sh. See electron/services/util/spawn.',
  },
];
