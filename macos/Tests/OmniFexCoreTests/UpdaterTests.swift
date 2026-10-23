import Foundation
import Testing
@testable import OmniFexCore

@Suite struct UpdaterTests {
    func release(_ assets: [String], tag: String = "v0.5.0") -> Data {
        let a = assets.map { ["name": $0, "browser_download_url": "https://dl/\($0)", "size": 10] }
        return try! JSONSerialization.data(withJSONObject: ["tag_name": tag, "html_url": "https://gh/rel", "body": "notes", "assets": a])
    }

    @Test func versionCompare() {
        #expect(Updater.isNewer("0.4.243", than: "0.4.242"))
        #expect(Updater.isNewer("1.0.0", than: "0.9.9"))
        #expect(!Updater.isNewer("0.4.242", than: "0.4.242"))
        #expect(!Updater.isNewer("garbage", than: "0.4.242"))
        #expect(Updater.compare("0.4.10", "0.4.9") > 0)
    }

    @Test func picksTheNewestZipAsset() throws {
        let info = try #require(Updater.pickUpdate(fromRelease: release([
            "OmniFex-0.5.0-arm64.dmg",
            "OmniFex-darwin-arm64-0.4.300.zip",
            "OmniFex-darwin-arm64-0.5.0.zip",
        ]), currentVersion: "0.4.242"))
        #expect(info.version == "0.5.0")
        #expect(info.assetName == "OmniFex-darwin-arm64-0.5.0.zip")
        #expect(info.downloadUrl == "https://dl/OmniFex-darwin-arm64-0.5.0.zip")
        #expect(info.releaseUrl == "https://gh/rel")
        #expect(info.releaseNotes == "notes")
        #expect(info.json["available"] as? Bool == true)
    }

    @Test func nothingWhenNotNewerOrNoZip() {
        #expect(Updater.pickUpdate(fromRelease: release(["OmniFex-darwin-arm64-0.4.242.zip"]), currentVersion: "0.4.242") == nil)
        #expect(Updater.pickUpdate(fromRelease: release(["OmniFex-0.5.0-arm64.dmg"]), currentVersion: "0.4.242") == nil)
        #expect(Updater.pickUpdate(fromRelease: Data("nope".utf8), currentVersion: "0.4.242") == nil)
    }

    @Test func pruneOnlySpentZips() {
        #expect(Updater.shouldPrune("OmniFex-darwin-arm64-0.4.242.zip", currentVersion: "0.4.242"))
        #expect(Updater.shouldPrune("OmniFex-darwin-arm64-0.4.1.zip", currentVersion: "0.4.242"))
        #expect(!Updater.shouldPrune("OmniFex-darwin-arm64-0.4.243.zip", currentVersion: "0.4.242"))
        #expect(!Updater.shouldPrune("other.zip", currentVersion: "0.4.242"))
    }

    @Test func filenameFromURL() {
        #expect(Updater.filename(fromURL: "https://x/a/OmniFex-darwin-arm64-1.0.0.zip?x=1") == "OmniFex-darwin-arm64-1.0.0.zip")
        #expect(Updater.filename(fromURL: "::") == "OmniFex-update.zip")
    }

    @Test func progressPercent() {
        #expect(Updater.progress(bytes: 50, total: 200)["percent"] as? Int == 25)
        #expect(Updater.progress(bytes: 50, total: 0)["percent"] as? Int == 0)
    }
}
