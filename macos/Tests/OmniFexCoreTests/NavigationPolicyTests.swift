import Foundation
import Testing
@testable import OmniFexCore

@Suite struct NavigationPolicyTests {
    let packaged = NavigationPolicy(appOrigin: URL(string: "http://127.0.0.1:47700/"), devServer: nil)
    let dev = NavigationPolicy(appOrigin: nil, devServer: URL(string: "http://localhost:5173/"))

    @Test func allowsTheAppPage() {
        #expect(packaged.classify("http://127.0.0.1:47700/") == .allow)
        #expect(packaged.classify("http://127.0.0.1:47700/index.html") == .allow)
        #expect(packaged.classify("http://127.0.0.1:47700/#/settings") == .allow)
    }

    // A transcript link to `/Users/me/report.md` resolves against the page
    // origin. Allowing the whole origin let one click replace the app window
    // with the file (2026-10-22).
    @Test func deniesOtherPathsOnTheAppOrigin() {
        #expect(packaged.classify("http://127.0.0.1:47700/Users/me/report.md") == .deny)
    }

    @Test func deniesFileAndCustomSchemes() {
        #expect(packaged.classify("file:///Users/me/report.md") == .deny)
        #expect(packaged.classify("greychrist-file:///tmp/image.png") == .deny)
        #expect(packaged.classify("javascript:alert(1)") == .deny)
    }

    @Test func allowsAboutBlankAndEmpty() {
        #expect(packaged.classify("about:blank") == .allow)
        #expect(packaged.classify("") == .allow)
    }

    @Test func devServerIndexIsAllowedOtherPathsDenied() {
        #expect(dev.classify("http://localhost:5173/index.html") == .allow)
        #expect(dev.classify("http://localhost:5173/#/x") == .allow)
        #expect(dev.classify("http://localhost:5173/Users/me/draft.md") == .deny)
    }

    @Test func otherWebUrlsAreExternal() {
        #expect(dev.classify("http://example.com/page") == .external)
        #expect(packaged.classify("https://anthropic.com") == .external)
        // Same host, different port: a different origin.
        #expect(packaged.classify("http://127.0.0.1:3000/") == .external)
    }

    @Test func unparseableIsDenied() {
        #expect(packaged.classify("http://[bad") == .deny)
    }
}

/// Who may call the native bridge. The page shows link previews of arbitrary
/// URLs in iframes; a frame from one of them reaching `updater:download` and
/// `updater:install` would be code execution. Electron never had the question:
/// its preload ran in the main frame only.
@Suite struct BridgeAccessTests {
    let packaged = NavigationPolicy(appOrigin: URL(string: "http://100.64.0.1:47700/"), devServer: nil)
    let dev = NavigationPolicy(appOrigin: nil, devServer: URL(string: "http://localhost:5173/"))

    @Test func theAppPageMayCall() {
        #expect(packaged.allowsBridge(isMainFrame: true, scheme: "http", host: "100.64.0.1", port: 47700))
        #expect(dev.allowsBridge(isMainFrame: true, scheme: "http", host: "localhost", port: 5173))
    }

    @Test func noFrameMayCall() {
        #expect(!packaged.allowsBridge(isMainFrame: false, scheme: "http", host: "100.64.0.1", port: 47700))
    }

    @Test func noOtherOriginMayCall() {
        #expect(!packaged.allowsBridge(isMainFrame: true, scheme: "https", host: "evil.example", port: 0))
        #expect(!packaged.allowsBridge(isMainFrame: true, scheme: "http", host: "100.64.0.1", port: 3000))
    }

    // Before the daemon answers there is no app origin, and nothing may call.
    @Test func nothingMayCallBeforeThereIsAnAppOrigin() {
        let none = NavigationPolicy(appOrigin: nil, devServer: nil)
        #expect(!none.allowsBridge(isMainFrame: true, scheme: "http", host: "127.0.0.1", port: 47700))
    }
}
