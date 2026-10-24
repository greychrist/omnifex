import Foundation
import Testing
@testable import OmniFexCore

@Suite struct PdfPageSizeTests {
    @Test func normalReportIsOneToOne() {
        let s = PdfPageSize.compute(widthPx: 1200, heightPx: 3000)
        #expect(s.widthPx == 1200 && s.heightPx == 3000 && s.scale == 1)
    }
    @Test func tallReportIsScaledToTheCeiling() {
        let s = PdfPageSize.compute(widthPx: 1200, heightPx: 38400)
        #expect(s.scale == 0.5)
        #expect(s.scaledHeight == 19200)
        #expect(s.scaledWidth == 600)
    }
    @Test func garbageFallsBack() {
        let s = PdfPageSize.compute(widthPx: 0, heightPx: .nan)
        #expect(s.widthPx == 1152 && s.heightPx == 1152)
    }
}

@Suite struct DaemonEnsureTests {
    @Test func parsesTheLastJsonLine() throws {
        let out = "[remote] daemon started\n{\"url\":\"ws://127.0.0.1:47700/ws\",\"outdated\":false}\n\n"
        let r = try #require(DaemonEnsure.parse(stdout: out))
        #expect(r.url == "ws://127.0.0.1:47700/ws")
        #expect(r.outdated == false)
    }
    @Test func nullUrlAndOutdated() throws {
        let r = try #require(DaemonEnsure.parse(stdout: "{\"url\":null,\"outdated\":true}"))
        #expect(r.url == nil && r.outdated)
    }
    @Test func garbageIsNil() {
        #expect(DaemonEnsure.parse(stdout: "") == nil)
        #expect(DaemonEnsure.parse(stdout: "nope") == nil)
    }
    @Test func pageAndHealthFromWebSocketUrl() {
        #expect(DaemonEnsure.pageURL(fromWebSocket: "ws://100.64.1.2:47700/ws")?.absoluteString == "http://100.64.1.2:47700/")
        #expect(DaemonEnsure.healthURL(fromWebSocket: "ws://127.0.0.1:47701/ws")?.absoluteString == "http://127.0.0.1:47701/healthz")
        #expect(DaemonEnsure.pageURL(fromWebSocket: "nonsense") == nil)
    }
    @Test func healthInFlight() {
        #expect(DaemonEnsure.inFlight(fromHealth: Data("{\"sessions\":{\"inFlight\":2}}".utf8)) == 2)
        #expect(DaemonEnsure.inFlight(fromHealth: Data("{\"version\":\"x\"}".utf8)) == 0)
        #expect(DaemonEnsure.inFlight(fromHealth: Data("x".utf8)) == nil)
    }
}

@Suite struct BridgeRouterTests {
    @Test func everyNativeChannelIsKnown() {
        #expect(NativeChannels.invoke.contains("remote:url"))
        #expect(NativeChannels.invoke.contains("shell:listBrowsers"))
        #expect(NativeChannels.invoke.count == 25)
        #expect(NativeChannels.events.contains("session-inflight-count"))
    }

