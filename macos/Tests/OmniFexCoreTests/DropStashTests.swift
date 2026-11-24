import Foundation
import Testing
@testable import OmniFexCore

@Suite struct DropStashTests {
    @Test func takeReturnsWhatWasPutAndClears() {
        var s = DropStash()
        s.put(["/a/b.pdf", "/c"], at: 100)
        #expect(s.take(now: 101) == ["/a/b.pdf", "/c"])
        #expect(s.take(now: 101) == [])
    }
    @Test func stalePathsAreNotHandedToALaterDrop() {
        var s = DropStash(maxAge: 5)
        s.put(["/old"], at: 100)
        #expect(s.take(now: 106) == [])
    }
    @Test func aNewDropReplacesTheOld() {
        var s = DropStash()
        s.put(["/one"], at: 100)
        s.put(["/two"], at: 101)
        #expect(s.take(now: 102) == ["/two"])
    }
    @Test func emptyWhenNothingWasDropped() {
        var s = DropStash()
        #expect(s.take(now: 0) == [])
    }
}
