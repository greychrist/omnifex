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
        #expect(packaged.classify("http://127.0.0.1:3000/") == .external)
    }

    @Test func unparseableIsDenied() {
        #expect(packaged.classify("http://[bad") == .deny)
    }
}

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

    @Test func nothingMayCallBeforeThereIsAnAppOrigin() {
        let none = NavigationPolicy(appOrigin: nil, devServer: nil)
        #expect(!none.allowsBridge(isMainFrame: true, scheme: "http", host: "127.0.0.1", port: 47700))
    }
}
