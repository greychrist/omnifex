// swift-tools-version: 6.4
import PackageDescription

// The OmniFex desktop app: a native window around the renderer the OmniFex
// daemon serves. `OmniFexCore` holds every rule worth a test — navigation,
// file-serving, open-path, quit/reload wording, tab status, updater/installer —
// and the `OmniFex` executable is the AppKit wiring around it.
//
// Swift 6 language mode, so a data race or an off-main UI call is a compile
// error. In 0.5.0, Swift 5 mode let the updater post to the WKWebView from
// the cooperative pool, and WebKit killed the app on every Install click.
// Async functions run on their caller's actor unless marked `@concurrent`,
// and the AppKit target is main-actor by default. Both upcoming features are
// Swift 7 defaults; drop them when the package moves to the Swift 7 mode.
let concurrency: [SwiftSetting] = [
    .enableUpcomingFeature("NonisolatedNonsendingByDefault"),
    .enableUpcomingFeature("InferIsolatedConformances"),
]

let package = Package(
    name: "OmniFex",
    platforms: [.macOS("27.0")],
    products: [
        .executable(name: "OmniFex", targets: ["OmniFex"]),
        .library(name: "OmniFexCore", targets: ["OmniFexCore"]),
    ],
    targets: [
        .target(
            name: "OmniFexCore",
            swiftSettings: concurrency,
            linkerSettings: [.linkedLibrary("sqlite3")]
        ),
        .executableTarget(
            name: "OmniFex",
            dependencies: ["OmniFexCore"],
            swiftSettings: concurrency + [.defaultIsolation(MainActor.self)]
        ),
        .testTarget(
            name: "OmniFexCoreTests",
            dependencies: ["OmniFexCore"],
            swiftSettings: concurrency
        ),
    ],
    swiftLanguageModes: [.v6]
)
