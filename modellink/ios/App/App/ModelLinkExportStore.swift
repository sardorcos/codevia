import Foundation
import CryptoKit

/// Streams web-generated .mlink/PDF/ZIP files to iOS for system sharing.
/// Avoids loading an entire export into one Capacitor bridge call.
final class ModelLinkExportStore {
    static let shared = ModelLinkExportStore()
    static let maxBytes: Int64 = 200 * 1024 * 1024
    static let chunkMaxBytes = 256 * 1024

    struct ExportItem: Codable {
        let id: String
        let name: String
        let expectedBytes: Int64
        let expectedSHA256: String?
    }

    enum ExportError: LocalizedError {
        case invalidExport
        case invalidLength
        case invalidOffset
        case incomplete
        case checksumMismatch
        var errorDescription: String? {
            switch self {
            case .invalidExport: return "Файл экспорта не найден"
            case .invalidLength: return "Недопустимый размер экспорта"
            case .invalidOffset: return "Нарушен порядок передачи частей файла"
            case .incomplete: return "Файл экспорта передан не полностью"
            case .checksumMismatch: return "Контрольная сумма экспорта не совпала"
            }
        }
    }

    private let fm = FileManager.default
    private let lock = NSLock()
    private init() {}

    private func folder(id: String) throws -> URL {
        guard let uuid = UUID(uuidString: id) else { throw ExportError.invalidExport }
        guard let home = fm.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            throw ExportError.invalidExport
        }
        let base = home.appendingPathComponent("ModelLinkExportQueue", isDirectory: true)
        try fm.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent(uuid.uuidString, isDirectory: true)
    }

    func create(name original: String, expectedBytes: Int64, expectedSHA256: String?) throws -> ExportItem {
        guard expectedBytes > 0, expectedBytes <= Self.maxBytes else { throw ExportError.invalidLength }
        let safe = URL(fileURLWithPath: original).lastPathComponent
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "\\", with: "_")
        guard !safe.isEmpty, safe != ".", safe != ".." else { throw ExportError.invalidExport }
        if let hash = expectedSHA256,
           (hash.count != 64 || hash.range(of: "^[0-9a-fA-F]{64}$", options: .regularExpression) == nil) {
            throw ExportError.invalidExport
        }
        let item = ExportItem(id: UUID().uuidString, name: safe, expectedBytes: expectedBytes,
                              expectedSHA256: expectedSHA256?.lowercased())
        let dir = try folder(id: item.id)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data().write(to: dir.appendingPathComponent("payload.part"))
        try JSONEncoder().encode(item).write(to: dir.appendingPathComponent("state.json"), options: .atomic)
        return item
    }

    private func item(id: String) throws -> ExportItem {
        let state = try folder(id: id).appendingPathComponent("state.json")
        guard fm.fileExists(atPath: state.path) else { throw ExportError.invalidExport }
        return try JSONDecoder().decode(ExportItem.self, from: Data(contentsOf: state))
    }

    func append(id: String, offset: Int64, bytes: Data) throws -> Int64 {
        lock.lock()
        defer { lock.unlock() }
        let export = try item(id: id)
        guard !bytes.isEmpty, bytes.count <= Self.chunkMaxBytes else { throw ExportError.invalidLength }
        let temp = try folder(id: id).appendingPathComponent("payload.part")
        let handle = try FileHandle(forWritingTo: temp)
        defer { try? handle.close() }
        let actual = try handle.seekToEnd()
        guard actual == UInt64(offset), offset + Int64(bytes.count) <= export.expectedBytes else {
            throw ExportError.invalidOffset
        }
        try handle.write(contentsOf: bytes)
        return offset + Int64(bytes.count)
    }

    func finalize(id: String) throws -> URL {
        lock.lock()
        defer { lock.unlock() }
        let export = try item(id: id)
        let dir = try folder(id: id)
        let temp = dir.appendingPathComponent("payload.part")
        let size = try temp.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard Int64(size) == export.expectedBytes else { throw ExportError.incomplete }
        if let expectedHash = export.expectedSHA256 {
            let handle = try FileHandle(forReadingFrom: temp)
            defer { try? handle.close() }
            var hasher = SHA256()
            while true {
                let data = try handle.read(upToCount: 1024 * 1024) ?? Data()
                if data.isEmpty { break }
                hasher.update(data: data)
            }
            let actual = hasher.finalize().map { String(format: "%02x", $0) }.joined()
            guard actual == expectedHash else { throw ExportError.checksumMismatch }
        }
        let final = dir.appendingPathComponent(export.name)
        if !fm.fileExists(atPath: final.path) { try fm.moveItem(at: temp, to: final) }
        return final
    }

    func finalizedURL(id: String) throws -> URL {
        let export = try item(id: id)
        let url = try folder(id: id).appendingPathComponent(export.name)
        guard fm.fileExists(atPath: url.path) else { throw ExportError.incomplete }
        return url
    }

    func remove(id: String) throws {
        _ = try item(id: id)
        try fm.removeItem(at: folder(id: id))
    }
}
