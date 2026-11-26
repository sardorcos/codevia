import Foundation
import UIKit
import PDFKit

/// Conversions that need iOS frameworks: PDF pages → images (PDFKit), any UIImage format
/// (HEIC, TIFF…) → PNG/JPEG/PDF, text, RTF and HTML → paginated PDF (UIKit printing).
/// Mesh and DXF conversions run in the web layer (core/convert.js).
enum ModelLinkConverter {
    static let maxPages = 100
    static let maxTextBytes = 8 * 1024 * 1024
    static let textExtensions: Set<String> = [
        "txt", "md", "markdown", "csv", "tsv", "json", "xml", "css", "js", "mjs", "ts", "py", "php",
        "java", "c", "h", "cpp", "swift", "kt", "rb", "go", "rs", "sh", "yml", "yaml", "ini", "cfg",
        "conf", "log", "sql", "gcode", "nc", "tex", "toml", "env", "properties"
    ]
    static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "tif", "tiff"]

    enum ConvertError: LocalizedError {
        case unsupported
        case unreadable
        case locked
        case tooManyPages
        case tooLarge
        case encodingFailed

        var errorDescription: String? {
            switch self {
            case .unsupported: return "Такое преобразование не поддерживается"
            case .unreadable: return "Не удалось прочитать файл"
            case .locked: return "PDF защищён паролем"
            case .tooManyPages: return "Слишком много страниц: максимум \(ModelLinkConverter.maxPages)"
            case .tooLarge: return "Файл слишком большой для преобразования"
            case .encodingFailed: return "Не удалось записать результат"
            }
        }
    }

    /// Text-based conversions use UIKit print formatters and must run on the main thread.
    static func needsMainThread(source: URL) -> Bool {
        let ext = source.pathExtension.lowercased()
        return textExtensions.contains(ext) || ["html", "htm", "rtf"].contains(ext)
    }

    /// Writes the converted files into `directory` and returns their URLs in page order.
    static func convert(_ source: URL, to target: String, into directory: URL) throws -> [URL] {
        let ext = source.pathExtension.lowercased()
        let base = source.deletingPathExtension().lastPathComponent
        let to = target.lowercased() == "jpg" ? "jpeg" : target.lowercased()
        if ext == "pdf", to == "png" || to == "jpeg" {
            return try pdfToImages(source, format: to, base: base, into: directory)
        }
        if imageExtensions.contains(ext), ["png", "jpeg", "pdf"].contains(to) {
            return [try convertImage(source, format: to, base: base, into: directory)]
        }
        if to == "pdf", textExtensions.contains(ext) || ["html", "htm", "rtf"].contains(ext) {
            return [try textToPDF(source, ext: ext, base: base, into: directory)]
        }
        throw ConvertError.unsupported
    }

    // MARK: PDF → images

    private static func pdfToImages(_ source: URL, format: String, base: String, into directory: URL) throws -> [URL] {
        guard let document = PDFDocument(url: source) else { throw ConvertError.unreadable }
        if document.isLocked { throw ConvertError.locked }
        let count = document.pageCount
        guard count > 0 else { throw ConvertError.unreadable }
        guard count <= maxPages else { throw ConvertError.tooManyPages }
        let digits = String(count).count
        var outputs: [URL] = []
        for index in 0..<count {
            try autoreleasepool {
                guard let page = document.page(at: index) else { return }
                let box = page.bounds(for: .mediaBox)
                let scale = min(2.5, 3200 / max(box.width, box.height, 1))
                let size = CGSize(width: max(1, box.width * scale), height: max(1, box.height * scale))
                let image = page.thumbnail(of: size, for: .mediaBox)
                let number = String(repeating: "0", count: max(0, digits - String(index + 1).count)) + String(index + 1)
                let name = count == 1 ? base : "\(base)-\(number)"
                outputs.append(try write(image: flatten(image, opaque: true), format: format, name: name, into: directory))
            }
        }
        return outputs
    }

    // MARK: images

    private static func convertImage(_ source: URL, format: String, base: String, into directory: URL) throws -> URL {
        guard let image = UIImage(contentsOfFile: source.path) else { throw ConvertError.unreadable }
        if format == "pdf" {
            let flat = flatten(image, opaque: false)
            let bounds = CGRect(origin: .zero, size: flat.size)
            let data = UIGraphicsPDFRenderer(bounds: bounds).pdfData { context in
                context.beginPage()
                flat.draw(in: bounds)
            }
            let url = directory.appendingPathComponent("\(base).pdf")
            try data.write(to: url, options: .atomic)
            return url
        }
        return try write(image: flatten(image, opaque: format == "jpeg"), format: format, name: base, into: directory)
    }

    /// Applies EXIF orientation, drops the screen scale and (for JPEG) paints on white.
    private static func flatten(_ image: UIImage, opaque: Bool) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = opaque
        let size = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            if opaque {
                UIColor.white.setFill()
                context.fill(CGRect(origin: .zero, size: size))
            }
            image.draw(in: CGRect(origin: .zero, size: size))
        }
    }

    private static func write(image: UIImage, format: String, name: String, into directory: URL) throws -> URL {
        let data = format == "png" ? image.pngData() : image.jpegData(compressionQuality: 0.9)
        guard let bytes = data else { throw ConvertError.encodingFailed }
        let url = directory.appendingPathComponent("\(name).\(format == "png" ? "png" : "jpg")")
        try bytes.write(to: url, options: .atomic)
        return url
    }

    // MARK: text, RTF, HTML → PDF

    private static func textToPDF(_ source: URL, ext: String, base: String, into directory: URL) throws -> URL {
        let size = (try? source.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size <= maxTextBytes else { throw ConvertError.tooLarge }
        let formatter: UIPrintFormatter
        if ext == "html" || ext == "htm" {
            formatter = UIMarkupTextPrintFormatter(markupText: try readText(source))
        } else if ext == "rtf" {
            let attributed = try NSAttributedString(
                url: source, options: [.documentType: NSAttributedString.DocumentType.rtf], documentAttributes: nil)
            formatter = UISimpleTextPrintFormatter(attributedText: attributed)
        } else {
            let font = UIFont.monospacedSystemFont(ofSize: 9.5, weight: .regular)
            let attributed = NSAttributedString(string: try readText(source), attributes: [
                .font: font, .foregroundColor: UIColor.black
            ])
            formatter = UISimpleTextPrintFormatter(attributedText: attributed)
        }

        let renderer = UIPrintPageRenderer()
        renderer.addPrintFormatter(formatter, startingAtPageAt: 0)
        let paper = CGRect(x: 0, y: 0, width: 595.2, height: 841.8) // A4
        renderer.setValue(NSValue(cgRect: paper), forKey: "paperRect")
        renderer.setValue(NSValue(cgRect: paper.insetBy(dx: 40, dy: 44)), forKey: "printableRect")

        let data = NSMutableData()
        UIGraphicsBeginPDFContextToData(data, paper, nil)
        let pages = max(1, renderer.numberOfPages)
        renderer.prepare(forDrawingPages: NSRange(location: 0, length: pages))
        for page in 0..<pages {
            UIGraphicsBeginPDFPage()
            renderer.drawPage(at: page, in: UIGraphicsGetPDFContextBounds())
        }
        UIGraphicsEndPDFContext()

        let url = directory.appendingPathComponent("\(base).pdf")
        try (data as Data).write(to: url, options: .atomic)
        return url
    }

    private static func readText(_ url: URL) throws -> String {
        let data = try Data(contentsOf: url)
        for encoding in [String.Encoding.utf8, .utf16, .windowsCP1251, .isoLatin1] {
            if let text = String(data: data, encoding: encoding) { return text }
        }
        throw ConvertError.unreadable
    }
}
