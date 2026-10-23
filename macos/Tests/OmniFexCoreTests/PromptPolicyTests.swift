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
    // The daemon owns every CLI process: quitting the window does not stop a
    // turn. What it loses is renderer state — prompts queued behind a turn.
    @Test func confirmsAndSaysSessionsKeepRunning() {
        guard case .confirm(let p) = QuitPolicy.decide(workingCount: 2, authorized: false) else { Issue.record("expected confirm"); return }
        #expect(p.message == "2 sessions are still working.")
        #expect(p.detail.contains("keep running in the background"))
        #expect(p.detail.contains("queued"))
        guard case .confirm(let one) = QuitPolicy.decide(workingCount: 1, authorized: false) else { Issue.record("expected confirm"); return }
        #expect(one.message == "1 session is still working.")
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
