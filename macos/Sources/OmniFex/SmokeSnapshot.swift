import AppKit
import WebKit

/// Smoke-run evidence: with `OMNIFEX_SMOKE_DIR` set, every loaded page is
/// snapshotted to `<dir>/window-<id>.png` a few seconds after it finishes
/// loading, beside a line in `<dir>/windows.txt` with the window's frame.
///
/// A packaged build is verified headlessly (isolated state dir, its own
/// port), and "the renderer connected to the daemon" is not the same claim as
/// "the window shows the app". This is how the second one gets checked
/// without Screen Recording or Accessibility permission. Inert unless the
/// variable is set.
@MainActor
enum SmokeSnapshot {
    static let dir: String? = {
        let v = ProcessInfo.processInfo.environment["OMNIFEX_SMOKE_DIR"]
        return (v?.isEmpty ?? true) ? nil : v
    }()

    static func capture(_ webView: WKWebView, id: Int, after delay: TimeInterval = 6) {
        guard let dir else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            webView.takeSnapshot(with: nil) { image, error in
                let frame = webView.window.map { NSStringFromRect($0.frame) } ?? "no window"
                var line = "window-\(id) frame=\(frame) url=\(webView.url?.absoluteString ?? "-")"
                if let image, let tiff = image.tiffRepresentation,
                   let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("window-\(id).png"))
                } else {
                    line += " snapshot-error=\(error?.localizedDescription ?? "none")"
                }
                if let handle = FileHandle(forWritingAtPath: dir + "/windows.txt") ?? {
                    FileManager.default.createFile(atPath: dir + "/windows.txt", contents: nil)
                    return FileHandle(forWritingAtPath: dir + "/windows.txt")
                }() {
                    handle.seekToEndOfFile()
                    handle.write(Data((line + "\n").utf8))
                    try? handle.close()
                }
            }
        }
    }
}
