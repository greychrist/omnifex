import Foundation

/// Turns a path Claude wrote in a transcript link into something safe to hand
/// `NSWorkspace.open`.
///
/// Claude writes these paths, so a click must never run anything: an app,
/// script or installer is revealed in Finder instead of opened, and so is any
/// file with an executable bit. Everything else opens in its default app.
public enum OpenPathPlanner {
    public struct PathStat: Equatable, Sendable {
        public var isDirectory: Bool
        public var mode: Int
        public init(isDirectory: Bool, mode: Int) {
            self.isDirectory = isDirectory
            self.mode = mode
        }
    }

    public enum Plan: Equatable, Sendable {
        case open(String)
        case reveal(String)
        case error(String)
    }

    /// Extensions macOS may launch or install rather than display.
    static let runnableExtensions: Set<String> = [
        "app", "command", "sh", "bash", "zsh", "csh", "tool", "terminal",
        "workflow", "action", "pkg", "mpkg", "dmg", "scpt", "scptd",
        "applescript", "py", "rb", "pl", "php", "js", "mjs", "cjs",
        "jar", "exe", "bat", "prefpane", "webloc", "inetloc", "fileloc",
    ]

    public static func resolveLinkPath(_ raw: String, cwd: String?, homeDir: String) -> String? {
        var p = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if p.isEmpty { return nil }
        if p.hasPrefix("file://") {
            guard let url = URL(string: p), url.isFileURL else { return nil }
            p = url.path(percentEncoded: false)
        } else if let decoded = p.removingPercentEncoding {
            // react-markdown percent-encodes hrefs; a path that was not encoded
            // after all is used as written.
            p = decoded
        }
        // `src/foo.ts:42` / `src/foo.ts:42:7`
        if let r = p.range(of: #"(?::\d+){1,2}$"#, options: .regularExpression) {
            p.removeSubrange(r)
        }
        if p == "~" || p.hasPrefix("~/") { p = homeDir + p.dropFirst() }
        if p.hasPrefix("/") { return normalize(p) }
        guard let cwd, !cwd.isEmpty else { return nil }
        return normalize(cwd + "/" + p)
    }

    public static func plan(_ raw: String, cwd: String?, homeDir: String, stat: (String) -> PathStat?) -> Plan {
        guard let resolved = resolveLinkPath(raw, cwd: cwd, homeDir: homeDir) else {
            return .error("Can't tell which folder \"\(raw)\" is relative to.")
        }
        guard let st = stat(resolved) else { return .error("File not found: \(resolved)") }
        let ext = (resolved as NSString).pathExtension.lowercased()
        let runnable = runnableExtensions.contains(ext) || (!st.isDirectory && (st.mode & 0o111) != 0)
        return runnable ? .reveal(resolved) : .open(resolved)
    }

    /// The real filesystem's answer, for the app.
    public static func diskStat(_ path: String) -> PathStat? {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path) else { return nil }
        let isDir = (attrs[.type] as? FileAttributeType) == .typeDirectory
        let mode = (attrs[.posixPermissions] as? NSNumber)?.intValue ?? 0
        return PathStat(isDirectory: isDir, mode: mode)
    }

    /// Lexical `.`/`..` resolution, like node's `path.normalize` — never
    /// touches the disk, so a symlink in the path is left for the OS to follow.
    static func normalize(_ path: String) -> String {
        var out: [Substring] = []
        for part in path.split(separator: "/", omittingEmptySubsequences: true) {
            if part == "." { continue }
            if part == ".." { if !out.isEmpty { out.removeLast() }; continue }
            out.append(part)
        }
        return "/" + out.joined(separator: "/")
    }
}
