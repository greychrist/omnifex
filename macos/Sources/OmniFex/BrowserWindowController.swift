import AppKit
import WebKit
import UniformTypeIdentifiers
import OmniFexCore

/// One OmniFex window: a native "starting" view while the daemon comes up,
/// then the renderer the daemon serves.
@MainActor
final class BrowserWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    static let background = NSColor(srgbRed: 0x1a / 255, green: 0x1a / 255, blue: 0x2e / 255, alpha: 1)

    private unowned let services: AppServices
    let webView: WKWebView
    let sourceId: Int
    private let overlay = StatusOverlay()
    private var loaded = false

    init(services: AppServices) {
        self.services = services
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1400, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.minSize = NSSize(width: 800, height: 600)
        window.backgroundColor = Self.background
        window.title = "OmniFex"
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        (webView, sourceId) = WebViewFactory.make(services: services, frame: window.contentLayoutRect)
        super.init(window: window)
        window.delegate = self
        // The first window remembers its frame; later ones cascade off the
        // frontmost so New Window never lands exactly on top of another.
        if let front = services.controllers.last?.window {
            window.setFrameTopLeftPoint(window.cascadeTopLeft(from: NSPoint(x: front.frame.minX, y: front.frame.maxY)))
        } else {
            window.setFrameAutosaveName("OmniFexMainWindow")
            if !window.setFrameUsingName("OmniFexMainWindow") { window.center() }
        }

        let container = NSView(frame: window.contentLayoutRect)
        container.autoresizingMask = [.width, .height]
        webView.frame = container.bounds
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        container.addSubview(webView)
        overlay.frame = container.bounds
        overlay.autoresizingMask = [.width, .height]
        overlay.onRetry = { [weak self] in self?.start() }
        container.addSubview(overlay)
        window.contentView = container
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// Ensure the daemon, then load its page.
    func start() {
        overlay.showStarting()
        Task {
            let result = await services.daemon.ensure()
            switch result {
            case .success:
                guard let page = services.daemon.pageURL else {
                    overlay.showError("The daemon answered without an address.", logPath: services.paths.daemonLog)
                    return
                }
                webView.load(URLRequest(url: page))
            case .failure(let error):
                overlay.showError(error.localizedDescription, logPath: services.paths.daemonLog)
            }
        }
    }

    // MARK: - Menu-driven actions

    func confirmAndReload() {
        guard loaded else { return start() }
        let prompt = ReloadPolicy.prompt(workingCount: services.tabStatus.workingTabIds().count)
        let alert = NSAlert()
        alert.messageText = prompt.message
        alert.informativeText = prompt.detail
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Reload")
        guard let window else { return }
        alert.beginSheetModal(for: window) { [weak self] response in
            if response == .alertSecondButtonReturn { self?.webView.reload() }
        }
    }

    /// WKWebView has no public API to open the inspector. The private
    /// `_inspector.show` is the shortcut, used only if present, and works only
    /// with `developerExtrasEnabled` set (`WebViewFactory`).
    func toggleInspector() {
        let getter = Selector(("_inspector"))
        guard webView.responds(to: getter),
              let inspector = webView.perform(getter)?.takeUnretainedValue() as? NSObject
        else { return }
        let isVisible = Selector(("isVisible"))
        let visible = inspector.responds(to: isVisible) && (inspector.value(forKey: "isVisible") as? Bool ?? false)
        let action = Selector((visible ? "close" : "show"))
        if inspector.responds(to: action) { inspector.perform(action) }
    }

    func setZoom(_ zoom: CGFloat) { webView.pageZoom = zoom }
    func adjustZoom(by delta: CGFloat) { webView.pageZoom = min(3, max(0.3, webView.pageZoom + delta)) }

    // MARK: - NSWindowDelegate

    func windowDidBecomeKey(_ notification: Notification) {
        services.notifier.userIsLooking()
    }

    /// Closing the last window is a quit, so it asks the question ⌘Q asks —
    /// here, while there is still a window to go back to on Cancel.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard services.controllers.count == 1 else { return true }
        return services.mayQuit(over: sender)
    }

    func windowWillClose(_ notification: Notification) {
        services.unregister(sourceId)
        webView.configuration.userContentController.removeAllScriptMessageHandlers()
        services.windowClosed(self)
    }

    // MARK: - WKNavigationDelegate

    private var policy: NavigationPolicy { services.navigationPolicy }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        // Only the top-level page is guarded. Frames are the link previews'
        // iframes, which exist to show other sites.
        guard action.targetFrame?.isMainFrame ?? true, let url = action.request.url else {
            return decisionHandler(.allow)
        }
        switch policy.classify(url.absoluteString, isDownload: action.shouldPerformDownload) {
        case .allow: decisionHandler(.allow)
        case .download: decisionHandler(.download)
        case .external:
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        case .deny: decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    // MARK: - WKDownloadDelegate

    /// Where a page-made download goes: a save panel over this window, as
    /// Electron gave it, starting in Downloads with the page's file name.
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping @MainActor @Sendable (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.canCreateDirectories = true
        let finish: (NSApplication.ModalResponse) -> Void = { response in
            guard response == .OK, let url = panel.url else { return completionHandler(nil) }
            // The panel already asked about replacing; WKDownload refuses an existing file.
            try? FileManager.default.removeItem(at: url)
            completionHandler(url)
        }
        if let window { panel.beginSheetModal(for: window, completionHandler: finish) } else { finish(panel.runModal()) }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        NSLog("[omnifex] download failed: %@", error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        // A page going away never unmounts its tabs, so their published
        // statuses are retired here; the new page republishes its own.
        services.tabStatus.removeSource(sourceId)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        overlay.hide()
        services.pageLoaded(webView)
        SmokeSnapshot.capture(webView, id: sourceId)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        loaded = false
        overlay.showError("The page did not load: \(error.localizedDescription)", logPath: services.paths.daemonLog)
    }

    /// The page's process died (memory, crash). The daemon still has every
    /// session; reloading the page re-attaches to them.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        services.tabStatus.removeSource(sourceId)
        webView.reload()
    }

    // MARK: - WKUIDelegate

    /// `window.open` / `target=_blank`: never a second in-app browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, policy.classify(url.absoluteString) == .external {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    // WKWebView ignores alert/confirm/prompt without these; `confirm()` would
    // silently return false.
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }

    /// `<input type="file">` does nothing in WKWebView without this.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        guard let window else { return completionHandler(nil) }
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }
}

