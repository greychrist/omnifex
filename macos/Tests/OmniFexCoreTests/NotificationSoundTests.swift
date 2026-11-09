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

/// When to raise a banner. A mod's `$.ui.notify` (CLI 2.1.321) may ask for
/// later: the notification centre books it, so it fires after OmniFex quits.
@Suite struct NotificationDeliveryTests {
    let now = 1_800_000_000_000.0

    @Test func immediateWhileLookingIsJustTheSound() {
        #expect(NotificationDelivery.plan(deliverAtMs: nil, nowMs: now, windowFocused: true) == .soundOnly)
    }
    @Test func immediateWhileAwayIsABanner() {
        #expect(NotificationDelivery.plan(deliverAtMs: nil, nowMs: now, windowFocused: false) == .bannerNow)
    }
    @Test func laterIsBookedWhateverHasFocus() {
        #expect(NotificationDelivery.plan(deliverAtMs: now + 90_000, nowMs: now, windowFocused: true) == .scheduled(seconds: 90))
        #expect(NotificationDelivery.plan(deliverAtMs: now + 90_000, nowMs: now, windowFocused: false) == .scheduled(seconds: 90))
    }
    @Test func aMomentAlreadyPastIsNow() {
        #expect(NotificationDelivery.plan(deliverAtMs: now - 5, nowMs: now, windowFocused: false) == .bannerNow)
        // Under a second ahead is not worth a booking.
        #expect(NotificationDelivery.plan(deliverAtMs: now + 500, nowMs: now, windowFocused: true) == .soundOnly)
    }
    @Test func neverBooksBeyondSevenDays() {
        #expect(NotificationDelivery.plan(deliverAtMs: now + 30 * 86_400_000, nowMs: now, windowFocused: false) == .scheduled(seconds: 7 * 86_400))
    }
}

@Suite struct BridgeParamsStringsTests {
    @Test func readsOnlyStrings() {
        #expect(BridgeParams.strings(["ids": ["a", 1, "b"]], "ids") == ["a", "b"])
        #expect(BridgeParams.strings(["ids": "a"], "ids") == [])
        #expect(BridgeParams.strings(nil, "ids") == [])
    }
}
