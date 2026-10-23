import Foundation
import Testing
@testable import OmniFexCore

@Suite struct TabStatusStoreTests {
    final class Sink { var calls: [[[String: Any]]] = [] }

    func make() -> (TabStatusStore, Sink) {
        let sink = Sink()
        let store = TabStatusStore { sink.calls.append($0) }
        return (store, sink)
    }

    func s(_ id: String, busy: Bool = false, prompt: String = "ready", title: String = "t") -> [String: Any] {
        ["tabId": id, "title": title, "busy": busy, "updatedAt": 1, "promptStatus": prompt]
    }

    @Test func publishBroadcastsInInsertionOrder() {
        let (store, sink) = make()
        store.publish(s("a"), source: 1)
        store.publish(s("b"), source: 1)
        #expect(sink.calls.count == 2)
        #expect(store.list().map { $0["tabId"] as? String } == ["a", "b"])
    }

    @Test func identicalRepublishIsSilent() {
        let (store, sink) = make()
        store.publish(s("a"), source: 1)
        store.publish(s("a"), source: 1)
        #expect(sink.calls.count == 1)
        store.publish(s("a", busy: true), source: 1)
        #expect(sink.calls.count == 2)
        // Updating keeps the tab's position.
        store.publish(s("b"), source: 1)
        store.publish(s("a", title: "new"), source: 1)
        #expect(store.list().map { $0["tabId"] as? String } == ["a", "b"])
    }

    @Test func removeAndClear() {
        let (store, sink) = make()
        store.publish(s("a"), source: 1)
        store.remove("missing")
        #expect(sink.calls.count == 1)
        store.remove("a")
        #expect(store.list().isEmpty)
        store.clearAll()
        #expect(sink.calls.count == 2)
        store.publish(s("b"), source: 1)
        store.clearAll()
        #expect(sink.calls.last?.isEmpty == true)
    }

    // A reload tears the page down before any unmount effect can land, so
    // its tabs outlived it as phantom "working" sessions.
    @Test func removeSourceRetiresOnlyThatSource() {
        let (store, _) = make()
        store.publish(s("a"), source: 1)
        store.publish(s("b"), source: 2)
        store.removeSource(1)
        #expect(store.list().map { $0["tabId"] as? String } == ["b"])
    }

    @Test func republishByANewSourceReattributes() {
        let (store, _) = make()
        store.publish(s("a"), source: 1)
        store.publish(s("a"), source: 2) // identical payload, new page
        store.removeSource(1)
        #expect(store.list().count == 1)
    }

    @Test func busyAndWorking() {
        let (store, _) = make()
        store.publish(s("a", busy: true, prompt: "ready"), source: 1)
        store.publish(s("b", busy: true, prompt: "working"), source: 1)
        store.publish(s("c"), source: 1)
        #expect(store.busyTabIds() == ["a", "b"])
        #expect(store.workingTabIds() == ["b"])
    }

    @Test func rejectsASummaryWithoutTabId() {
        let (store, _) = make()
        #expect(throws: TabStatusStore.Invalid.self) { try store.publishChecked(["title": "x"], source: 1) }
    }
}
