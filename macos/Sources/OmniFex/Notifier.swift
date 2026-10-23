import AppKit
import UserNotifications
import OmniFexCore

/// OS notifications and the dock badge for daemon-side events. The daemon has
/// no display; the renderer's shim forwards each `claude-notification` here as
/// `notify:show`.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    var onClick: ((String?) -> Void)?
    private let paths: AppPaths
    private var unread = 0
    private var authorizationRequested = false

    init(paths: AppPaths) {
        self.paths = paths
        super.init()
        center?.delegate = self
    }

    /// nil outside an app bundle (`swift run`), where touching the center
    /// throws. Notifications simply do not exist there.
    private var center: UNUserNotificationCenter? {
        Bundle.main.bundleIdentifier == nil ? nil : UNUserNotificationCenter.current()
    }

    private func soundId(isError: Bool) -> String {
        let key = isError ? NotificationSound.errorSettingKey : NotificationSound.successSettingKey
        return NotificationSound.configured(SettingsReader(path: paths.settingsDatabase).value(for: key), isError: isError)
    }

    func show(title: String, subtitle: String?, body: String, isError: Bool, tabId: String?, windowFocused: Bool) {
        let sound = NotificationSound.resolve(soundId(isError: isError), resourcesPath: paths.resourcesPath)
        // The user is looking at the app: a banner would only cover what they
        // are reading, so it is just the sound.
        if windowFocused {
            play(sound.playPath)
            return
        }
        unread += 1
        NSApp.dockTile.badgeLabel = String(unread)
        guard let center else { return }
        requestAuthorizationOnce(center)
        let content = UNMutableNotificationContent()
        content.title = title
        content.subtitle = BannerSubtitle.text(explicit: subtitle, isError: isError)
        content.body = body
        if let tabId { content.userInfo = ["tabId": tabId] }
        // The banner is silent and the sound is played here instead.
        // UNNotificationSound only finds sounds inside an app's own bundle or
        // container, never /System/Library/Sounds — so a system sound like
        // Glass would have been silently replaced by the default chime.
        play(sound.playPath)
        center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }

    func play(_ path: String?) {
        guard let path else { return }
        NSSound(contentsOfFile: path, byReference: true)?.play()
    }

    /// A window came to the front: clear the badge and the banners.
    func userIsLooking() {
        unread = 0
        NSApp.dockTile.badgeLabel = nil
        center?.removeAllDeliveredNotifications()
    }

    private func requestAuthorizationOnce(_ center: UNUserNotificationCenter) {
        guard !authorizationRequested else { return }
        authorizationRequested = true
        center.requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            if !granted { NSLog("[notify] not authorized: %@", error?.localizedDescription ?? "denied") }
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let tabId = response.notification.request.content.userInfo["tabId"] as? String
        await MainActor.run { self.onClick?(tabId) }
    }
}

/// Lock and sleep reach the renderer, which folds them into each git watch's
/// visibility — a locked screen does not reliably hide the document.
@MainActor
final class PowerMonitor {
    private var tokens: [(NotificationCenter, NSObjectProtocol)] = []

    init(report: @escaping @MainActor (Bool) -> Void) {
        let ws = NSWorkspace.shared.notificationCenter
        let dist = DistributedNotificationCenter.default()
        let watch: [(NotificationCenter, Notification.Name, Bool)] = [
            (ws, NSWorkspace.willSleepNotification, false),
            (ws, NSWorkspace.didWakeNotification, true),
            (dist, Notification.Name("com.apple.screenIsLocked"), false),
            (dist, Notification.Name("com.apple.screenIsUnlocked"), true),
        ]
        for (center, name, awake) in watch {
            let token = center.addObserver(forName: name, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { report(awake) }
            }
            tokens.append((center, token))
        }
    }
}