/// "Starting OmniFex…", or what went wrong and a Retry.
@MainActor
final class StatusOverlay: NSView {
    var onRetry: (() -> Void)?
    private let spinner = NSProgressIndicator()
    private let title = NSTextField(labelWithString: "")
    private let detail = NSTextField(wrappingLabelWithString: "")
    private let retry = NSButton(title: "Retry", target: nil, action: nil)

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = BrowserWindowController.background.cgColor
        spinner.style = .spinning
        spinner.controlSize = .regular
        title.font = .systemFont(ofSize: 17, weight: .semibold)
        title.textColor = .white
        detail.textColor = .secondaryLabelColor
        detail.isSelectable = true
        detail.alignment = .center
        detail.preferredMaxLayoutWidth = 520
        retry.target = self
        retry.action = #selector(retryClicked)
        retry.bezelStyle = .push
        let stack = NSStackView(views: [spinner, title, detail, retry])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 560),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func showStarting() {
        isHidden = false
        spinner.isHidden = false
        spinner.startAnimation(nil)
        title.stringValue = "Starting OmniFex…"
        detail.stringValue = ""
        detail.isHidden = true
        retry.isHidden = true
    }

    func showError(_ message: String, logPath: String) {
        isHidden = false
        spinner.stopAnimation(nil)
        spinner.isHidden = true
        title.stringValue = "OmniFex could not reach its daemon"
        detail.stringValue = "\(message)\n\nDaemon log: \(logPath)"
        detail.isHidden = false
        retry.isHidden = false
    }

    func hide() {
        spinner.stopAnimation(nil)
        isHidden = true
    }

    @objc private func retryClicked() { onRetry?() }

    // Clicks never fall through to the web view underneath.
    override func hitTest(_ point: NSPoint) -> NSView? { isHidden ? nil : super.hitTest(point) }
}
