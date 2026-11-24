import Foundation
import Testing
@testable import OmniFexCore

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

    @Test func webLinksStayExternal() {
        #expect(packaged.classify("https://example.com/file.zip", isDownload: true) == .external)
    }
}
