import AppKit
import OmniFexCore

@main
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }

    private var services: AppServices!

    func applicationDidFinishLaunching(_ notification: Notification) {
        services = AppServices()
        NSApp.mainMenu = buildMainMenu()
        services.start()
        services.newWindow()
        NSApp.activate()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { services.newWindow() }
        return true
    }

    // Quit on last window close: staying resident got OmniFex reported as running in the background.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if services.quitAuthorized { return .terminateNow }
        let window = NSApp.keyWindow
        Task { @MainActor in
            let remote = await services.daemon.remoteInFlight()
            NSApp.reply(toApplicationShouldTerminate: services.mayQuit(over: window, daemonInFlight: remote))
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        services.willTerminate()
    }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()
        menu.addItem(withTitle: "New Window", action: #selector(newWindow(_:)), keyEquivalent: "")
        return menu
    }

    @objc func newWindow(_ sender: Any?) { services.newWindow() }

    @objc func reloadWindow(_ sender: Any?) { services.focusedController()?.confirmAndReload() }

    @objc func toggleDeveloperTools(_ sender: Any?) { services.focusedController()?.toggleInspector() }

    @objc func actualSize(_ sender: Any?) { services.focusedController()?.setZoom(1) }
    @objc func zoomIn(_ sender: Any?) { services.focusedController()?.adjustZoom(by: 0.1) }
    @objc func zoomOut(_ sender: Any?) { services.focusedController()?.adjustZoom(by: -0.1) }

    private func buildMainMenu() -> NSMenu {
        let main = NSMenu()
        let name = ProcessInfo.processInfo.processName

        let app = NSMenu(title: name)
        app.addItem(withTitle: "About \(name)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide \(name)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit \(name)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        main.addItem(submenu: app, title: name)

        let file = NSMenu(title: "File")
        file.addItem(withTitle: "New Window", action: #selector(newWindow(_:)), keyEquivalent: "n")
        file.addItem(.separator())
        // ⌘W belongs to the renderer (it closes the tab); a menu item on it would race the page.
        let close = file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        close.keyEquivalentModifierMask = [.command, .shift]
        main.addItem(submenu: file, title: "File")

        // Without these standard selectors, ⌘C/⌘V/⌘Z do nothing in WKWebView text fields.
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        let pasteMatch = edit.addItem(withTitle: "Paste and Match Style", action: #selector(NSTextView.pasteAsPlainText(_:)), keyEquivalent: "v")
        pasteMatch.keyEquivalentModifierMask = [.command, .option, .shift]
        edit.addItem(withTitle: "Delete", action: #selector(NSText.delete(_:)), keyEquivalent: "")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        main.addItem(submenu: edit, title: "Edit")

        let view = NSMenu(title: "View")
        // Deliberately no shortcut: an accidental reload loses work.
        view.addItem(withTitle: "Reload Window", action: #selector(reloadWindow(_:)), keyEquivalent: "")
        view.addItem(.separator())
        let devtools = view.addItem(withTitle: "Toggle Developer Tools", action: #selector(toggleDeveloperTools(_:)), keyEquivalent: "i")
        devtools.keyEquivalentModifierMask = [.command, .option]
        view.addItem(.separator())
        view.addItem(withTitle: "Actual Size", action: #selector(actualSize(_:)), keyEquivalent: "0")
        view.addItem(withTitle: "Zoom In", action: #selector(zoomIn(_:)), keyEquivalent: "=")
        let zoomInPlus = view.addItem(withTitle: "Zoom In", action: #selector(zoomIn(_:)), keyEquivalent: "+")
        zoomInPlus.isAlternate = true
        zoomInPlus.keyEquivalentModifierMask = [.command, .shift]
        view.addItem(withTitle: "Zoom Out", action: #selector(zoomOut(_:)), keyEquivalent: "-")
        view.addItem(.separator())
        let fullScreen = view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        main.addItem(submenu: view, title: "View")

        let window = NSMenu(title: "Window")
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        window.addItem(.separator())
        window.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        main.addItem(submenu: window, title: "Window")
        NSApp.windowsMenu = window

        return main
    }
}

private extension NSMenu {
    func addItem(submenu: NSMenu, title: String) {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.submenu = submenu
        addItem(item)
    }
}
