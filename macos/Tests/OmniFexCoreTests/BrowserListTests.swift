import Testing
@testable import OmniFexCore

@Suite struct BrowserListTests {
    @Test func sortedByNameWithDuplicatesAndOmniFexDropped() {
        let entries = BrowserList.entries([
            .init(bundleId: "com.google.Chrome", name: "Google Chrome"),
            .init(bundleId: "com.apple.Safari", name: "Safari"),
            .init(bundleId: "com.google.Chrome", name: "Google Chrome"),
            .init(bundleId: "org.mozilla.firefox", name: "Firefox"),
            .init(bundleId: "com.greychrist.omnifex", name: "OmniFex"),
        ], excluding: "com.greychrist.omnifex")
        #expect(entries.map(\.bundleId) == ["org.mozilla.firefox", "com.google.Chrome", "com.apple.Safari"])
    }
    @Test func blankIdsAreDropped() {
        #expect(BrowserList.entries([.init(bundleId: "", name: "Ghost")], excluding: nil).isEmpty)
    }
    @Test func asBridgeValue() {
        let v = BrowserList.bridgeValue([.init(bundleId: "com.apple.Safari", name: "Safari")])
        #expect(v == [["bundleId": "com.apple.Safari", "name": "Safari"]])
    }
}
