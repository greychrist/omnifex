import AppKit
import WebKit
import OmniFexCore

/// Everything the windows share: the daemon, the native-channel router, the
/// tab-status aggregator, notifications, the updater. One per process.
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
    /// Every bridged web view, windows and the hidden PDF print view alike,
    /// keyed by the id tab-status attributes summaries to.
    private var webViews: [Int: WeakWebView] = [:]
    private var nextSourceId = 1
    /// A quit the user already agreed to, or one the installer drives.
    var quitAuthorized = false

    /// What every web view may navigate to — and which frames may call the
    /// bridge. Read fresh: the daemon's address is known only after `ensure`.
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

        notifier.onClick = { [weak self] tabId in
            guard let self else { return }
            NSApp.activate()
            self.controllers.first?.window?.makeKeyAndOrderFront(nil)
            self.broadcast("notification-clicked", ["tabId": tabId as Any? ?? NSNull()])
        }
        power = PowerMonitor { [weak self] awake in self?.broadcast("system-power-state", ["awake": awake]) }

        // Titlebar's update warning: how many sessions are genuinely mid-turn.
        // A 1 s poll is plenty — the count changes per turn, not per message.
        inFlightTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.broadcastInFlightIfChanged() }
        }
        updates.pruneDownloads()
    }

    // MARK: - Windows and web views

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

    /// A fresh id for a bridged web view.
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

    // MARK: - Quit

    /// The gate for every quit path; false only when the user cancels.
    /// "Quit anyway" latches `quitAuthorized` so the rest of the same quit
    /// (each window closing, then terminate) does not ask again.
    func mayQuit(over window: NSWindow?) -> Bool {
        switch QuitPolicy.decide(workingCount: tabStatus.workingTabIds().count, authorized: quitAuthorized) {
        case .allow:
            return true
        case .confirm(let prompt):
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = prompt.message
            alert.informativeText = prompt.detail
            // Cancel is both the default and the escape hatch: the lossy
            // option is never what a stray Return picks.
            alert.addButton(withTitle: "Cancel")
            alert.addButton(withTitle: "Quit anyway")
            guard alert.runModal() == .alertSecondButtonReturn else { return false }
            quitAuthorized = true
            return true
        }
    }

    /// Quit without re-asking: the user asked for the update, and the
    /// installer ran its own busy-session gate.
    func quitAuthorizedNow() {
        quitAuthorized = true
        NSApp.terminate(nil)
    }

    func willTerminate() {
        inFlightTimer?.invalidate()
        // The dev daemon exists for this run only; the real one outliving the
        // app is the whole point of the split and is never touched here.
        if paths.isDev { daemon.stopSync(timeout: 2) }
    }
}

struct WeakWebView {
    weak var view: WKWebView?
}

/// Who sent a native call.
struct BridgeCaller {
    weak var webView: WKWebView?
    let sourceId: Int
    var window: NSWindow? { webView?.window }
}
