import Foundation
import CryptoKit
import UniformTypeIdentifiers

/// App-local staging for incoming CAD files. It does NOT parse or convert CAD.
/// All paths exposed to JavaScript are opaque UUIDs, never filesystem paths.
final class ModelLinkImportStore {
    static let shared = ModelLinkImportStore()
    static let maxFileBytes: Int64 = 200 * 1024 * 1024
    static let maxImportCount = 30

    struct Item: Codable {
        let id: String
        let name: String
        let size: Int64
        let mimeType: String
        let sha256: String
        let createdAt: String
        let source: String

        var dictionary: [String: Any] {
            ["id": id, "name": name, "size": size, "mimeType": mimeType,
             "sha256": sha256, "createdAt": createdAt, "source": source]
        }
    }

    enum StoreError: LocalizedError {
        case invalidIdentifier
        case invalidFilename
        case oversizedFile
        case insufficientSpace
        case notFound
                case invalidOffset
        case symlinkNotAllowed
        case invalidFile
        case tooManyFiles

        var errorDescription: String? {
            switch self {
            case .invalidIdentifier: return "Некорректный идентификатор файла"
            case .invalidFilename: return "Некорректное имя файла"
            case .oversizedFile: return "Файл превышает лимит 200 МиБ"
            case .insufficientSpace: return "Недостаточно памяти устройства"
            case .notFound: return "Импортированный файл не найден"
            case .invalidOffset: return "Некорректное смещение чтения"
            case .symlinkNotAllowed: return "Символические ссылки не импортируются"
            case .invalidFile: return "Файл недоступен или повреждён"
            case .tooManyFiles: return "Можно импортировать не более 30 файлов за один раз"
            }
        }
    }

    private let fm = FileManager.default
    private init() {}

