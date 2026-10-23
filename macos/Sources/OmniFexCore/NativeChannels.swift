import Foundation

/// The channels this app serves itself. Mirrors `NATIVE_INVOKE_CHANNELS` and
/// `NATIVE_EVENT_PREFIXES` in `src/lib/remote/nativeChannels.ts`, which is the
/// source of truth: the renderer's shim routes exactly those to
/// `window.__omnifexNative`, and everything else to the daemon.
///
/// Keep every channel a plain string literal in this file — a vitest guard
/// greps it for each entry of the TS list, which is what stops a channel being
/// added on one side and silently answering nothing on the other.
public enum NativeChannels {
    public static let invoke: Set<String> = [
        "dialog:open",
        "dialog:save",
        "shell:openExternal",
        "reveal_path_in_finder",
        "open_path",
        "window:minimize",
        "window:maximize",
        "window:close",
        "get_app_version",
        "updater:check",
        "updater:download",
        "updater:open",
        "updater:install",
        "updater:install-cancel",
        "cost_report_export_pdf",
        "cost_report_print_ready",
        "preview_notification_sound",
        "tab_status_publish",
        "tab_status_remove",
        "tab_status_list",
        "remote:url",
        "remote:restart",
        "notify:show",
        "clipboard:write",
    ]

    /// Events this app emits into pages.
    public static let events: Set<String> = [
        "updater:progress",
        "updater:install-status",
        "notification-clicked",
        "tab-status:changed",
        "system-power-state",
        "session-inflight-count",
    ]
}

public struct BridgeError: Error, LocalizedError, Sendable {
    public var message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// Channel → handler, refusing anything not on the native list. `Context` is
/// whatever the app needs to know about the caller (its web view).
public final class BridgeRouter<Context> {
    public typealias Handler = (_ params: Any?, _ context: Context) async throws -> Any?
    private var handlers: [String: Handler] = [:]

    public init() {}

    public func register(_ channel: String, _ handler: @escaping Handler) {
        precondition(NativeChannels.invoke.contains(channel), "\(channel) is not a native channel")
        handlers[channel] = handler
    }

    public func dispatch(_ channel: String, params: Any?, context: Context) async throws -> Any? {
        guard NativeChannels.invoke.contains(channel) else { throw BridgeError("Blocked IPC channel: \(channel)") }
        guard let handler = handlers[channel] else { throw BridgeError("No handler for native channel \(channel)") }
        return try await handler(params, context)
    }

    /// Native channels nothing handles — empty in a correct build.
    public func missingHandlers() -> [String] {
        NativeChannels.invoke.filter { handlers[$0] == nil }.sorted()
    }
}
