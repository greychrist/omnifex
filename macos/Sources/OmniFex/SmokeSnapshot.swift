import AppKit
import WebKit

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
