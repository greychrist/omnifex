// swift-tools-version: 6.4
import PackageDescription

// Swift 6 mode: an off-main UI call must be a compile error, since WebKit kills the app on one.
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
