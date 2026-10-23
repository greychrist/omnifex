import Testing
@testable import OmniFexCore

@Suite struct NotificationSoundTests {
    let res = "/Applications/OmniFex.app/Contents/Resources"

    @Test func noneIsSilent() {
        let r = NotificationSound.resolve("none", resourcesPath: res)
        #expect(r.playPath == nil && r.nativeName == nil)
    }
    @Test func chimeIsBundled() {
        let r = NotificationSound.resolve("greychrist_success", resourcesPath: res)
        #expect(r.playPath == "\(res)/greychrist_success.aiff")
        #expect(r.nativeName == "greychrist_success.aiff")
    }
    @Test func systemSounds() {
        let r = NotificationSound.resolve("Glass", resourcesPath: res)
        #expect(r.playPath == "/System/Library/Sounds/Glass.aiff")
        #expect(r.nativeName == "Glass.aiff")
    }
    @Test func unknownIsSilentAndInvalid() {
        #expect(!NotificationSound.isValid("Nope"))
        #expect(NotificationSound.resolve("Nope", resourcesPath: res).playPath == nil)
    }
    @Test func configuredFallsBackToDefaults() {
        #expect(NotificationSound.configured(nil, isError: false) == "greychrist_success")
        #expect(NotificationSound.configured("bogus", isError: true) == "Basso")
        #expect(NotificationSound.configured("Pop", isError: true) == "Pop")
    }
}

/// A banner that wants an answer says so ("Permission Request:", "Answer
/// Needed:"); one without that reports a finished task.
@Suite struct BannerSubtitleTests {
    @Test func usesTheSessionsOwnSubtitle() {
        #expect(BannerSubtitle.text(explicit: "Permission Request:", isError: false) == "Permission Request:")
    }

    @Test func fallsBackToTaskOutcome() {
        #expect(BannerSubtitle.text(explicit: nil, isError: false) == "Task Complete")
        #expect(BannerSubtitle.text(explicit: "", isError: true) == "Task Failed")
    }
}
