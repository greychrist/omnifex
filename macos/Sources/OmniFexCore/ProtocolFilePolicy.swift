import Foundation

/// Images only: an unrestricted read is a local-file read primitive for any script in the page.
/// The extension is checked AFTER symlink resolution, so `decoy.png -> ~/.claude/.credentials.json` is refused.
public enum ProtocolFilePolicy {
    public static let scheme = "greychrist-file"

    static let contentTypes: [String: String] = [
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "gif": "image/gif",
        "webp": "image/webp",
        "svg": "image/svg+xml",
    ]

    public enum Decision: Equatable, Sendable {
        /// The REAL path: the caller must read the file approved, not reopen the symlink.
        case ok(path: String, contentType: String)
        case refused(String)

        public var isOK: Bool { if case .ok = self { return true } else { return false } }
    }

    public static func requestedPath(from url: URL) -> String {
        url.path(percentEncoded: false)
    }

    public static func resolve(_ requested: String) -> Decision {
        guard requested.hasPrefix("/") else { return .refused("not an absolute path") }
        guard let real = realpath(requested) else { return .refused("does not exist") }

        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: real, isDirectory: &isDir) else { return .refused("not stattable") }
        guard !isDir.boolValue,
              let attrs = try? FileManager.default.attributesOfItem(atPath: real),
              (attrs[.type] as? FileAttributeType) == .typeRegular
        else { return .refused("not a regular file") }

        let ext = (real as NSString).pathExtension.lowercased()
        guard let type = contentTypes[ext] else {
            return .refused("extension \(ext.isEmpty ? "(none)" : "." + ext) is not a served image type")
        }
        return .ok(path: real, contentType: type)
    }

    static func realpath(_ p: String) -> String? {
        guard let resolved = Darwin.realpath(p, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }
}
