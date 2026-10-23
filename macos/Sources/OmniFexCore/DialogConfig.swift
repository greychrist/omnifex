import Foundation

/// Electron-shaped `showOpenDialog` / `showSaveDialog` options, as the renderer
/// still sends them, read into what an NSOpenPanel / NSSavePanel needs.
public struct DialogConfig: Equatable, Sendable {
    public var title: String?
    public var prompt: String?
    public var nameFieldLabel: String?
    public var canChooseFiles = true
    public var canChooseDirectories = false
    public var allowsMultipleSelection = false
    public var canCreateDirectories = false
    public var showsHiddenFiles = false
    /// nil = any file. A `*` filter lifts the restriction, as in Electron.
    public var allowedExtensions: [String]?
    public var directoryPath: String?
    public var nameFieldValue: String?

    static func properties(_ o: [String: Any]) -> Set<String> {
        Set((o["properties"] as? [String]) ?? [])
    }

    static func extensions(_ o: [String: Any]) -> [String]? {
        guard let filters = o["filters"] as? [[String: Any]], !filters.isEmpty else { return nil }
        let exts = filters.flatMap { ($0["extensions"] as? [String]) ?? [] }
        if exts.isEmpty || exts.contains("*") { return nil }
        return exts
    }

    static func split(_ o: [String: Any], into c: inout DialogConfig, isDirectory: (String) -> Bool) {
        guard let path = o["defaultPath"] as? String, !path.isEmpty else { return }
        if isDirectory(path) {
            c.directoryPath = path
        } else if path.contains("/") {
            c.directoryPath = (path as NSString).deletingLastPathComponent
            c.nameFieldValue = (path as NSString).lastPathComponent
        } else {
            c.nameFieldValue = path
        }
    }

    public static func open(_ o: [String: Any], isDirectory: (String) -> Bool) -> DialogConfig {
        let props = properties(o)
        var c = DialogConfig()
        c.title = o["title"] as? String
        c.prompt = o["buttonLabel"] as? String
        c.canChooseDirectories = props.contains("openDirectory")
        // Electron opens files unless told otherwise; asking for directories
        // alone means directories only.
        c.canChooseFiles = props.contains("openFile") || !c.canChooseDirectories
        c.allowsMultipleSelection = props.contains("multiSelections")
        c.canCreateDirectories = props.contains("createDirectory") || c.canChooseDirectories
        c.showsHiddenFiles = props.contains("showHiddenFiles")
        c.allowedExtensions = extensions(o)
        split(o, into: &c, isDirectory: isDirectory)
        // An open panel has no name field to put a file name in.
        c.nameFieldValue = nil
        return c
    }

    public static func save(_ o: [String: Any], isDirectory: (String) -> Bool) -> DialogConfig {
        let props = properties(o)
        var c = DialogConfig()
        c.title = o["title"] as? String
        c.prompt = o["buttonLabel"] as? String
        c.nameFieldLabel = o["nameFieldLabel"] as? String
        c.canCreateDirectories = props.contains("createDirectory")
        c.showsHiddenFiles = props.contains("showHiddenFiles")
        c.allowedExtensions = extensions(o)
        split(o, into: &c, isDirectory: isDirectory)
        return c
    }

    public static func diskIsDirectory(_ path: String) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && isDir.boolValue
    }
}
