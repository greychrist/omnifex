import AppKit
import WebKit
import OmniFexCore

enum Bridge {
    static let handlerName = "omnifex"

    static let script = """
    (() => {
      if (window.__omnifexNative) return;
      const listeners = new Map();
      const port = window.webkit.messageHandlers.\(handlerName);
      window.__omnifexNative = Object.freeze({
        invoke(channel, params) {
          return port.postMessage({ channel: String(channel), params: params === undefined ? null : params });
        },
        onEvent(channel, callback) {
          let set = listeners.get(channel);
          if (!set) { set = new Set(); listeners.set(channel, set); }
          set.add(callback);
          return () => { set.delete(callback); };
        },
      });
      Object.defineProperty(window, '__omnifexNativeEmit', {
        value(channel, args) {
          const set = listeners.get(channel);
          if (!set) return;
          for (const cb of [...set]) {
            try { cb(...args); } catch (err) { console.error('[native] listener for ' + channel + ' threw', err); }
          }
        },
      });
    })();
    """

    /// Main actor only: WebKit kills the process on an off-main call.
    @MainActor
    static func emit(_ channel: String, _ payload: Any, to webView: WKWebView) {
        guard let channelJSON = json(channel), let argsJSON = json([payload]) else { return }
        webView.evaluateJavaScript("window.__omnifexNativeEmit && window.__omnifexNativeEmit(\(channelJSON), \(argsJSON))")
    }

    static func json(_ value: Any) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    static func replyValue(_ value: Any?) -> Any {
        guard let value else { return NSNull() }
        if let d = value as? [String: Any?] { return d.mapValues { replyValue($0) } }
        return value
    }

    static func unwrap(_ value: Any?) -> Any? {
        value is NSNull ? nil : value
    }
}

@MainActor
final class BridgeMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var services: AppServices?
    let sourceId: Int

    init(services: AppServices, sourceId: Int) {
        self.services = services
        self.sourceId = sourceId
    }

    func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
    ) {
        guard let services,
              let body = message.body as? [String: Any],
              let channel = body["channel"] as? String
        else {
            replyHandler(nil, "Malformed native call")
            return
        }
        // Main frame on the app's origin only: link previews put other sites in iframes of this page.
        let origin = message.frameInfo.securityOrigin
        guard services.navigationPolicy.allowsBridge(
            isMainFrame: message.frameInfo.isMainFrame,
            scheme: origin.protocol,
            host: origin.host,
            port: origin.port
        ) else {
            replyHandler(nil, "Blocked IPC channel: \(channel) (not the app's frame)")
            return
        }
        let caller = BridgeCaller(webView: message.webView, sourceId: sourceId)
        let params = Bridge.unwrap(body["params"])
        Task { @MainActor in
            do {
                let result = try await services.router.dispatch(channel, params: params, context: caller)
                replyHandler(Bridge.replyValue(result), nil)
            } catch {
                replyHandler(nil, error.localizedDescription)
            }
        }
    }
}

final class GreychristFileSchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        guard let url = task.request.url else { return fail(task) }
        switch ProtocolFilePolicy.resolve(ProtocolFilePolicy.requestedPath(from: url)) {
        case .ok(let path, let type):
            guard let data = FileManager.default.contents(atPath: path) else { return fail(task) }
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
                "Content-Type": type,
                "Content-Length": String(data.count),
            ])!
            task.didReceive(response)
            task.didReceive(data)
            task.didFinish()
        case .refused(let reason):
            NSLog("[protocol] greychrist-file refused: %@", reason)
            fail(task)
        }
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}

    private func fail(_ task: any WKURLSchemeTask) {
        task.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist))
    }
}

/// One content controller per web view, so a message's sender is known without trusting the page.
@MainActor
enum WebViewFactory {
    static let schemeHandler = GreychristFileSchemeHandler()

    static func make(services: AppServices, frame: NSRect) -> (WKWebView, Int) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.setURLSchemeHandler(schemeHandler, forURLScheme: ProtocolFilePolicy.scheme)
        config.preferences.isElementFullscreenEnabled = true
        // The in-window inspector needs this private preference, or `_inspector.show` is a silent no-op.
        // Guarded: an unknown KVC key crashes at launch.
        if config.preferences.responds(to: Selector(("_setDeveloperExtrasEnabled:"))) {
            config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        }
        let content = WKUserContentController()
        content.addUserScript(WKUserScript(source: Bridge.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = content

        let webView = DropAwareWebView(frame: frame, configuration: config)
        webView.services = services
        let sourceId = services.register(webView)
        content.addScriptMessageHandler(BridgeMessageHandler(services: services, sourceId: sourceId), contentWorld: .page, name: Bridge.handlerName)
        webView.isInspectable = true
        // No white flash before the first paint.
        webView.underPageBackgroundColor = BrowserWindowController.background
        webView.setValue(false, forKey: "drawsBackground")
        return (webView, sourceId)
    }
}

/// Stashes drop paths before `super`: the page gets only bytes, and asks for paths over `drop:paths` during the drop.
final class DropAwareWebView: WKWebView {
    weak var services: AppServices?

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        let urls = sender.draggingPasteboard.readObjects(
            forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]
        ) as? [URL] ?? []
        services?.dropStash.put(urls.map(\.path), at: Date().timeIntervalSince1970)
        return super.performDragOperation(sender)
    }
}
