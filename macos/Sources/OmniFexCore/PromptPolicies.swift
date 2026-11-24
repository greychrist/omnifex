import Foundation

public struct PromptText: Equatable, Sendable {
    public var message: String
    public var detail: String
}

/// Quitting stops the daemon and every session under it, the iPad's too: this prompt is the only guard.
public enum QuitPolicy {
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
