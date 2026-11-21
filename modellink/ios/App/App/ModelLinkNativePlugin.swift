import Foundation
import UIKit
import QuickLook
import UniformTypeIdentifiers
import Capacitor

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
        CAPPluginMethod(name: "previewExport", returnType: CAPPluginReturnPromise)
    ]

    private var pendingPickCall: CAPPluginCall?
    private var quickLookURL: URL?
    private var pendingPreviewCall: CAPPluginCall?
    private var inboxObserver: NSObjectProtocol?

    override public func load() {
        inboxObserver = NotificationCenter.default.addObserver(
            forName: Self.inboxChanged, object: nil, queue: .main
        ) { [weak self] _ in
            self?.notifyListeners("inboxChanged", data: [:], retainUntilConsumed: true)
        }
    }

    deinit {
        if let observer = inboxObserver { NotificationCenter.default.removeObserver(observer) }
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
            guard nativePreviewExtensions.contains(file.pathExtension.lowercased()) else {
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
            guard nativePreviewExtensions.contains(file.pathExtension.lowercased()) else {
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

    public func previewControllerDidDismiss(_ controller: QLPreviewController) {
        quickLookURL = nil
        if let call = pendingPreviewCall {
            pendingPreviewCall = nil
            call.resolve(["presented": true])
        }
    }
}
