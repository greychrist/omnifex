/**
 * launchd integration: the plist that keeps the daemon running, and the
 * `launchctl` invocations around it.
 *
 * A LaunchAgent (per-user, `gui/<uid>`) rather than a LaunchDaemon: the
 * process must run as Greg, with Greg's home directory, so the Claude CLI
 * finds `~/.claude-personal` / `~/.claude-work` and their credentials.
 *
 * launchd does not run a login shell, so `PATH` is whatever the plist says.
 * `install` therefore bakes in the PATH of the shell it was run from, and the
 * daemon additionally re-derives PATH from the login shell at startup
 * (`fixPath()` in daemon.ts, the same trick `main.ts` uses for Finder
 * launches). Belt and braces: either alone has failed before.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LAUNCH_AGENT_LABEL = 'com.omnifex.server';

export interface LaunchAgentSpec {
  label: string;
  /** argv[0] is the Electron binary; the rest is the script and its args. */
  programArguments: string[];
  environment: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
  workingDirectory?: string;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildLaunchAgentPlist(spec: LaunchAgentSpec): string {
  const args = spec.programArguments.map((a) => `      <string>${xmlEscape(a)}</string>`).join('\n');
  const env = Object.entries(spec.environment)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `      <key>${xmlEscape(k)}</key>\n      <string>${xmlEscape(v)}</string>`)
    .join('\n');
  const cwd = spec.workingDirectory
    ? `    <key>WorkingDirectory</key>\n    <string>${xmlEscape(spec.workingDirectory)}</string>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(spec.label)}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>ThrottleInterval</key>
    <integer>5</integer>
${cwd}    <key>StandardOutPath</key>
    <string>${xmlEscape(spec.stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(spec.stderrPath)}</string>
  </dict>
</plist>
`;
}

export function launchAgentPath(label: string = LAUNCH_AGENT_LABEL, home: string = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}

export function defaultLogPath(home: string = homedir()): string {
  return join(home, 'Library', 'Logs', 'omnifex-server.log');
}

export interface DaemonInvocation {
  /** The Electron binary, run as node. */
  execPath: string;
  /** The built `omnifex-server.js`. */
  script: string;
}

/**
 * The plist for this installation. `PATH` is the caller's, captured now —
 * the only moment a login-shell PATH is reliably in hand.
 */
export function launchAgentSpecFor(
  invocation: DaemonInvocation,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): LaunchAgentSpec {
  const environment: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1',
    HOME: home,
    PATH: env.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  };
  // A throwaway state dir set while installing should follow the daemon.
  if (env.OMNIFEX_STATE_DIR) environment.OMNIFEX_STATE_DIR = env.OMNIFEX_STATE_DIR;
  if (env.OMNIFEX_USER_DATA_DIR) environment.OMNIFEX_USER_DATA_DIR = env.OMNIFEX_USER_DATA_DIR;
  return {
    label: LAUNCH_AGENT_LABEL,
    programArguments: [invocation.execPath, invocation.script, 'start'],
    environment,
    stdoutPath: defaultLogPath(home),
    stderrPath: defaultLogPath(home),
    workingDirectory: home,
  };
}

/** `launchctl` argv for install / uninstall, for a uid. Pure, so tests can see it. */
export function launchctlCommands(plistPath: string, uid: number, label: string = LAUNCH_AGENT_LABEL) {
  const domain = `gui/${uid}`;
  return {
    /** Idempotent: unload whatever is there first, then load. */
    install: [
      ['launchctl', 'bootout', `${domain}/${label}`],
      ['launchctl', 'bootstrap', domain, plistPath],
    ] as string[][],
    uninstall: [['launchctl', 'bootout', `${domain}/${label}`]] as string[][],
    /** Restart in place (KeepAlive would also do it, after ThrottleInterval). */
    restart: [['launchctl', 'kickstart', '-k', `${domain}/${label}`]] as string[][],
  };
}
