import Foundation
import Darwin
import OmniFexCore

enum Spawn {
    struct Output {
        var status: Int32
        var stdout: String
        var stderr: String
        var stderrTail: String {
            let lines = stderr.split(whereSeparator: \.isNewline).suffix(5)
            return lines.isEmpty ? "" : lines.joined(separator: "\n")
        }
    }

    /// Run to completion and capture both streams, killing it at `timeout`.
    ///
    /// `posix_spawn` rather than `Process`, because `Process` always makes the
    /// child a new group's leader and `group: .callers` must not: a dev daemon
    /// `ensure` starts inherits `ensure`'s group, and has to share the app's.
    /// See `LauncherProcessGroup`.
    static func output(_ exe: String, _ args: [String], timeout: TimeInterval, group: LauncherProcessGroup = .own) async throws -> Output {
        let out = Pipe(), err = Pipe()
        var fileActions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&fileActions)
        defer { posix_spawn_file_actions_destroy(&fileActions) }
        posix_spawn_file_actions_addopen(&fileActions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_adddup2(&fileActions, out.fileHandleForWriting.fileDescriptor, 1)
        posix_spawn_file_actions_adddup2(&fileActions, err.fileHandleForWriting.fileDescriptor, 2)
        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        // CLOEXEC_DEFAULT: the child gets 0-2 and nothing else of ours.
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT) | cleanSignals(&attr))
        posix_spawnattr_setpgroup(&attr, group == .callers ? getpgrp() : 0)
        let argv = ([exe] + args).map { strdup($0) } + [nil]
        defer { argv.forEach { free($0) } }
        var pid: pid_t = 0
        let rc = posix_spawn(&pid, exe, &fileActions, &attr, argv, environ)
        // Our copies of the write ends must go, or the reads never see EOF.
        try? out.fileHandleForWriting.close()
        try? err.fileHandleForWriting.close()
        guard rc == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(rc)) }

        let collected = Collected()
        // Drained as it arrives: a pipe left unread past 64 KB blocks the
        // writer, and a launcher that logs a lot would hang here forever.
        out.fileHandleForReading.readabilityHandler = { collected.append(out: $0.availableData) }
        err.fileHandleForReading.readabilityHandler = { collected.append(err: $0.availableData) }
        let reaped = Reaped()
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
            // Checked under the lock so a reaped pid, possibly reused, is never signalled.
            reaped.unlessReaped { kill(pid, SIGTERM) }
        }
        let status: Int32 = await withCheckedContinuation { cont in
            DispatchQueue.global().async {
                var raw: Int32 = 0
                while waitpid(pid, &raw, 0) == -1 && errno == EINTR {}
                reaped.mark()
                cont.resume(returning: raw)
            }
        }
        out.fileHandleForReading.readabilityHandler = nil
        err.fileHandleForReading.readabilityHandler = nil
        collected.append(out: out.fileHandleForReading.readDataToEndOfFile())
        collected.append(err: err.fileHandleForReading.readDataToEndOfFile())
        // As `Process.terminationStatus`: the exit code, or the signal number.
        let signal = status & 0x7f
        return collected.output(status: signal == 0 ? (status >> 8) & 0xff : signal)
    }

    static func runAndWait(_ exe: String, _ args: [String], timeout: TimeInterval) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return }
        let deadline = Date().addingTimeInterval(timeout)
        while p.isRunning && Date() < deadline { usleep(50_000) }
        if p.isRunning { p.terminate() }
    }

    /// Start `exe` in its own session so it survives this process exiting —
    /// the update helper must outlive the app it is replacing.
    static func detached(_ exe: String, _ args: [String]) throws {
        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSID) | cleanSignals(&attr))
        var fileActions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&fileActions)
        defer { posix_spawn_file_actions_destroy(&fileActions) }
        for fd: Int32 in [0, 1, 2] {
            posix_spawn_file_actions_addopen(&fileActions, fd, "/dev/null", fd == 0 ? O_RDONLY : O_WRONLY, 0)
        }
        let argv = ([exe] + args).map { strdup($0) } + [nil]
        defer { argv.forEach { free($0) } }
        var pid: pid_t = 0
        let rc = posix_spawn(&pid, exe, &fileActions, &attr, argv, environ)
        guard rc == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(rc)) }
    }

    /// Unblocked, default-handled signals in the child, as `Process` gives it.
    /// We spawn from dispatch threads, which block signals, and a child
    /// inheriting that mask shrugs off SIGTERM and Ctrl-C's SIGINT alike.
    /// Returns the flags that make the attributes take effect.
    private static func cleanSignals(_ attr: inout posix_spawnattr_t?) -> Int16 {
        var none = sigset_t(), all = sigset_t()
        sigemptyset(&none)
        sigfillset(&all)
        posix_spawnattr_setsigmask(&attr, &none)
        posix_spawnattr_setsigdefault(&attr, &all)
        return Int16(POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF)
    }

    private final class Reaped: @unchecked Sendable {
        private let lock = NSLock()
        private var done = false
        func mark() { lock.withLock { done = true } }
        func unlessReaped(_ body: () -> Void) { lock.withLock { if !done { body() } } }
    }

    private final class Collected: @unchecked Sendable {
        private let lock = NSLock()
        private var out = Data(), err = Data()
        func append(out d: Data) { lock.withLock { out.append(d) } }
        func append(err d: Data) { lock.withLock { err.append(d) } }
        func output(status: Int32) -> Output {
            lock.withLock {
                Output(status: status, stdout: String(decoding: out, as: UTF8.self), stderr: String(decoding: err, as: UTF8.self))
            }
        }
    }
}
