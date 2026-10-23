import Foundation

public enum NavigationDecision: Equatable, Sendable {
    case allow, external, deny
}

/// What a web view may navigate to.
///
/// The window may only ever show the app's own page. A transcript link to
/// `/Users/me/report.md` resolves against that page — onto the daemon's origin
/// packaged, the dev server's in dev — so allowing the whole origin let one
/// click replace the app window with the file (2026-10-22). Hash routes are
/// in-page navigations and never reach this policy.
public struct NavigationPolicy: Sendable {
    /// The daemon's page origin, `http://<host>:<port>/`.
    public var appOrigin: URL?
    /// The Vite dev server, in dev only.
    public var devServer: URL?

    public init(appOrigin: URL?, devServer: URL?) {
        self.appOrigin = appOrigin
        self.devServer = devServer
    }

    public func classify(_ raw: String) -> NavigationDecision {
        if raw.isEmpty || raw == "about:blank" { return .allow }
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased() else { return .deny }

        for origin in [appOrigin, devServer].compactMap({ $0 }) where Self.sameOrigin(url, origin) {
            let path = url.path
            return path.isEmpty || path == "/" || path == "/index.html" ? .allow : .deny
        }
        return scheme == "http" || scheme == "https" ? .external : .deny
    }

    /// Whether a frame may call the native bridge: the main frame, showing
    /// the app's own origin, and nothing else.
    ///
    /// The page shows link previews of arbitrary URLs in iframes, and the
    /// bridge reaches `updater:download` and `updater:install` — a frame from
    /// one of those previews calling them would be code execution. (Electron
    /// never had the question: its preload ran in the main frame only.)
    /// `port` is `WKSecurityOrigin`'s, where 0 means the scheme's default.
    public func allowsBridge(isMainFrame: Bool, scheme: String, host: String, port: Int) -> Bool {
        guard isMainFrame else { return false }
        var parts = URLComponents()
        parts.scheme = scheme
        parts.host = host
        if port != 0 { parts.port = port }
        guard let frameOrigin = parts.url else { return false }
        return [appOrigin, devServer].compactMap({ $0 }).contains { Self.sameOrigin(frameOrigin, $0) }
    }

    static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        a.scheme?.lowercased() == b.scheme?.lowercased()
            && a.host?.lowercased() == b.host?.lowercased()
            && effectivePort(a) == effectivePort(b)
    }

    static func effectivePort(_ u: URL) -> Int? {
        if let p = u.port { return p }
        switch u.scheme?.lowercased() {
        case "http": return 80
        case "https": return 443
        default: return nil
        }
    }
}
