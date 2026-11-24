import Foundation

public enum ClipboardPayload: Equatable, Sendable {
    case text(String)
    case html(String)
    case png(Data)

    public static func parse(_ params: Any?) -> [ClipboardPayload] {
        guard let items = (params as? [String: Any])?["items"] as? [Any] else { return [] }
        return items.compactMap { raw in
            guard let item = raw as? [String: Any], let type = item["type"] as? String else { return nil }
            switch type {
            case "text/plain": return (item["text"] as? String).map(ClipboardPayload.text)
            case "text/html": return (item["text"] as? String).map(ClipboardPayload.html)
            case "image/png":
                return (item["base64"] as? String).flatMap { Data(base64Encoded: $0) }.map(ClipboardPayload.png)
            default: return nil
            }
        }
    }
}
