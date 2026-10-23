import Foundation
import Testing
@testable import OmniFexCore

/// `<a download href="blob:…">` — save image, export appearance, save
/// diagram. WKWebView does nothing with these unless the navigation is turned
/// into a download; the policy used to deny the `blob` scheme outright.
@Suite struct NavigationDownloadTests {
    let packaged = NavigationPolicy(appOrigin: URL(string: "http://127.0.0.1:47700/"), devServer: nil)
    let dev = NavigationPolicy(appOrigin: nil, devServer: URL(string: "http://localhost:5173/"))

    @Test func pageMadeBlobsAndDataDownload() {
        #expect(packaged.classify("blob:http://127.0.0.1:47700/6b1e-uuid", isDownload: true) == .download)
        #expect(dev.classify("blob:http://localhost:5173/6b1e-uuid", isDownload: true) == .download)
        #expect(packaged.classify("data:image/png;base64,AQID", isDownload: true) == .download)
    }

    @Test func blobsFromAnotherOriginDoNot() {
        #expect(packaged.classify("blob:https://evil.example/uuid", isDownload: true) == .deny)
    }

    @Test func withoutTheDownloadAttributeNothingChanges() {
        #expect(packaged.classify("blob:http://127.0.0.1:47700/uuid") == .deny)
        #expect(packaged.classify("data:text/html,hi") == .deny)
    }

    // A download attribute on an ordinary web link is still a link out.
    @Test func webLinksStayExternal() {
        #expect(packaged.classify("https://example.com/file.zip", isDownload: true) == .external)
    }
}
