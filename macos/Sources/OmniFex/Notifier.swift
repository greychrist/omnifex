import AppKit
import UserNotifications
import OmniFexCore

@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    var onClick: ((String?, String?) -> Void)?
    private let paths: AppPaths
    private var unread = 0
    private var authorizationRequested = false

    init(paths: AppPaths) {
        self.paths = paths
        super.init()
        center?.delegate = self
    }

    /// nil outside an app bundle (`swift run`), where touching the center throws.
    private var center: UNUserNotificationCenter? {
        Bundle.main.bundleIdentifier == nil ? nil : UNUserNotificationCenter.current()
    }

    private func soundId(isError: Bool) -> String {
        let key = isError ? NotificationSound.errorSettingKey : NotificationSound.successSettingKey
        return NotificationSound.configured(SettingsReader(path: paths.settingsDatabase).value(for: key), isError: isError)
    }

    func show(title: String, subtitle: String?, body: String, isError: Bool, tabId: String?, windowFocused: Bool,
              id: String? = nil, deliverAtMs: Double? = nil) {
        let sound = NotificationSound.resolve(soundId(isError: isError), resourcesPath: paths.resourcesPath)
        let plan = NotificationDelivery.plan(deliverAtMs: deliverAtMs, nowMs: Date().timeIntervalSince1970 * 1000, windowFocused: windowFocused)
        if plan == .soundOnly {
            play(sound.playPath)
            return
        }
        guard let center else { return }
        requestAuthorizationOnce(center)
        let content = UNMutableNotificationContent()
        content.title = title
        content.subtitle = BannerSubtitle.text(explicit: subtitle, isError: isError)
        content.body = body
        var info: [String: String] = [:]
        if let tabId { info["tabId"] = tabId }
        if let id { info["id"] = id }
        content.userInfo = info
        let identifier = id ?? UUID().uuidString
        if case .scheduled(let seconds) = plan {
            // Fires while OmniFex may not be running, so only the default chime can play.
            content.sound = .default
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: seconds, repeats: false)
            center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: trigger))
            return
        }
        unread += 1
        NSApp.dockTile.badgeLabel = String(unread)
        // UNNotificationSound never finds /System/Library/Sounds, so the banner is silent and the sound plays here.
        play(sound.playPath)
        center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
    }

    func remove(ids: [String]) {
        guard let center, !ids.isEmpty else { return }
        center.removePendingNotificationRequests(withIdentifiers: ids)
        center.removeDeliveredNotifications(withIdentifiers: ids)
    }

    func play(_ path: String?) {
        guard let path else { return }
        NSSound(contentsOfFile: path, byReference: true)?.play()
    }

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
        let info = response.notification.request.content.userInfo
        let tabId = info["tabId"] as? String
        let id = info["id"] as? String
        await MainActor.run { self.onClick?(tabId, id) }
    }
}

/// A locked screen does not reliably hide the document, so lock and sleep are reported to the renderer.
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
