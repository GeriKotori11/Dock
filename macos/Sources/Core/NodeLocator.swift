// Finds the Node.js binary that runs the host (HOST-CONTROL-PAGE.md 13.6).
// Order: the `nodePath` default, Homebrew on Apple silicon, /usr/local (Intel
// Homebrew and the nodejs.org installer), then the login shell's PATH.
import Foundation

struct NodeLocator {
    static let fixedCandidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
    static let minimumMajor = 20

    /// True when the path is an executable file.
    var isExecutable: (String) -> Bool
    /// Output of `zsh -lc 'command -v node'`, or nil when it failed.
    var loginShellLookup: () -> String?

    /// The node binary to use, or nil when none was found. The login shell is
    /// only asked when nothing else matched (it is slow).
    func locate(override: String?) -> String? {
        if let override, override.hasPrefix("/"), isExecutable(override) { return override }
        for candidate in Self.fixedCandidates where isExecutable(candidate) { return candidate }
        if let output = loginShellLookup(), let path = Self.parseShellOutput(output), isExecutable(path) {
            return path
        }
        return nil
    }

    /// The last line that is an absolute path: login shells can print banners
    /// first, and `command -v` prints an alias or function name for those.
    static func parseShellOutput(_ output: String) -> String? {
        output
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .last(where: { $0.hasPrefix("/") && !$0.contains("\0") })
    }

    /// Major version from `node --version` output ("v26.8.1" → 26).
    static func majorVersion(_ output: String) -> Int? {
        let text = output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.hasPrefix("v") else { return nil }
        let digits = text.dropFirst().prefix { $0.isNumber }
        return Int(digits)
    }

    static func meetsMinimum(_ output: String) -> Bool {
        guard let major = majorVersion(output) else { return false }
        return major >= minimumMajor
    }

    /// The real file system implementation.
    static func live(shellTimeout: TimeInterval = 5) -> NodeLocator {
        NodeLocator(
            isExecutable: { path in
                var isDirectory: ObjCBool = false
                return FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory)
                    && !isDirectory.boolValue
                    && FileManager.default.isExecutableFile(atPath: path)
            },
            loginShellLookup: {
                ProcessRunner.run("/bin/zsh", ["-lc", "command -v node"], timeout: shellTimeout)?.stdout
            }
        )
    }
}

/// Runs a short-lived tool with an argv array (never through a shell string
/// built from data) and a timeout.
enum ProcessRunner {
    struct Output { let status: Int32; let stdout: String; let stderr: String }

    static func run(_ executable: String, _ arguments: [String], timeout: TimeInterval,
                    environment: [String: String]? = nil) -> Output? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        if let environment { process.environment = environment }
        let out = Pipe(), err = Pipe()
        process.standardOutput = out
        process.standardError = err
        process.standardInput = FileHandle.nullDevice
        let done = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in done.signal() }
        do { try process.run() } catch { return nil }
        // Read while it runs so a full pipe can't block the child.
        var outData = Data(), errData = Data()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global().async { outData = out.fileHandleForReading.readDataToEndOfFile(); group.leave() }
        group.enter()
        DispatchQueue.global().async { errData = err.fileHandleForReading.readDataToEndOfFile(); group.leave() }
        if done.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            _ = done.wait(timeout: .now() + 1)
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            _ = group.wait(timeout: .now() + 1)
            return nil
        }
        _ = group.wait(timeout: .now() + 2)
        return Output(status: process.terminationStatus,
                      stdout: String(decoding: outData, as: UTF8.self),
                      stderr: String(decoding: errData, as: UTF8.self))
    }
}
