import Foundation

/// Where the app finds Node, the daemon, the page and the settings database.
/// Packaged builds use the bundle; dev and throwaway smoke runs override with
/// environment variables (see `macos/README.md`). Empty counts as unset.
public struct AppPaths: Sendable {
    public var node: String
    public var daemonScript: String
    public var resourcesPath: String
    public var devServerURL: URL?
    public var userDataDir: String
    public var home: String

    public var isDev: Bool { devServerURL != nil }
    public var settingsDatabase: String { userDataDir + "/greychrist.db" }
    public var daemonLog: String { home + "/Library/Logs/omnifex-server.log" }

    public init(environment env: [String: String], bundlePath: String) {
        func value(_ k: String) -> String? {
            guard let v = env[k], !v.isEmpty else { return nil }
            return v
        }
        home = value("HOME") ?? NSHomeDirectory()
        resourcesPath = bundlePath + "/Contents/Resources"
        node = value("OMNIFEX_NODE") ?? bundlePath + "/Contents/MacOS/omnifexd"
        daemonScript = value("OMNIFEX_DAEMON_SCRIPT") ?? resourcesPath + "/app/build/omnifex-server.js"
        devServerURL = value("OMNIFEX_DEV_SERVER_URL").flatMap(URL.init(string:))
        userDataDir = value("OMNIFEX_USER_DATA_DIR") ?? home + "/Library/Application Support/OmniFex"
    }
}
