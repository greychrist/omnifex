import Foundation

/// Discovers updates on the public GitHub releases page and names downloads.
///
/// The asset shape is the contract with the release runbook and with every
/// older install's updater (Electron's included — that is how the last Electron
/// build updates itself into this app): `OmniFex-darwin-arm64-X.Y.Z.zip`.
public enum Updater {
    public static let repo = "greychrist/omnifex"
    static let zipPattern = #"^OmniFex-darwin-arm64-(\d+\.\d+\.\d+)\.zip$"#

    public struct Info: Equatable, Sendable {
        public var version: String
        public var downloadUrl: String
        public var assetName: String
        public var releaseUrl: String
        public var releaseNotes: String?

        /// The renderer's `checkForUpdate()` shape.
        public var json: [String: Any] {
            var o: [String: Any] = [
                "available": true, "version": version, "downloadUrl": downloadUrl,
                "assetName": assetName, "releaseUrl": releaseUrl,
            ]
            if let releaseNotes { o["releaseNotes"] = releaseNotes }
            return o
        }
    }

    /// Cache-busted: GitHub's edge holds releases/latest for about a minute,
    /// which returned the old version right after a publish (v0.4.44).
    public static func latestReleaseURL(now: Date = Date()) -> URL {
        URL(string: "https://api.github.com/repos/\(repo)/releases/latest?_=\(Int(now.timeIntervalSince1970 * 1000))")!
    }

    static func parse(_ v: String) -> [Int]? {
        guard let r = v.range(of: #"^\d+\.\d+\.\d+"#, options: .regularExpression) else { return nil }
        return v[r].split(separator: ".").compactMap { Int($0) }
    }

    public static func compare(_ a: String, _ b: String) -> Int {
        guard let pa = parse(a), let pb = parse(b) else { return 0 }
        for i in 0..<3 where pa[i] != pb[i] { return pa[i] - pb[i] }
        return 0
    }

    public static func isNewer(_ remote: String, than local: String) -> Bool {
        guard parse(remote) != nil, parse(local) != nil else { return false }
        return compare(remote, local) > 0
    }

    static func zipVersion(_ name: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: zipPattern),
              let m = re.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)),
              let r = Range(m.range(at: 1), in: name)
        else { return nil }
        return String(name[r])
    }

    /// The best zip asset in a releases/latest body, when newer than `currentVersion`.
    /// Anything unreadable is "no update", never an error: the titlebar shows
    /// "up to date" rather than a spinner that never resolves.
    public static func pickUpdate(fromRelease data: Data, currentVersion: String) -> Info? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let assets = obj["assets"] as? [[String: Any]]
        else { return nil }
        var best: (version: String, asset: [String: Any])?
        for asset in assets {
            guard let name = asset["name"] as? String, let v = zipVersion(name) else { continue }
            if best == nil || compare(v, best!.version) > 0 { best = (v, asset) }
        }
        guard let best, isNewer(best.version, than: currentVersion) else { return nil }
        return Info(
            version: best.version,
            downloadUrl: best.asset["browser_download_url"] as? String ?? "",
            assetName: best.asset["name"] as? String ?? "",
            releaseUrl: obj["html_url"] as? String ?? "",
            releaseNotes: obj["body"] as? String
        )
    }

    /// A downloaded zip is never deleted at install time — a retried install
    /// stages from the same file — so the next launch removes the spent ones.
    public static func shouldPrune(_ fileName: String, currentVersion: String) -> Bool {
        guard let v = zipVersion(fileName) else { return false }
        return compare(v, currentVersion) <= 0
    }

    public static func filename(fromURL raw: String) -> String {
        guard let url = URL(string: raw), url.host != nil, let last = url.pathComponents.last, last != "/", !last.isEmpty else {
            return "OmniFex-update.zip"
        }
        return last
    }

    public static func progress(bytes: Int64, total: Int64) -> [String: Any] {
        let percent = total > 0 ? Int((Double(bytes) / Double(total) * 100).rounded()) : 0
        return ["percent": percent, "bytesDownloaded": bytes, "totalBytes": total]
    }
}
