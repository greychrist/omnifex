import Foundation

/// The same catalog as `src/lib/notificationSounds.ts`.
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
        public var playPath: String?
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

    public static func configured(_ stored: String?, isError: Bool) -> String {
        if let stored, isValid(stored) { return stored }
        return isError ? "Basso" : bundledChime
    }

    public static let successSettingKey = "notification_sound_success"
    public static let errorSettingKey = "notification_sound_error"
}

public enum BannerSubtitle {
    public static func text(explicit: String?, isError: Bool) -> String {
        if let explicit, !explicit.isEmpty { return explicit }
        return isError ? "Task Failed" : "Task Complete"
    }
}

/// A booked notification ignores focus: whether the user is looking is unknowable until it fires.
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
