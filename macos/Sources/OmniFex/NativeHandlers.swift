import AppKit
import WebKit
import UniformTypeIdentifiers
import OmniFexCore

/// One handler per native channel. Params arrive Electron-shaped (camelCase
/// or snake_case, sometimes a bare string) because the renderer still sends
/// them that way.
@MainActor
enum NativeHandlers {
    static func register(on r: BridgeRouter<BridgeCaller>, services s: AppServices) {
        // MARK: dialogs and Finder
        r.register("dialog:open") { p, caller in
            let config = DialogConfig.open(BridgeParams.dict(p) ?? [:], isDirectory: DialogConfig.diskIsDirectory)
            let panel = NSOpenPanel()
            apply(config, to: panel)
            panel.canChooseFiles = config.canChooseFiles
            panel.canChooseDirectories = config.canChooseDirectories
            panel.allowsMultipleSelection = config.allowsMultipleSelection
            guard await run(panel, over: caller.window) else { return nil }
            return panel.urls.map(\.path)
        }
        r.register("dialog:save") { p, caller in
            let config = DialogConfig.save(BridgeParams.dict(p) ?? [:], isDirectory: DialogConfig.diskIsDirectory)
            let panel = NSSavePanel()
            apply(config, to: panel)
            if let label = config.nameFieldLabel { panel.nameFieldLabel = label }
            if let name = config.nameFieldValue { panel.nameFieldStringValue = name }
            guard await run(panel, over: caller.window), let url = panel.url else { return nil }
            return url.path
        }
        r.register("shell:openExternal") { p, _ in
            guard let raw = BridgeParams.string(p, "url"), let url = URL(string: raw),
                  url.scheme == "https" || url.scheme == "http"
            else { throw BridgeError("Unsafe protocol") }
            NSWorkspace.shared.open(url)
            return nil
        }
        r.register("reveal_path_in_finder") { p, _ in
            guard let path = BridgeParams.string(p, "path"), !path.isEmpty else { throw BridgeError("reveal_path_in_finder: path is required") }
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
            return nil
        }
        // A file link clicked in a transcript. Failures surface as an alert:
        // the click has nowhere else to report to.
        r.register("open_path") { p, caller in
            guard let raw = BridgeParams.string(p, "path"), !raw.isEmpty else { throw BridgeError("open_path: path is required") }
            let cwd = BridgeParams.string(p, "cwd", "project_path")
            var problem: String?
            switch OpenPathPlanner.plan(raw, cwd: cwd, homeDir: NSHomeDirectory(), stat: OpenPathPlanner.diskStat) {
            case .reveal(let path): NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
            case .open(let path):
                if !NSWorkspace.shared.open(URL(fileURLWithPath: path)) { problem = "No application could open \(path)." }
            case .error(let message): problem = message
            }
            if let problem {
                let alert = NSAlert()
                alert.alertStyle = .warning
                alert.messageText = "Couldn't open the file"
                alert.informativeText = problem
                if let window = caller.window { alert.beginSheetModal(for: window) } else { alert.runModal() }
            }
            return nil
        }

        // MARK: window
        r.register("window:minimize") { _, caller in (caller.window ?? NSApp.keyWindow)?.miniaturize(nil); return nil }
        r.register("window:maximize") { _, caller in (caller.window ?? NSApp.keyWindow)?.zoom(nil); return nil }
        r.register("window:close") { _, caller in (caller.window ?? NSApp.keyWindow)?.performClose(nil); return nil }
        r.register("get_app_version") { _, _ in s.version }

        // MARK: updater
        r.register("updater:check") { _, _ in await s.updates.check() }
        r.register("updater:download") { p, caller in
            guard let url = BridgeParams.string(p, "url") else { throw BridgeError("updater:download: url is required") }
            return try await s.updates.download(url: url, assetName: BridgeParams.string(p, "assetName", "asset_name"), to: caller.webView)
        }
        r.register("updater:open") { p, _ in
            guard let path = BridgeParams.string(p, "filePath", "file_path") else { throw BridgeError("updater:open: filePath is required") }
            try s.updates.open(path)
            return nil
        }
        r.register("updater:install") { p, _ in
            guard let zip = BridgeParams.string(p, "zipPath", "zip_path", "url"),
                  let version = BridgeParams.string(p, "version", "expectedVersion", "expected_version")
            else { throw BridgeError("updater:install: zipPath and version are required") }
            try await s.updates.install(zipPath: zip, version: version, force: BridgeParams.bool(p, "force"))
            return ["success": true]
        }
        r.register("updater:install-cancel") { _, _ in s.updates.cancelInstall(); return ["success": true] }

        // MARK: cost report
        r.register("cost_report_export_pdf") { p, _ in
            guard let savePath = BridgeParams.string(p, "savePath", "save_path"), !savePath.isEmpty else {
                throw BridgeError("cost_report_export_pdf: savePath is required")
            }
            guard let hash = BridgeParams.string(p, "hash"), !hash.isEmpty else {
                throw BridgeError("cost_report_export_pdf: hash is required")
            }
            return try await s.pdf.export(hash: hash, savePath: savePath)
        }
        // Sender-scoped: the print view identifies itself by being the caller.
        r.register("cost_report_print_ready") { p, caller in
            s.pdf.reportReady(sourceId: caller.sourceId, metrics: BridgeParams.dict(p) ?? [:])
            return nil
        }

        // MARK: sounds and notifications
        r.register("preview_notification_sound") { p, _ in
            let id = BridgeParams.string(p, "id") ?? ""
            guard NotificationSound.isValid(id),
                  let path = NotificationSound.resolve(id, resourcesPath: s.paths.resourcesPath).playPath
            else { return ["played": false, "path": NSNull()] }
            s.notifier.play(path)
            return ["played": true, "path": path]
        }
        r.register("notify:show") { p, _ in
            s.notifier.show(
                title: BridgeParams.string(p, "title") ?? "OmniFex",
                subtitle: BridgeParams.string(p, "subtitle"),
                body: BridgeParams.string(p, "body") ?? "",
                isError: BridgeParams.bool(p, "isError"),
                tabId: BridgeParams.string(p, "tabId"),
                windowFocused: s.anyWindowFocused
            )
            return nil
        }

        // MARK: clipboard
        // The page has no async clipboard of its own: plain http is not a
        // secure context to WebKit. Text, HTML and PNG, in one pasteboard item.
        r.register("clipboard:write") { p, _ in
            let entries = ClipboardPayload.parse(p)
            guard !entries.isEmpty else { throw BridgeError("clipboard:write: nothing to write") }
            let item = NSPasteboardItem()
            for entry in entries {
                switch entry {
                case .text(let text): item.setString(text, forType: .string)
                case .html(let html): item.setString(html, forType: .html)
                case .png(let data): item.setData(data, forType: .png)
                }
            }
            NSPasteboard.general.clearContents()
            guard NSPasteboard.general.writeObjects([item]) else { throw BridgeError("clipboard:write: the pasteboard refused the write") }
            return nil
        }

        // MARK: tab status
        r.register("tab_status_publish") { p, caller in
            guard let summary = BridgeParams.dict(p, "summary") else { throw BridgeError("tab_status_publish requires summary.tabId") }
            do { try s.tabStatus.publishChecked(summary, source: caller.sourceId) }
            catch { throw BridgeError("tab_status_publish requires summary.tabId") }
            return ["success": true]
        }
        r.register("tab_status_remove") { p, _ in
            guard let tabId = BridgeParams.string(p, "tabId", "tab_id") else { throw BridgeError("tab_status_remove requires tabId") }
            s.tabStatus.remove(tabId)
            return ["success": true]
        }
        r.register("tab_status_list") { _, _ in s.tabStatus.list() }

        // MARK: daemon
        r.register("remote:url") { _, _ in
            if let url = s.daemon.url { return url }
            return try? await s.daemon.ensure().get()
        }
        // The Daemon popover's Restart button. The popover has already asked.
        r.register("remote:restart") { _, _ in
            ["url": (await s.daemon.restart()) as Any? ?? NSNull()]
        }
    }

    private static func apply(_ c: DialogConfig, to panel: NSSavePanel) {
        if let title = c.title { panel.title = title; panel.message = title }
        if let prompt = c.prompt { panel.prompt = prompt }
        panel.canCreateDirectories = c.canCreateDirectories
        panel.showsHiddenFiles = c.showsHiddenFiles
        if let exts = c.allowedExtensions {
            panel.allowedContentTypes = exts.compactMap { UTType(filenameExtension: $0) }
        }
        if let dir = c.directoryPath { panel.directoryURL = URL(fileURLWithPath: dir, isDirectory: true) }
    }

    private static func run(_ panel: NSSavePanel, over window: NSWindow?) async -> Bool {
        guard let window else { return panel.runModal() == .OK }
        return await withCheckedContinuation { cont in
            panel.beginSheetModal(for: window) { cont.resume(returning: $0 == .OK) }
        }
    }
}