    private func root() throws -> URL {
        guard let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw StoreError.notFound
        }
        var folder = base.appendingPathComponent("ModelLink/ImportedFiles", isDirectory: true)
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        var attributes = URLResourceValues()
        attributes.isExcludedFromBackup = true // Staging is recoverable from the originals.
        try folder.setResourceValues(attributes)
        return folder
    }

    private func storageDirectory(for id: String) throws -> URL {
        guard let uuid = UUID(uuidString: id) else { throw StoreError.invalidIdentifier }
        return try root().appendingPathComponent(uuid.uuidString, isDirectory: true)
    }

    private func safeName(_ input: String) throws -> String {
        let name = URL(fileURLWithPath: input).lastPathComponent
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "\\", with: "_")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
        guard !name.isEmpty, name != ".", name != "..", !name.hasPrefix(".metadata") else {
            throw StoreError.invalidFilename
        }
        return name
    }

    /// Copies a file provider's security-scoped URL into our app container.
    /// Uses NSFileCoordinator while the access scope is active.
    func stageExternal(_ external: URL, source: String = "picker") throws -> Item {
        let name = try safeName(external.lastPathComponent)
        let scoped = external.startAccessingSecurityScopedResource()
        defer { if scoped { external.stopAccessingSecurityScopedResource() } }
        let attributes = try external.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey, .fileSizeKey])
        if attributes.isSymbolicLink == true { throw StoreError.symlinkNotAllowed }
        if attributes.isDirectory == true { throw StoreError.invalidFile }
        if let size = attributes.fileSize, Int64(size) > Self.maxFileBytes { throw StoreError.oversizedFile }

        let id = UUID().uuidString
        let directory = try storageDirectory(for: id)
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let target = directory.appendingPathComponent(name, isDirectory: false)
        var coordinationError: NSError?
        var copiedError: Error?
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: external, options: [], error: &coordinationError) { readable in
            do { try self.fm.copyItem(at: readable, to: target) }
            catch { copiedError = error }
        }
        if let error = (coordinationError as Error?) ?? copiedError { try? fm.removeItem(at: directory); throw error }
        do {
            return try finalize(id: id, name: name, source: source)
        } catch {
            try? fm.removeItem(at: directory)
            throw error
        }
    }

    /// The source MUST be an app-owned file URL.
    func stageOwned(_ sourceURL: URL, source: String) throws -> Item {
        let name = try safeName(sourceURL.lastPathComponent)
        let id = UUID().uuidString
        let directory = try storageDirectory(for: id)
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        do {
            try fm.copyItem(at: sourceURL, to: directory.appendingPathComponent(name))
            return try finalize(id: id, name: name, source: source)
        } catch {
            try? fm.removeItem(at: directory)
            throw error
        }
    }

    private func finalize(id: String, name: String, source: String) throws -> Item {
        let dir = try storageDirectory(for: id)
        let file = dir.appendingPathComponent(name)
        let values = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true, let bytes = values.fileSize else {
            throw StoreError.invalidFile
        }
        guard bytes <= Int(Self.maxFileBytes) else { throw StoreError.oversizedFile }
        let ext = file.pathExtension.lowercased()
        let item = Item(
            id: id, name: name, size: Int64(bytes),
            mimeType: UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream",
            sha256: try sha256(file),
            createdAt: ISO8601DateFormatter().string(from: Date()), source: source
        )
        try JSONEncoder().encode(item).write(to: dir.appendingPathComponent(".metadata.json"), options: .atomic)
        try fm.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: file.path)
        return item
    }

    func metadata(id: String) throws -> Item {
        let url = try storageDirectory(for: id).appendingPathComponent(".metadata.json")
        guard fm.fileExists(atPath: url.path) else { throw StoreError.notFound }
        return try JSONDecoder().decode(Item.self, from: Data(contentsOf: url))
    }

    func fileURL(id: String) throws -> URL {
        let item = try metadata(id: id)
        let file = try storageDirectory(for: id).appendingPathComponent(item.name)
        guard fm.fileExists(atPath: file.path) else { throw StoreError.notFound }
        let attributes = try file.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])
        guard attributes.isRegularFile == true, attributes.isSymbolicLink != true else { throw StoreError.invalidFile }
        return file
    }

    func list() throws -> [Item] {
        let folder = try root()
        return try fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .compactMap { child -> Item? in
                guard UUID(uuidString: child.lastPathComponent) != nil else { return nil }
                return try? metadata(id: child.lastPathComponent)
            }
            .sorted { $0.createdAt > $1.createdAt }
    }

    func readChunk(id: String, offset: Int64, maxLength: Int) throws -> (Data, Bool) {
        let item = try metadata(id: id)
        guard offset >= 0, offset <= item.size, maxLength > 0, maxLength <= 256 * 1024 else {
            throw StoreError.invalidOffset
        }
        let handle = try FileHandle(forReadingFrom: fileURL(id: id))
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        let bytes = try handle.read(upToCount: maxLength) ?? Data()
        return (bytes, offset + Int64(bytes.count) >= item.size)
    }

    func remove(id: String) throws {
        _ = try metadata(id: id)
        try fm.removeItem(at: storageDirectory(for: id))
    }

    // MARK: - Files opened in ModelLink from other apps ("Open in…", AirDrop, Files)

    private func inboxRoot() throws -> URL {
        guard let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw StoreError.notFound
        }
        let folder = base.appendingPathComponent("ModelLink/Inbox", isDirectory: true)
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    /// Copies a URL handed over by iOS into the app-private inbox. The web layer picks it up
    /// with `drainInbox`. iOS's own Documents/Inbox copy is removed afterwards.
    @discardableResult
    func enqueueIncoming(_ external: URL) throws -> URL {
        let name = try safeName(external.lastPathComponent)
        let scoped = external.startAccessingSecurityScopedResource()
        defer { if scoped { external.stopAccessingSecurityScopedResource() } }
        let attributes = try external.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey, .fileSizeKey])
        if attributes.isSymbolicLink == true { throw StoreError.symlinkNotAllowed }
        if attributes.isDirectory == true { throw StoreError.invalidFile }
        if let size = attributes.fileSize, Int64(size) > Self.maxFileBytes { throw StoreError.oversizedFile }
        let folder = try inboxRoot().appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        let target = folder.appendingPathComponent(name, isDirectory: false)
        var coordinationError: NSError?
        var copiedError: Error?
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: external, options: [], error: &coordinationError) { readable in
            do { try self.fm.copyItem(at: readable, to: target) }
            catch { copiedError = error }
        }
        if let error = (coordinationError as Error?) ?? copiedError { try? fm.removeItem(at: folder); throw error }
        if let documents = fm.urls(for: .documentDirectory, in: .userDomainMask).first,
           external.standardizedFileURL.path.hasPrefix(documents.appendingPathComponent("Inbox").standardizedFileURL.path) {
            try? fm.removeItem(at: external)
        }
        return target
    }

    /// Moves inbox files into staging. Folders are deleted only after a successful copy,
    /// so partial failures are retried on the next drain.
    func drainInbox() throws -> ([Item], [String]) {
        let inbox = try inboxRoot()
        let folders = try fm.contentsOfDirectory(at: inbox, includingPropertiesForKeys: [.isDirectoryKey])
        var imported: [Item] = []
        var errors: [String] = []
        for folder in folders {
            guard (try? folder.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else { continue }
            let files = (try? fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.isRegularFileKey])) ?? []
            var allSucceeded = true
            for file in files {
                do { imported.append(try stageOwned(file, source: "openIn")) }
                catch { allSucceeded = false; errors.append("\(file.lastPathComponent): \(error.localizedDescription)") }
            }
            if allSucceeded { try? fm.removeItem(at: folder) }
        }
        return (imported, errors)
    }

    private func sha256(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var digest = SHA256()
        while true {
            let bytes = try handle.read(upToCount: 1024 * 1024) ?? Data()
            if bytes.isEmpty { break }
            digest.update(data: bytes)
        }
        return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
