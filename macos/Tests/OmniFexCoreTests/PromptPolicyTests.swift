import Testing
@testable import OmniFexCore

@Suite struct QuitPolicyTests {
    @Test func allowsWhenNothingIsWorking() {
        #expect(QuitPolicy.decide(workingCount: 0, authorized: false) == .allow)
        #expect(QuitPolicy.decide(workingCount: -1, authorized: false) == .allow)
    }
    @Test func allowsAnAuthorizedQuit() {
        #expect(QuitPolicy.decide(workingCount: 3, authorized: true) == .allow)
    }
    // The daemon is the app's: quitting stops it and every turn under it
    // (2026-11-18). The prompt must say so — it is the only guard on a turn
    // the user is about to lose.
    @Test func confirmsAndSaysQuittingStopsTheTurns() {
        guard case .confirm(let p) = QuitPolicy.decide(workingCount: 2, authorized: false) else { Issue.record("expected confirm"); return }
        #expect(p.message == "2 sessions are still working.")
        #expect(!p.detail.contains("keep running"))
        #expect(p.detail.contains("Quitting stops them"))
        #expect(p.detail.contains("lost"))
        guard case .confirm(let one) = QuitPolicy.decide(workingCount: 1, authorized: false) else { Issue.record("expected confirm"); return }
        #expect(one.message == "1 session is still working.")
    }

    // A turn running only on the iPad is invisible to this window's tabs, but
    // quitting kills it too. The daemon's count covers every session, so it
    // wins when it answers; when it does not, the window's own count stands.
    @Test func countsTheDaemonsTurnsNotJustThisWindows() {
        #expect(QuitPolicy.workingCount(local: 0, daemon: 1) == 1)
        #expect(QuitPolicy.workingCount(local: 2, daemon: 3) == 3)
        #expect(QuitPolicy.workingCount(local: 2, daemon: nil) == 2)
        #expect(QuitPolicy.workingCount(local: 2, daemon: 0) == 2)
    }
}

@Suite struct ReloadPolicyTests {
    @Test func wordingWithNothingWorking() {
        let p = ReloadPolicy.prompt(workingCount: 0)
        #expect(p.message == "Reload the OmniFex window?")
        #expect(p.detail == "Open tabs are restored. Unsent composer drafts and queued prompts are lost.")
    }
    @Test func wordingWithSessionsWorking() {
        #expect(ReloadPolicy.prompt(workingCount: 1).detail.hasPrefix("1 session keeps running in the background. "))
        #expect(ReloadPolicy.prompt(workingCount: 3).detail.hasPrefix("3 sessions keep running in the background. "))
        #expect(ReloadPolicy.prompt(workingCount: -2).detail.hasPrefix("Open tabs"))
    }
}
