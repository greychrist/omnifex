import Foundation

public struct PromptText: Equatable, Sendable {
    public var message: String
    public var detail: String
}

/// Whether a quit may proceed, or needs the user to confirm first.
///
/// The daemon is the app's (2026-11-18): quitting stops it and every CLI
/// session under it, so a turn in progress is lost. This prompt is the only
/// guard on that, and it counts every turn the daemon is running — a session
/// open only on the iPad dies with the quit too.
public enum QuitPolicy {
    /// Turns a quit would stop. The daemon's count covers every session, this
    /// window's included, so it wins when it answers; nil (no answer) falls
    /// back to the window's own tabs.
    public static func workingCount(local: Int, daemon: Int?) -> Int {
        max(local, daemon ?? 0)
    }

    public enum Decision: Equatable, Sendable {
        case allow
        case confirm(PromptText)
    }

    public static func decide(workingCount: Int, authorized: Bool) -> Decision {
        if authorized || workingCount < 1 { return .allow }
        return .confirm(PromptText(
            message: workingCount == 1 ? "1 session is still working." : "\(workingCount) sessions are still working.",
            detail: "Quitting stops them: the turns in progress are lost, and so are prompts queued behind them."
        ))
    }
}

/// What to tell the user before reloading the page. The menu item has no
/// shortcut on purpose: an accidental reload used to lose work, so a reload is
/// something you choose, never something you fat-finger.
public enum ReloadPolicy {
    public static func prompt(workingCount: Int) -> PromptText {
        let working = max(0, workingCount)
        let survives: String
        switch working {
        case 0: survives = ""
        case 1: survives = "1 session keeps running in the background. "
        default: survives = "\(working) sessions keep running in the background. "
        }
        return PromptText(
            message: "Reload the OmniFex window?",
            detail: "\(survives)Open tabs are restored. Unsent composer drafts and queued prompts are lost."
        )
    }
}
