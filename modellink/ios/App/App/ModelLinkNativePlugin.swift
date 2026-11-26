import Foundation
import UIKit
import QuickLook
import UniformTypeIdentifiers
import Capacitor
import AVFoundation

/// Native iOS bridge for the existing ModelLink web app.
/// Existing CAD rendering remains in the web layer; the bridge handles system files and previews.
@objc(ModelLinkNativePlugin)
public final class ModelLinkNativePlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate,
    QLPreviewControllerDataSource, QLPreviewControllerDelegate {
    static let inboxChanged = Notification.Name("ModelLinkInboxChanged")

    public let identifier = "ModelLinkNativePlugin"
    public let jsName = "ModelLinkNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listStaged", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readChunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteStaged", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "nativePreview", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "drainInbox", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "beginExport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "appendExportChunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finalizeExport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareExport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteExport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "previewExport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "convertExport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareStaged", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keychainGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keychainSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keychainDelete", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPrivacy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanQR", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fetchText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wipeTemp", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "screenState", returnType: CAPPluginReturnPromise)
    ]

    private var pendingPickCall: CAPPluginCall?
    private var quickLookURL: URL?
    private var pendingPreviewCall: CAPPluginCall?
    private var inboxObserver: NSObjectProtocol?
    private var securityObservers: [NSObjectProtocol] = []

    override public func load() {
        inboxObserver = NotificationCenter.default.addObserver(
            forName: Self.inboxChanged, object: nil, queue: .main
        ) { [weak self] _ in
            self?.notifyListeners("inboxChanged", data: [:], retainUntilConsumed: true)
        }
        let center = NotificationCenter.default
        securityObservers.append(center.addObserver(forName: UIApplication.userDidTakeScreenshotNotification, object: nil, queue: .main) { [weak self] _ in
            self?.notifyListeners("screenshot", data: [:])
        })
        securityObservers.append(center.addObserver(forName: UIScreen.capturedDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.notifyListeners("capture", data: ["captured": UIScreen.main.isCaptured])
        })
        securityObservers.append(center.addObserver(forName: ModelLinkSecurity.panic, object: nil, queue: .main) { [weak self] _ in
            self?.notifyListeners("panic", data: ["source": "faceDown"])
        })
    }

    deinit {
        if let observer = inboxObserver { NotificationCenter.default.removeObserver(observer) }
        securityObservers.forEach { NotificationCenter.default.removeObserver($0) }
    }
    private let nativePreviewExtensions: Set<String> = [
        "pdf", "usdz", "png", "jpg", "jpeg", "gif", "webp", "tif", "tiff", "txt", "rtf",
        "pages", "numbers", "key", "docx", "xlsx", "pptx", "heic", "csv", "doc", "xls", "ppt", "reality"
    ]

    @objc public func capabilities(_ call: CAPPluginCall) {
        call.resolve([
            "platform": "ios",
            "version": "0.4.0",
            "maxFileBytes": Int(ModelLinkImportStore.maxFileBytes),
            "chunkMaxBytes": 256 * 1024,
            "picker": true,
            "shareSheet": true,
            "quickLook": true,
            "incomingShare": true,
            "quickLookExtensions": Array(nativePreviewExtensions).sorted()
        ])
    }

    @objc public func pickFiles(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.pendingPickCall == nil else {
                call.reject("Окно выбора файлов уже открыто")
                return
            }
            guard let presenter = self.bridge?.viewController else {
                call.reject("Не удалось открыть системный выбор файлов")
                return
            }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
            picker.allowsMultipleSelection = true
            picker.shouldShowFileExtensions = true
            picker.delegate = self
            self.pendingPickCall = call
            presenter.present(picker, animated: true)
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard let call = pendingPickCall else { return }
        pendingPickCall = nil
        call.resolve(["cancelled": true, "files": []])
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pendingPickCall else { return }
        pendingPickCall = nil
        if urls.count > ModelLinkImportStore.maxImportCount {
            call.reject("Слишком много файлов: максимум 30 за один раз")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            var files: [[String: Any]] = []
            var errors: [String] = []
            for url in urls {
                do { files.append(try ModelLinkImportStore.shared.stageExternal(url).dictionary) }
                catch { errors.append("\(url.lastPathComponent): \(error.localizedDescription)") }
            }
            DispatchQueue.main.async {
                call.resolve(["cancelled": false, "files": files, "errors": errors])
            }
        }
    }

    @objc public func listStaged(_ call: CAPPluginCall) {
        do { call.resolve(["files": try ModelLinkImportStore.shared.list().map(\.dictionary)]) }
        catch { call.reject(error.localizedDescription) }
    }

    @objc public func readChunk(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let offset = call.getInt("offset") else {
            call.reject("Нужны id и offset")
            return
        }
        let requestedLength = call.getInt("length") ?? (128 * 1024)
        do {
            let (data, eof) = try ModelLinkImportStore.shared.readChunk(
                id: id, offset: Int64(offset), maxLength: requestedLength
            )
            call.resolve([
                "base64": data.base64EncodedString(),
                "byteCount": data.count,
                "eof": eof,
                "nextOffset": offset + data.count
            ])
        } catch { call.reject(error.localizedDescription) }
    }

    @objc public func deleteStaged(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("Нужен id"); return }
        do {
            try ModelLinkImportStore.shared.remove(id: id)
            call.resolve(["deleted": true])
        } catch { call.reject(error.localizedDescription) }
    }

    @objc public func nativePreview(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("Нужен id"); return }
        do {
            let file = try ModelLinkImportStore.shared.fileURL(id: id)
            guard QLPreviewController.canPreview(file as NSURL) else {
                call.resolve(["presented": false, "reason": "not_supported_by_quicklook"])
                return
            }
            DispatchQueue.main.async {
                guard let presenter = self.bridge?.viewController else {
                    call.reject("Контроллер просмотра недоступен")
                    return
                }
                self.quickLookURL = file
                let preview = QLPreviewController()
                preview.dataSource = self
                presenter.present(preview, animated: true) {
                    call.resolve(["presented": true])
                }
            }
        } catch { call.reject(error.localizedDescription) }
    }

    public func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
        quickLookURL == nil ? 0 : 1
    }

    public func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        // The stored URL is app-owned and remains valid after picker dismissal.
        guard let url = quickLookURL else { return NSURL(fileURLWithPath: NSTemporaryDirectory()) }
        return url as NSURL
    }

    @objc public func shareFile(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("Нужен id"); return }
        do {
            let url = try ModelLinkImportStore.shared.fileURL(id: id)
            DispatchQueue.main.async {
                guard let presenter = self.bridge?.viewController else {
                    call.reject("Системное меню передачи недоступно")
                    return
                }
                let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
                share.popoverPresentationController?.sourceView = presenter.view
                share.popoverPresentationController?.sourceRect = CGRect(
                    x: presenter.view.bounds.midX, y: presenter.view.bounds.maxY - 48,
                    width: 1, height: 1
                )
                share.completionWithItemsHandler = { _, finished, _, error in
                    if let error = error { call.reject(error.localizedDescription) }
                    else { call.resolve(["completed": finished]) }
                }
                presenter.present(share, animated: true)
            }
        } catch { call.reject(error.localizedDescription) }
    }

    @objc public func drainInbox(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let (items, errors) = try ModelLinkImportStore.shared.drainInbox()
                DispatchQueue.main.async {
                    call.resolve(["files": items.map(\.dictionary), "errors": errors])
                }
            } catch {
                DispatchQueue.main.async { call.reject(error.localizedDescription) }
            }
        }
    }

    @objc public func beginExport(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), let bytes = call.getInt("size") else {
            call.reject("Нужны имя и размер экспорта"); return
        }
        do {
            let item = try ModelLinkExportStore.shared.create(
                name: name, expectedBytes: Int64(bytes), expectedSHA256: call.getString("sha256")
            )
            call.resolve(["exportId": item.id])
        } catch { call.reject(error.localizedDescription) }
    }

    @objc public func appendExportChunk(_ call: CAPPluginCall) {
        guard let id = call.getString("exportId"), let offset = call.getInt("offset"),
              let base64 = call.getString("base64"), let data = Data(base64Encoded: base64) else {
            call.reject("Некорректная часть файла"); return
        }
        do {
            let next = try ModelLinkExportStore.shared.append(id: id, offset: Int64(offset), bytes: data)
            call.resolve(["nextOffset": next])
        } catch { call.reject(error.localizedDescription) }
    }

    @objc public func finalizeExport(_ call: CAPPluginCall) {
        guard let id = call.getString("exportId") else { call.reject("Нужен exportId"); return }
        do {
            _ = try ModelLinkExportStore.shared.finalize(id: id)
            call.resolve(["ready": true])
        } catch { call.reject(error.localizedDescription) }
    }

    @objc public func shareExport(_ call: CAPPluginCall) {
        guard let id = call.getString("exportId") else { call.reject("Нужен exportId"); return }
        do {
            let file = try ModelLinkExportStore.shared.finalizedURL(id: id)
            DispatchQueue.main.async {
                guard let presenter = self.bridge?.viewController else {
                    call.reject("Системное меню передачи недоступно"); return
                }
                let controller = UIActivityViewController(activityItems: [file], applicationActivities: nil)
                controller.popoverPresentationController?.sourceView = presenter.view
                controller.popoverPresentationController?.sourceRect = CGRect(x: presenter.view.bounds.midX,
                    y: presenter.view.bounds.maxY - 48, width: 1, height: 1)
                controller.completionWithItemsHandler = { _, completed, _, error in
                    if let error = error { call.reject(error.localizedDescription) }
                    else { call.resolve(["completed": completed]) }
                }
                presenter.present(controller, animated: true)
            }
        } catch { call.reject(error.localizedDescription) }
    }

    @objc public func deleteExport(_ call: CAPPluginCall) {
        guard let id = call.getString("exportId") else { call.reject("Нужен exportId"); return }
        do { try ModelLinkExportStore.shared.remove(id: id); call.resolve(["deleted": true]) }
        catch { call.reject(error.localizedDescription) }
    }

    /// Opens a finalized export (PDF, image, USDZ, Office…) in Quick Look.
    /// Resolves when the user closes the preview, so the caller can delete the export.
    @objc public func previewExport(_ call: CAPPluginCall) {
        guard let id = call.getString("exportId") else { call.reject("Нужен exportId"); return }
        do {
            let file = try ModelLinkExportStore.shared.finalizedURL(id: id)
            guard QLPreviewController.canPreview(file as NSURL) else {
                call.resolve(["presented": false, "reason": "not_supported_by_quicklook"]); return
            }
            DispatchQueue.main.async {
                guard self.pendingPreviewCall == nil, let presenter = self.bridge?.viewController else {
                    call.reject("Просмотр уже открыт"); return
                }
                self.quickLookURL = file
                self.pendingPreviewCall = call
                let preview = QLPreviewController()
                preview.dataSource = self
                preview.delegate = self
                presenter.present(preview, animated: true)
            }
        } catch { call.reject(error.localizedDescription) }
    }

    /// Converts a finalized export (PDF → PNG/JPEG pages, HEIC/TIFF → PNG/JPEG/PDF, text/RTF/HTML → PDF).
    /// Results are staged like imports: JS reads them with `readChunk` or shares them with `shareStaged`.
    @objc public func convertExport(_ call: CAPPluginCall) {
        guard let id = call.getString("exportId"), let target = call.getString("to") else {
            call.reject("Нужны exportId и формат"); return
        }
        let source: URL
        do { source = try ModelLinkExportStore.shared.finalizedURL(id: id) }
        catch { call.reject(error.localizedDescription); return }
        let work = {
            let temp = FileManager.default.temporaryDirectory
                .appendingPathComponent("ModelLinkConvert-\(UUID().uuidString)", isDirectory: true)
            defer { try? FileManager.default.removeItem(at: temp) }
            do {
                try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
                let outputs = try ModelLinkConverter.convert(source, to: target, into: temp)
                let items = try outputs.map { try ModelLinkImportStore.shared.stageOwned($0, source: "convert") }
                let result: [String: Any] = ["files": items.map(\.dictionary)]
                DispatchQueue.main.async { call.resolve(result) }
            } catch {
                DispatchQueue.main.async { call.reject(error.localizedDescription) }
            }
        }
        if ModelLinkConverter.needsMainThread(source: source) {
            DispatchQueue.main.async(execute: work)
        } else {
            DispatchQueue.global(qos: .userInitiated).async(execute: work)
        }
    }

    /// Shares one or several staged files (e.g. every page of a converted PDF) in one Share Sheet.
    @objc public func shareStaged(_ call: CAPPluginCall) {
        let ids = (call.getArray("ids") as? [String]) ?? []
        guard !ids.isEmpty else { call.reject("Нет файлов для передачи"); return }
        do {
            let urls = try ids.map { try ModelLinkImportStore.shared.fileURL(id: $0) }
            DispatchQueue.main.async {
                guard let presenter = self.bridge?.viewController else {
                    call.reject("Системное меню передачи недоступно"); return
                }
                let controller = UIActivityViewController(activityItems: urls, applicationActivities: nil)
                controller.popoverPresentationController?.sourceView = presenter.view
                controller.popoverPresentationController?.sourceRect = CGRect(x: presenter.view.bounds.midX,
                    y: presenter.view.bounds.maxY - 48, width: 1, height: 1)
                controller.completionWithItemsHandler = { _, completed, _, error in
                    if let error = error { call.reject(error.localizedDescription) }
                    else { call.resolve(["completed": completed]) }
                }
                presenter.present(controller, animated: true)
            }
        } catch { call.reject(error.localizedDescription) }
    }

    // MARK: Security

    @objc public func authenticate(_ call: CAPPluginCall) {
        let reason = call.getString("reason") ?? "Откройте сейф ModelLink"
        ModelLinkSecurity.shared.authenticate(reason: reason) { ok, biometry, error in
            var result: [String: Any] = ["ok": ok, "biometry": biometry]
            if let error = error { result["error"] = error }
            call.resolve(result)
        }
    }

    @objc public func keychainGet(_ call: CAPPluginCall) {
        guard let name = call.getString("name") else { call.reject("Нужно имя"); return }
        if let data = ModelLinkSecurity.shared.keychainGet(name) { call.resolve(["value": data.base64EncodedString()]) }
        else { call.resolve([:]) }
    }

    @objc public func keychainSet(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), let value = call.getString("value"), let data = Data(base64Encoded: value) else {
            call.reject("Нужны имя и значение"); return
        }
        call.resolve(["ok": ModelLinkSecurity.shared.keychainSet(name, data: data)])
    }

    @objc public func keychainDelete(_ call: CAPPluginCall) {
        guard let name = call.getString("name") else { call.reject("Нужно имя"); return }
        ModelLinkSecurity.shared.keychainDelete(name)
        call.resolve(["ok": true])
    }

    @objc public func setPrivacy(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let shield = call.getBool("shield") { ModelLinkSecurity.shared.shieldEnabled = shield; if !shield { ModelLinkSecurity.shared.hideShield() } }
            if let motion = call.getBool("panicMotion") { ModelLinkSecurity.shared.setPanicMotion(motion) }
            call.resolve(["captured": UIScreen.main.isCaptured])
        }
    }

    @objc public func screenState(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(["captured": UIScreen.main.isCaptured]) }
    }

    @objc public func scanQR(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else { call.reject("Камера недоступна"); return }
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async {
                    guard granted else { call.reject("Нет доступа к камере. Разрешите его в Настройках iPhone."); return }
                    let scanner = ModelLinkQRScanner()
                    scanner.modalPresentationStyle = .fullScreen
                    scanner.completion = { text in
                        if let text = text { call.resolve(["text": text]) } else { call.resolve(["cancelled": true]) }
                    }
                    presenter.present(scanner, animated: true)
                }
            }
        }
    }

    /// HTTPS GET used only for package revocation lists (the web layer has no network access by CSP).
    @objc public func fetchText(_ call: CAPPluginCall) {
        guard let string = call.getString("url"), let url = URL(string: string), url.scheme == "https" else {
            call.reject("Нужен адрес https://"); return
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8)
        request.setValue("ModelLink", forHTTPHeaderField: "User-Agent")
        URLSession(configuration: .ephemeral).dataTask(with: request) { data, response, error in
            DispatchQueue.main.async {
                if let error = error { call.reject(error.localizedDescription); return }
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                let text = data.flatMap { String(data: $0.prefix(512 * 1024), encoding: .utf8) } ?? ""
                call.resolve(["status": status, "text": text])
            }
        }.resume()
    }

    @objc public func wipeTemp(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            let removed = ModelLinkSecurity.shared.wipeTemporaryFiles()
            DispatchQueue.main.async { call.resolve(["removed": removed]) }
        }
    }

    public func previewControllerDidDismiss(_ controller: QLPreviewController) {
        quickLookURL = nil
        if let call = pendingPreviewCall {
            pendingPreviewCall = nil
            call.resolve(["presented": true])
        }
    }
}