    @Test func unknownChannelsAreBlocked() async {
        let r = BridgeRouter<Int>()
        do { _ = try await r.dispatch("rm_rf", params: nil, context: 0); Issue.record("should throw") }
        catch { #expect("\(error.localizedDescription)" == "Blocked IPC channel: rm_rf") }
    }

    @Test func dispatchesAndReportsMissing() async throws {
        let r = BridgeRouter<Int>()
        r.register("get_app_version") { _, ctx in "v\(ctx)" }
        let v = try await r.dispatch("get_app_version", params: nil, context: 7)
        #expect(v as? String == "v7")
        #expect(r.missingHandlers().contains("remote:url"))
        #expect(!r.missingHandlers().contains("get_app_version"))
    }

    @Test func aKnownChannelWithoutAHandlerIsAnErrorToo() async {
        let r = BridgeRouter<Int>()
        do { _ = try await r.dispatch("remote:url", params: nil, context: 0); Issue.record("should throw") }
        catch { #expect(error.localizedDescription.contains("remote:url")) }
    }

    @Test func paramHelpers() {
        let p: Any = ["path": "/x", "project_path": "/p", "n": 3, "force": true]
        #expect(BridgeParams.string(p, "path") == "/x")
        #expect(BridgeParams.string(p, "cwd", "project_path") == "/p")
        #expect(BridgeParams.int(p, "n") == 3)
        #expect(BridgeParams.bool(p, "force") == true)
        // shell:openExternal crosses as a bare string.
        #expect(BridgeParams.string("https://x", "url") == "https://x")
    }
}

@Suite struct DialogOptionsTests {
    @Test func openDirectory() {
        let c = DialogConfig.open(["properties": ["openDirectory"], "title": "Select", "defaultPath": "/Users/me", "buttonLabel": "Pick"], isDirectory: { _ in true })
        #expect(c.canChooseDirectories && !c.canChooseFiles && !c.allowsMultipleSelection)
        #expect(c.title == "Select" && c.prompt == "Pick")
        #expect(c.directoryPath == "/Users/me" && c.nameFieldValue == nil)
    }
    @Test func openDefaultsToFiles() {
        let c = DialogConfig.open([:], isDirectory: { _ in false })
        #expect(c.canChooseFiles && !c.canChooseDirectories)
    }
    @Test func multiAndFilters() {
        let c = DialogConfig.open(["properties": ["openFile", "multiSelections", "showHiddenFiles"], "filters": [["name": "PDF", "extensions": ["pdf"]], ["name": "All", "extensions": ["*"]]]], isDirectory: { _ in false })
        #expect(c.allowsMultipleSelection && c.showsHiddenFiles)
        #expect(c.allowedExtensions == nil) // "*" lifts the restriction
        let d = DialogConfig.open(["filters": [["name": "PDF", "extensions": ["pdf", "PDF"]]]], isDirectory: { _ in false })
        #expect(d.allowedExtensions == ["pdf", "PDF"])
    }
    @Test func saveSplitsDefaultPath() {
        let c = DialogConfig.save(["defaultPath": "cost-report-all-time.pdf", "nameFieldLabel": "Project Name", "properties": ["createDirectory"]], isDirectory: { _ in false })
        #expect(c.nameFieldValue == "cost-report-all-time.pdf" && c.directoryPath == nil)
        #expect(c.nameFieldLabel == "Project Name" && c.canCreateDirectories)
        let d = DialogConfig.save(["defaultPath": "/Users/me/out.pdf"], isDirectory: { $0 == "/Users/me" })
        #expect(d.directoryPath == "/Users/me" && d.nameFieldValue == "out.pdf")
        let e = DialogConfig.save(["defaultPath": "/Users/me"], isDirectory: { $0 == "/Users/me" })
        #expect(e.directoryPath == "/Users/me" && e.nameFieldValue == nil)
    }
}

@Suite struct AppPathsTests {
    let bundle = "/Applications/OmniFex.app"
    @Test func packagedDefaults() {
        let p = AppPaths(environment: ["HOME": "/Users/me"], bundlePath: bundle)
        #expect(p.node == "\(bundle)/Contents/MacOS/omnifexd")
        #expect(p.daemonScript == "\(bundle)/Contents/Resources/app/build/omnifex-server.js")
        #expect(p.resourcesPath == "\(bundle)/Contents/Resources")
        #expect(p.devServerURL == nil && !p.isDev)
        #expect(p.userDataDir == "/Users/me/Library/Application Support/OmniFex")
        #expect(p.settingsDatabase == "/Users/me/Library/Application Support/OmniFex/greychrist.db")
        #expect(p.daemonLog == "/Users/me/Library/Logs/omnifex-server.log")
    }
    @Test func overrides() {
        let p = AppPaths(environment: ["HOME": "/Users/me", "OMNIFEX_NODE": "/n", "OMNIFEX_DAEMON_SCRIPT": "/s.js", "OMNIFEX_DEV_SERVER_URL": "http://localhost:5173/", "OMNIFEX_USER_DATA_DIR": "/tmp/ud"], bundlePath: bundle)
        #expect(p.node == "/n" && p.daemonScript == "/s.js")
        #expect(p.devServerURL?.absoluteString == "http://localhost:5173/" && p.isDev)
        #expect(p.userDataDir == "/tmp/ud")
    }
    @Test func emptyOverridesCountAsUnset() {
        let p = AppPaths(environment: ["HOME": "/Users/me", "OMNIFEX_NODE": "", "OMNIFEX_DEV_SERVER_URL": ""], bundlePath: bundle)
        #expect(p.node == "\(bundle)/Contents/MacOS/omnifexd" && !p.isDev)
    }
}

@Suite struct SettingsReaderTests {
    @Test func readsAValueAndToleratesAbsence() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("settings-\(UUID().uuidString)").path
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let db = dir + "/greychrist.db"
        #expect(SettingsReader(path: db).value(for: "x") == nil) // no file: no throw, no create
        #expect(!FileManager.default.fileExists(atPath: db))
        try SettingsReader.testCreate(path: db, rows: ["notification_sound_success": "Glass"])
        let r = SettingsReader(path: db)
        #expect(r.value(for: "notification_sound_success") == "Glass")
        #expect(r.value(for: "missing") == nil)
        try SettingsReader.testCreate(path: dir + "/empty.db", rows: nil)
        #expect(SettingsReader(path: dir + "/empty.db").value(for: "x") == nil) // no table
    }
}
