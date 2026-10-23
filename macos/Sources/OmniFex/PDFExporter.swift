import AppKit
import WebKit
import OmniFexCore

/// Cost Report → PDF.
///
/// The report is rendered a second time in a hidden web view and that view is
/// turned into one tall PDF page, rather than capturing the visible one: the
/// live report sits inside `h-screen` / `overflow-hidden` wrappers, so the
/// on-screen document is exactly one window tall. The print view reports when
/// it has painted (`cost_report_print_ready`) with the size to capture.
@MainActor
final class PDFExporter {
    private unowned let services: AppServices
    private var pending: [Int: CheckedContinuation<[String: Any], Error>] = [:]
    static let readyTimeout: TimeInterval = 30

    init(services: AppServices) { self.services = services }

    func reportReady(sourceId: Int, metrics: [String: Any]) {
        pending.removeValue(forKey: sourceId)?.resume(returning: metrics)
    }

    func export(hash: String, savePath: String) async throws -> [String: Any] {
        guard let base = services.daemon.pageURL else { throw BridgeError("Cost report PDF: the daemon is not running") }
        guard let url = URL(string: base.absoluteString + (hash.hasPrefix("#") ? hash : "#" + hash)) else {
            throw BridgeError("Cost report PDF: bad print hash")
        }

        // Ordered in but invisible and off every screen: a view outside a
        // window is throttled, and recharts sizes itself from a ResizeObserver
        // that a throttled view never fires — the chart came out zero-width.
        let window = NSWindow(contentRect: NSRect(x: -30000, y: -30000, width: 1280, height: 1200), styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        let (webView, sourceId) = WebViewFactory.make(services: services, frame: NSRect(x: 0, y: 0, width: 1280, height: 1200))
        window.contentView = webView
        window.orderFrontRegardless()
        defer {
            pending.removeValue(forKey: sourceId)
            services.unregister(sourceId)
            webView.configuration.userContentController.removeAllScriptMessageHandlers()
            window.orderOut(nil)
            window.close()
        }

        webView.load(URLRequest(url: url))
        let metrics = try await waitForReady(sourceId)

        if (metrics["chartExpected"] as? Bool) == true && (metrics["chartRendered"] as? Bool) != true {
            NSLog("[cost-report-pdf] the spend chart reported no size before printing — the chart panel in this PDF may be blank.")
        }
        let size = PdfPageSize.compute(
            widthPx: (metrics["widthPx"] as? NSNumber)?.doubleValue ?? 0,
            heightPx: (metrics["heightPx"] as? NSNumber)?.doubleValue ?? 0
        )
        webView.pageZoom = size.scale
        let frame = NSRect(x: 0, y: 0, width: size.scaledWidth, height: size.scaledHeight)
        window.setContentSize(frame.size)
        webView.frame = frame
        try await Task.sleep(for: .milliseconds(300)) // one layout pass at the new size

        let config = WKPDFConfiguration()
        config.rect = frame
        let data = try await webView.pdf(configuration: config)
        try data.write(to: URL(fileURLWithPath: savePath))
        return ["path": savePath]
    }

    private func waitForReady(_ sourceId: Int) async throws -> [String: Any] {
        try await withCheckedThrowingContinuation { cont in
            pending[sourceId] = cont
            Timer.scheduledTimer(withTimeInterval: Self.readyTimeout, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.pending.removeValue(forKey: sourceId)?.resume(throwing: BridgeError(
                        "Cost report PDF: the report never finished rendering. Nothing was written — " +
                        "a PDF printed at this point would be blank or half-drawn."
                    ))
                }
            }
        }
    }
}
