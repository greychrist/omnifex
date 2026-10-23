import Foundation
import Testing
@testable import OmniFexCore

@Suite struct ProtocolFilePolicyTests {
    func tempDir() throws -> String {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pfp-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.path
    }

    @Test func servesAnImage() throws {
        let dir = try tempDir()
        let p = dir + "/a.PNG"
        FileManager.default.createFile(atPath: p, contents: Data([1, 2, 3]))
        let d = ProtocolFilePolicy.resolve(p)
        guard case .ok(let path, let type) = d else { Issue.record("expected ok, got \(d)"); return }
        #expect(type == "image/png")
        #expect(path.hasSuffix("/a.PNG"))
    }

    @Test func refusesRelativeAndMissing() {
        #expect(!ProtocolFilePolicy.resolve("a.png").isOK)
        #expect(!ProtocolFilePolicy.resolve("").isOK)
        #expect(!ProtocolFilePolicy.resolve("/no/such/file.png").isOK)
    }

    @Test func refusesNonImagesAndDirectories() throws {
        let dir = try tempDir()
        FileManager.default.createFile(atPath: dir + "/secret.json", contents: Data())
        #expect(!ProtocolFilePolicy.resolve(dir + "/secret.json").isOK)
        try FileManager.default.createDirectory(atPath: dir + "/d.png", withIntermediateDirectories: true)
        #expect(!ProtocolFilePolicy.resolve(dir + "/d.png").isOK)
    }

    // `decoy.png -> ~/.claude/.credentials.json`: the extension is decided on
    // the real path, so the symlink is refused rather than served.
    @Test func decidesOnTheRealPath() throws {
        let dir = try tempDir()
        FileManager.default.createFile(atPath: dir + "/creds.json", contents: Data("x".utf8))
        try FileManager.default.createSymbolicLink(atPath: dir + "/decoy.png", withDestinationPath: dir + "/creds.json")
        #expect(!ProtocolFilePolicy.resolve(dir + "/decoy.png").isOK)
    }

    @Test func pathFromSchemeURL() {
        let url = URL(string: "greychrist-file:///Users/me/my%20shot.png")!
        #expect(ProtocolFilePolicy.requestedPath(from: url) == "/Users/me/my shot.png")
    }
}
