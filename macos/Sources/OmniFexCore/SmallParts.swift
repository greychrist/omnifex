import Foundation

/// The cost report's measured content box → the rect a one-page PDF is cut
/// from. PDF caps a page at 200in (14400pt); at 96 CSS px per inch that is
/// 19200px, and a taller report is shrunk to fit rather than cut off — a
/// truncated cost report is missing panels, the failure the export exists to
/// prevent. A garbage measurement (a view that never laid out reports 0)
/// falls back rather than producing a zero-size page.
public struct PdfPageSize: Equatable, Sendable {
    public static let maxPx: Double = 200 * 96
    public var widthPx: Double
    public var heightPx: Double
    public var scale: Double
    public var scaledWidth: Double { widthPx * scale }
    public var scaledHeight: Double { heightPx * scale }

    public static func compute(widthPx: Double, heightPx: Double) -> PdfPageSize {
        func usable(_ v: Double) -> Double { v.isFinite && v > 0 ? v : 1152 }
        let w = usable(widthPx), h = usable(heightPx)
        return PdfPageSize(widthPx: w, heightPx: h, scale: min(1, maxPx / h))
    }
}

/// The daemon CLI's `ensure` / `restart` answer, and the URLs derived from it.
public enum DaemonEnsure {
    public struct Result: Equatable, Sendable {
        public var url: String?
        public var outdated: Bool
    }

    /// The CLI logs freely; the answer is its last non-empty line.
    public static func parse(stdout: String) -> Result? {
        guard let line = stdout.split(whereSeparator: \.isNewline).last(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }),
              let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
              obj.keys.contains("url")
        else { return nil }
        return Result(url: obj["url"] as? String, outdated: obj["outdated"] as? Bool ?? false)
    }

    static func httpBase(_ ws: String) -> URLComponents? {
        guard var c = URLComponents(string: ws), let scheme = c.scheme, c.host != nil else { return nil }
        switch scheme {
        case "ws": c.scheme = "http"
        case "wss": c.scheme = "https"
        default: return nil
        }
        c.query = nil
        c.fragment = nil
        return c
    }

    /// `ws://h:p/ws` → `http://h:p/`: the daemon serves the renderer at `/`.
    public static func pageURL(fromWebSocket ws: String) -> URL? {
        guard var c = httpBase(ws) else { return nil }
        c.path = "/"
        return c.url
    }

    public static func healthURL(fromWebSocket ws: String) -> URL? {
        guard var c = httpBase(ws) else { return nil }
        c.path = "/healthz"
        return c.url
    }

    /// `sessions.inFlight` from `/healthz`; an older daemon without the field
    /// reads as idle. nil = not a health body at all.
    public static func inFlight(fromHealth data: Data) -> Int? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return (obj["sessions"] as? [String: Any])?["inFlight"] as? Int ?? 0
    }
}

/// Reads the `params` the bridge delivers. Handlers accept camelCase and
/// snake_case alike, and a few channels (`shell:openExternal`) send a bare
/// string rather than an object.
public enum BridgeParams {
    public static func string(_ params: Any?, _ keys: String...) -> String? {
        if let s = params as? String { return s }
        guard let d = params as? [String: Any] else { return nil }
        for k in keys { if let v = d[k] as? String { return v } }
        return nil
    }

    public static func int(_ params: Any?, _ key: String) -> Int? {
        ((params as? [String: Any])?[key] as? NSNumber)?.intValue
    }

    public static func double(_ params: Any?, _ key: String) -> Double? {
        ((params as? [String: Any])?[key] as? NSNumber)?.doubleValue
    }

    public static func bool(_ params: Any?, _ key: String) -> Bool {
        ((params as? [String: Any])?[key] as? Bool) ?? false
    }

    public static func dict(_ params: Any?, _ key: String? = nil) -> [String: Any]? {
        guard let d = params as? [String: Any] else { return nil }
        guard let key else { return d }
        return d[key] as? [String: Any]
    }
}
