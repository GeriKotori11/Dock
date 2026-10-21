// Host stdout/stderr log: ~/Library/Logs/WinDock/host.log, rotated at 1 MB,
// keeping host.log plus host.1.log and host.2.log (three files in all), the
// same scheme as the Windows tray (HOST-CONTROL-PAGE.md 13.6).
import Foundation

final class HostLog {
    static let defaultMaxBytes: UInt64 = 1024 * 1024
    static let defaultKeep = 3

    static var defaultDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/WinDock", isDirectory: true)
    }

    let directory: URL
    let maxBytes: UInt64
    let keep: Int
    private let queue = DispatchQueue(label: "dev.gerikotori.windock.menu.log")
    private var handle: FileHandle?
    private static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        return f
    }()

    init(directory: URL = HostLog.defaultDirectory, maxBytes: UInt64 = HostLog.defaultMaxBytes,
         keep: Int = HostLog.defaultKeep) {
        self.directory = directory
        self.maxBytes = maxBytes
        self.keep = max(1, keep)
    }

    func fileURL(_ index: Int) -> URL {
        directory.appendingPathComponent(index == 0 ? "host.log" : "host.\(index).log")
    }

    /// Appends one line from a stream ("out", "err" or "app"). Never throws.
    func write(stream: String, line: String) {
        let date = Date()
        queue.async { self.append(stream: stream, line: line, date: date) }
    }

    /// Synchronous variant for tests and shutdown.
    func writeSync(stream: String, line: String, date: Date = Date()) {
        queue.sync { self.append(stream: stream, line: line, date: date) }
    }

    func mark(_ message: String) { write(stream: "app", line: message) }

    func flush() { queue.sync {} }

    func close() { queue.sync { closeHandle() } }

    private func append(stream: String, line: String, date: Date) {
        let text = "\(Self.stamp.string(from: date)) [\(stream)] \(line)\n"
        do {
            if handle == nil { try open() }
            if let handle, try handle.offset() >= maxBytes {
                closeHandle()
                rotate()
                try open()
            }
            try handle?.write(contentsOf: Data(text.utf8))
        } catch {
            closeHandle()
        }
    }

    private func open() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = fileURL(0)
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
        self.handle = handle
    }

    private func rotate() {
        let fm = FileManager.default
        try? fm.removeItem(at: fileURL(keep - 1))
        guard keep > 1 else { try? fm.removeItem(at: fileURL(0)); return }
        for index in stride(from: keep - 2, through: 0, by: -1) where fm.fileExists(atPath: fileURL(index).path) {
            try? fm.moveItem(at: fileURL(index), to: fileURL(index + 1))
        }
    }

    private func closeHandle() {
        try? handle?.close()
        handle = nil
    }
}

/// Splits a byte stream into lines (pipe reads arrive in arbitrary chunks).
struct LineSplitter {
    private var buffer = Data()

    /// Lines completed by this chunk, without their terminators.
    mutating func feed(_ data: Data) -> [String] {
        buffer.append(data)
        var lines: [String] = []
        while let newline = buffer.firstIndex(of: 0x0A) {
            var lineData = buffer[buffer.startIndex..<newline]
            if lineData.last == 0x0D { lineData = lineData.dropLast() }
            lines.append(String(decoding: lineData, as: UTF8.self))
            buffer.removeSubrange(buffer.startIndex...newline)
        }
        return lines
    }

    /// Whatever is left at end of stream.
    mutating func finish() -> String? {
        defer { buffer.removeAll() }
        return buffer.isEmpty ? nil : String(decoding: buffer, as: UTF8.self)
    }
}

/// The line shown as the offline page's detail (5.8): the last meaningful
/// stderr line, without the "WinDock failed to start: " prefix.
enum HostErrorLine {
    static let failPrefix = "WinDock failed to start: "

    /// Whether a stderr line should replace the remembered one. Node ends a
    /// crash with a "Node.js v26.0.0" footer, which says nothing useful.
    static func isMeaningful(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return false }
        if trimmed.range(of: #"^Node\.js v\d+"#, options: .regularExpression) != nil { return false }
        return true
    }

    static func detail(_ line: String) -> String {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.hasPrefix(failPrefix) ? String(trimmed.dropFirst(failPrefix.count)) : trimmed
    }

    static func isPortInUse(_ line: String) -> Bool { line.contains("EADDRINUSE") }
}
