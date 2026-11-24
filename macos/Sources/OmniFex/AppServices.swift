import AppKit
import WebKit
import OmniFexCore

@MainActor
final class AppServices {
    let paths: AppPaths
    let version: String
    let daemon: DaemonLauncher
    let router = BridgeRouter<BridgeCaller>()
    let notifier: Notifier
    lazy var tabStatus = TabStatusStore { [weak self] list in
        self?.broadcast("tab-status:changed", list)
    }
    lazy var updates = UpdateController(services: self)
    lazy var pdf = PDFExporter(services: self)
    private var power: PowerMonitor?
    private var inFlightTimer: Timer?
    private var lastInFlight = -1

    private(set) var controllers: [BrowserWindowController] = []
    private var webViews: [Int: WeakWebView] = [:]
    private var nextSourceId = 1
    var quitAuthorized = false
    var dropStash = DropStash()

    /// Computed, never stored: the daemon's address is known only after `ensure`.
    var navigationPolicy: NavigationPolicy {
        NavigationPolicy(appOrigin: daemon.url.flatMap(DaemonEnsure.pageURL(fromWebSocket:)), devServer: paths.devServerURL)
    }

    init() {
        paths = AppPaths(environment: ProcessInfo.processInfo.environment, bundlePath: Bundle.main.bundlePath)
        version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        daemon = DaemonLauncher(paths: paths, version: version)
        notifier = Notifier(paths: paths)
    }

    func start() {
        NativeHandlers.register(on: router, services: self)
        let missing = router.missingHandlers()
        assert(missing.isEmpty, "native channels without a handler: \(missing)")
        if !missing.isEmpty { NSLog("[omnifex] native channels without a handler: %@", missing.joined(separator: ", ")) }

        notifier.onClick = { [weak self] tabId, id in
            guard let self else { return }
            NSApp.activate()
            self.controllers.first?.window?.makeKeyAndOrderFront(nil)
            self.broadcast("notification-clicked", ["tabId": tabId as Any? ?? NSNull(), "id": id as Any? ?? NSNull()])
        }
        power = PowerMonitor { [weak self] awake in self?.broadcast("system-power-state", ["awake": awake]) }

        inFlightTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.broadcastInFlightIfChanged() }
        }
        updates.pruneDownloads()
    }

    func newWindow() {
        let controller = BrowserWindowController(services: self)
        controllers.append(controller)
        controller.showWindow(nil)
        controller.start()
    }

    func windowClosed(_ controller: BrowserWindowController) {
        controllers.removeAll { $0 === controller }
    }

    func focusedController() -> BrowserWindowController? {
        controllers.first { $0.window?.isKeyWindow == true } ?? controllers.first
    }

    var anyWindowFocused: Bool {
        NSApp.isActive && controllers.contains { $0.window?.isKeyWindow == true }
    }

    func register(_ webView: WKWebView) -> Int {
        let id = nextSourceId
        nextSourceId += 1
        webViews[id] = WeakWebView(view: webView)
        return id
    }

    func unregister(_ sourceId: Int) {
        webViews[sourceId] = nil
        tabStatus.removeSource(sourceId)
    }

    func broadcast(_ channel: String, _ payload: Any) {
        webViews = webViews.filter { $0.value.view != nil }
        for entry in webViews.values { entry.view.map { Bridge.emit(channel, payload, to: $0) } }
    }

    func pageLoaded(_ webView: WKWebView) {
        Bridge.emit("session-inflight-count", ["count": tabStatus.workingTabIds().count], to: webView)
    }

    private func broadcastInFlightIfChanged() {
        let count = tabStatus.workingTabIds().count
        guard count != lastInFlight else { return }
        lastInFlight = count
        broadcast("session-inflight-count", ["count": count])
    }

    func mayQuit(over window: NSWindow?, daemonInFlight: Int?) -> Bool {
        let working = QuitPolicy.workingCount(local: tabStatus.workingTabIds().count, daemon: daemonInFlight)
        switch QuitPolicy.decide(workingCount: working, authorized: quitAuthorized) {
        case .allow:
            return true
        case .confirm(let prompt):
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = prompt.message
            alert.informativeText = prompt.detail
            // Cancel first: a stray Return must never pick the lossy option.
            alert.addButton(withTitle: "Cancel")
            alert.addButton(withTitle: "Quit anyway")
            guard alert.runModal() == .alertSecondButtonReturn else { return false }
            quitAuthorized = true
            return true
        }
    }

    func quitAuthorizedNow() {
        quitAuthorized = true
        NSApp.terminate(nil)
    }

    func willTerminate() {
        inFlightTimer?.invalidate()
        // The daemon must die with the app, or new macOS permission grants never reach its sessions.
        // Wait out stop's own timeout so Quit & Reopen never adopts a daemon still closing.
        daemon.stopSync(timeout: DaemonCLI.quitStopTimeout)
    }
}

struct WeakWebView {
    weak var view: WKWebView?
}

struct BridgeCaller {
    weak var webView: WKWebView?
    let sourceId: Int
    var window: NSWindow? { webView?.window }
}
