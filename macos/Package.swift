// swift-tools-version: 6.0
import PackageDescription

// The OmniFex desktop app: a native window around the renderer the OmniFex
// daemon serves. `OmniFexCore` holds every rule worth a test — navigation,
// file-serving, open-path, quit/reload wording, tab status, updater/installer —
// and the `OmniFex` executable is the AppKit wiring around it.
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
            linkerSettings: [.linkedLibrary("sqlite3")]
        ),
        .executableTarget(
            name: "OmniFex",
            dependencies: ["OmniFexCore"]
        ),
        .testTarget(
            name: "OmniFexCoreTests",
            dependencies: ["OmniFexCore"]
        ),
    ],
    swiftLanguageModes: [.v5]
)
