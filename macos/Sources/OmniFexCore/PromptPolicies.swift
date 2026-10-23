import Foundation

public struct PromptText: Equatable, Sendable {
    public var message: String
    public var detail: String
}

/// Whether a quit may proceed, or needs the user to confirm first.
///
/// The daemon owns every CLI process, so quitting the app does not stop a
/// turn — it keeps running and the next window catches up. What a quit does
/// lose is renderer state: unsent drafts and prompts queued behind a running
/// turn. Electron's prompt said "Quitting OmniFex will stop them", which stopped
/// being true the day the daemon became the default.
public enum QuitPolicy {
    public enum Decision: Equatable, Sendable {
        case allow
        case confirm(PromptText)
    }

    public static func decide(workingCount: Int, authorized: Bool) -> Decision {
        if authorized || workingCount < 1 { return .allow }
        return .confirm(PromptText(
            message: workingCount == 1 ? "1 session is still working." : "\(workingCount) sessions are still working.",
            detail: "They keep running in the background. Prompts queued behind them are lost."
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
