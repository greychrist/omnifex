import { describe, it, expect } from 'vitest';

import {
  buildLaunchAgentPlist,
  launchAgentPath,
  launchAgentSpecFor,
  launchctlCommands,
  LAUNCH_AGENT_LABEL,
} from '../remote/launchd';
import { DAEMON_PROCESS_TITLE, parseCliArgs, setDaemonProcessTitle } from '../remote/cli';

describe('launchd plist', () => {
  const spec = launchAgentSpecFor(
    { execPath: '/Applications/OmniFex.app/Contents/MacOS/omnifex', script: '/Applications/OmniFex.app/Contents/Resources/app.asar/.vite/build/omnifex-server.js' },
    { PATH: '/opt/homebrew/bin:/usr/bin:/bin', OMNIFEX_STATE_DIR: undefined },
    '/Users/greg',
  );
  const plist = buildLaunchAgentPlist(spec);

  it('runs the Electron binary as node with the built script and `start`', () => {
    expect(spec.programArguments).toEqual([
      '/Applications/OmniFex.app/Contents/MacOS/omnifex',
      '/Applications/OmniFex.app/Contents/Resources/app.asar/.vite/build/omnifex-server.js',
      'start',
    ]);
    expect(spec.environment.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('bakes the installing shell\'s PATH and HOME into the agent environment', () => {
    expect(spec.environment.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin');
    expect(spec.environment.HOME).toBe('/Users/greg');
    expect(spec.environment).not.toHaveProperty('OMNIFEX_STATE_DIR');
  });

  it('carries a throwaway state dir through when one is set at install time', () => {
    const s = launchAgentSpecFor({ execPath: '/e', script: '/s' }, { PATH: '/bin', OMNIFEX_STATE_DIR: '/tmp/state' }, '/Users/greg');
    expect(s.environment.OMNIFEX_STATE_DIR).toBe('/tmp/state');
  });

  it('is KeepAlive + RunAtLoad and logs to ~/Library/Logs/omnifex-server.log', () => {
    expect(plist).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toContain('<string>/Users/greg/Library/Logs/omnifex-server.log</string>');
    expect(plist).toContain('<key>WorkingDirectory</key>\n    <string>/Users/greg</string>');
  });

  it('escapes XML-significant characters in values', () => {
    const p = buildLaunchAgentPlist({
      ...spec,
      programArguments: ['/Applications/Weird & Co <x>.app/omnifex', '/s', 'start'],
    });
    expect(p).toContain('/Applications/Weird &amp; Co &lt;x&gt;.app/omnifex');
    expect(p).not.toContain('& Co <x>');
  });

  it('names the LaunchAgents path and the launchctl invocations', () => {
    expect(launchAgentPath(LAUNCH_AGENT_LABEL, '/Users/greg')).toBe('/Users/greg/Library/LaunchAgents/com.omnifex.server.plist');
    const cmds = launchctlCommands('/Users/greg/Library/LaunchAgents/com.omnifex.server.plist', 501);
    expect(cmds.install).toEqual([
      ['launchctl', 'bootout', 'gui/501/com.omnifex.server'],
      ['launchctl', 'bootstrap', 'gui/501', '/Users/greg/Library/LaunchAgents/com.omnifex.server.plist'],
    ]);
    expect(cmds.uninstall).toEqual([['launchctl', 'bootout', 'gui/501/com.omnifex.server']]);
  });
});

describe('cli args', () => {
  it('recognises every subcommand and defaults to help', () => {
    expect(parseCliArgs(['start'])).toEqual({ command: 'start', flags: {} });
    expect(parseCliArgs(['status', '--json'])).toEqual({ command: 'status', flags: { json: true } });
    expect(parseCliArgs(['install', '--port', '5555'])).toEqual({ command: 'install', flags: { port: '5555' } });
    expect(parseCliArgs([])).toEqual({ command: 'help', flags: {} });
    expect(parseCliArgs(['frobnicate'])).toEqual({ command: 'help', flags: {}, unknown: 'frobnicate' });
  });
});

describe('daemon process title', () => {
  it('is the Unix daemon name, so ps and Activity Monitor show omnifexd rather than a second omnifex', () => {
    expect(DAEMON_PROCESS_TITLE).toBe('omnifexd');
    const proc = { title: '/Applications/OmniFex.app/Contents/MacOS/omnifex' };
    setDaemonProcessTitle(proc);
    expect(proc.title).toBe('omnifexd');
  });
});
