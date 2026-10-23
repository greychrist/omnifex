import Foundation
import Testing
@testable import OmniFexCore

@Suite struct ClipboardPayloadTests {
    @Test func textAndPng() {
        let entries = ClipboardPayload.parse(["items": [
            ["type": "text/plain", "text": "hi"],
            ["type": "image/png", "base64": "AQID"],
        ]])
        #expect(entries == [.text("hi"), .png(Data([1, 2, 3]))])
    }
    @Test func htmlIsKept() {
        #expect(ClipboardPayload.parse(["items": [["type": "text/html", "text": "<b>x</b>"]]]) == [.html("<b>x</b>")])
    }
    @Test func unknownTypesAndBadDataAreDropped() {
        let entries = ClipboardPayload.parse(["items": [
            ["type": "image/svg+xml", "text": "<svg/>"],
            ["type": "image/png", "base64": "%%%"],
            ["type": "text/plain"],
            "nonsense",
        ]])
        #expect(entries.isEmpty)
    }
    @Test func garbageIsEmpty() {
        #expect(ClipboardPayload.parse(nil).isEmpty)
        #expect(ClipboardPayload.parse("text").isEmpty)
    }
}
