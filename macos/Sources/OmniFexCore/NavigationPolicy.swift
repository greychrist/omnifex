import Foundation

public enum NavigationDecision: Equatable, Sendable {
    case allow, external, deny, download
}

/// Only the app's own page: a transcript link like `/Users/me/report.md` resolves onto the app's
/// origin, so allowing the whole origin let one click replace the window with the file.
public struct NavigationPolicy: Sendable {
    public var appOrigin: URL?
    public var devServer: URL?

    public init(appOrigin: URL?, devServer: URL?) {
        self.appOrigin = appOrigin
        self.devServer = devServer
    }

    /// WKWebView does nothing with a `blob:` link unless the navigation becomes a download.
    public func classify(_ raw: String, isDownload: Bool = false) -> NavigationDecision {
        if raw.isEmpty || raw == "about:blank" { return .allow }
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased() else { return .deny }
        if isDownload, scheme == "data" { return .download }
        if isDownload, scheme == "blob" {
            // A blob URL carries its creator's origin: `blob:http://host:port/uuid`.
            let inner = URL(string: String(raw.dropFirst("blob:".count)))
            let own = inner.map { u in [appOrigin, devServer].compactMap { $0 }.contains { Self.sameOrigin(u, $0) } } ?? false
            return own ? .download : .deny
        }

        for origin in [appOrigin, devServer].compactMap({ $0 }) where Self.sameOrigin(url, origin) {
            let path = url.path
            return path.isEmpty || path == "/" || path == "/index.html" ? .allow : .deny
        }
        return scheme == "http" || scheme == "https" ? .external : .deny
    }

    /// Main frame on the app's origin only: link previews put arbitrary URLs in iframes, and the bridge
    /// reaches `updater:install`. `port` is `WKSecurityOrigin`'s, where 0 means the scheme's default.
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
