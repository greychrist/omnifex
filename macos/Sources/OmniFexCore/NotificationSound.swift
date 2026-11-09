import Foundation

/// Notification sound ids — the same catalog as `src/lib/notificationSounds.ts`.
public enum NotificationSound {
    public static let systemSounds: Set<String> = [
        "Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero",
        "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink",
    ]
    public static let bundledChime = "greychrist_success"

    public static func isValid(_ id: String?) -> Bool {
        guard let id else { return false }
        return id == "none" || id == bundledChime || systemSounds.contains(id)
    }

    public struct Resolution: Equatable, Sendable {
        /// File played directly when a window is focused; nil = silent.
        public var playPath: String?
        /// `UNNotificationSoundName` for a banner; nil = silent banner.
        public var nativeName: String?
    }

    public static func resolve(_ id: String, resourcesPath: String) -> Resolution {
        if id == bundledChime {
            return Resolution(playPath: resourcesPath + "/greychrist_success.aiff", nativeName: "greychrist_success.aiff")
        }
        if systemSounds.contains(id) {
            return Resolution(playPath: "/System/Library/Sounds/\(id).aiff", nativeName: "\(id).aiff")
        }
        return Resolution(playPath: nil, nativeName: nil)
    }

    /// The configured id for an event class, with the historical defaults for
    /// a missing or stale setting.
    public static func configured(_ stored: String?, isError: Bool) -> String {
        if let stored, isValid(stored) { return stored }
        return isError ? "Basso" : bundledChime
    }

    public static let successSettingKey = "notification_sound_success"
    public static let errorSettingKey = "notification_sound_error"
}

/// The line under a banner's title. The daemon sends one for anything that
/// waits on the user; everything else is a turn or an agent ending.
public enum BannerSubtitle {
    public static func text(explicit: String?, isError: Bool) -> String {
        if let explicit, !explicit.isEmpty { return explicit }
        return isError ? "Task Failed" : "Task Complete"
    }
}

/// When to raise a banner. Mods' notifications (`$.ui.notify`, CLI 2.1.321)
/// may name a later moment, which the notification centre books — so it
/// fires with the session, or OmniFex itself, out of reach. A booked one
/// ignores focus: whether the user is looking is unknowable until it fires.
public enum NotificationDelivery: Equatable, Sendable {
    case soundOnly
    case bannerNow
    case scheduled(seconds: Double)

    public static let maxDelaySeconds: Double = 7 * 86_400

    public static func plan(deliverAtMs: Double?, nowMs: Double, windowFocused: Bool) -> NotificationDelivery {
        if let deliverAtMs {
            let seconds = (deliverAtMs - nowMs) / 1000
            if seconds >= 1 { return .scheduled(seconds: min(seconds, maxDelaySeconds)) }
        }
        return windowFocused ? .soundOnly : .bannerNow
    }
}
