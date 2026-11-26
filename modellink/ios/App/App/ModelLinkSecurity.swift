import Foundation
import UIKit
import LocalAuthentication
import Security
import AVFoundation
import CoreMotion

/// Device-level protections used by the web layer: Face ID, device-only Keychain items, privacy shield,
/// face-down "panic" gesture, screenshot / screen-recording signals, QR scanning and temp-file wiping.
final class ModelLinkSecurity {
    static let shared = ModelLinkSecurity()
    static let panic = Notification.Name("ModelLinkPanic")

    var shieldEnabled = false
    private var shieldView: UIView?
    private let motion = CMMotionManager()
    private var faceDownSince: Date?

    // MARK: Biometrics / device passcode

    func authenticate(reason: String, completion: @escaping (Bool, String, String?) -> Void) {
        let context = LAContext()
        var error: NSError?
        let biometry: String
        if context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) {
            switch context.biometryType {
            case .faceID: biometry = "faceID"
            case .touchID: biometry = "touchID"
            default: biometry = "none"
            }
        } else { biometry = "none" }
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            completion(false, biometry, error?.localizedDescription ?? "На устройстве не настроен код-пароль")
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, err in
            DispatchQueue.main.async { completion(ok, biometry, ok ? nil : err?.localizedDescription) }
        }
    }

    // MARK: Keychain (this device only: not restored from backups, not synced)

    private func query(_ name: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: (Bundle.main.bundleIdentifier ?? "ModelLink") + ".secure",
         kSecAttrAccount as String: name]
    }

    func keychainSet(_ name: String, data: Data) -> Bool {
        SecItemDelete(query(name) as CFDictionary)
        var item = query(name)
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    func keychainGet(_ name: String) -> Data? {
        var q = query(name)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    func keychainDelete(_ name: String) { SecItemDelete(query(name) as CFDictionary) }

    // MARK: Privacy shield (app switcher snapshot, Control Center, incoming call)

    func showShield(in window: UIWindow?) {
        guard shieldEnabled, shieldView == nil, let window = window else { return }
        let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemThickMaterial))
        blur.frame = window.bounds
        blur.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        let label = UILabel()
        label.text = "ModelLink"
        label.font = .systemFont(ofSize: 22, weight: .bold)
        label.textColor = .secondaryLabel
        label.translatesAutoresizingMaskIntoConstraints = false
        blur.contentView.addSubview(label)
        NSLayoutConstraint.activate([label.centerXAnchor.constraint(equalTo: blur.contentView.centerXAnchor),
                                     label.centerYAnchor.constraint(equalTo: blur.contentView.centerYAnchor)])
        window.addSubview(blur)
        shieldView = blur
    }

    func hideShield() { shieldView?.removeFromSuperview(); shieldView = nil }

    // MARK: Face-down panic gesture

    func setPanicMotion(_ on: Bool) {
        if !on { motion.stopDeviceMotionUpdates(); faceDownSince = nil; return }
        guard motion.isDeviceMotionAvailable, !motion.isDeviceMotionActive else { return }
        motion.deviceMotionUpdateInterval = 0.15
        motion.startDeviceMotionUpdates(to: .main) { [weak self] data, _ in
            guard let self = self, let g = data?.gravity else { return }
            if g.z > 0.85 { // screen facing the table
                if self.faceDownSince == nil { self.faceDownSince = Date() }
                if let since = self.faceDownSince, Date().timeIntervalSince(since) > 0.35 {
                    self.faceDownSince = .distantFuture
                    NotificationCenter.default.post(name: Self.panic, object: nil)
                }
            } else if g.z < 0.5 { self.faceDownSince = nil }
        }
    }

    // MARK: Temporary files

    /// Removes staging, export and system temp folders. Returns the number of removed items.
    func wipeTemporaryFiles() -> Int {
        let fm = FileManager.default
        var removed = 0
        var folders: [URL] = [fm.temporaryDirectory]
        if let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask).first { folders.append(caches.appendingPathComponent("ModelLinkExportQueue")) }
        if let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            folders.append(support.appendingPathComponent("ModelLink/ImportedFiles"))
            folders.append(support.appendingPathComponent("ModelLink/Inbox"))
        }
        if let docs = fm.urls(for: .documentDirectory, in: .userDomainMask).first { folders.append(docs.appendingPathComponent("Inbox")) }
        for folder in folders {
            guard let items = try? fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) else { continue }
            for item in items where (try? fm.removeItem(at: item)) != nil { removed += 1 }
        }
        URLCache.shared.removeAllCachedResponses()
        return removed
    }
}

/// Full-screen camera view that returns the first QR code it sees.
final class ModelLinkQRScanner: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var completion: ((String?) -> Void)?
    private let session = AVCaptureSession()
    private var finished = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
            finish(nil); return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { finish(nil); return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.layer.bounds
        view.layer.addSublayer(preview)

        let hint = UILabel()
        hint.text = "Наведите камеру на QR-код ModelLink"
        hint.textColor = .white
        hint.font = .systemFont(ofSize: 16, weight: .semibold)
        hint.textAlignment = .center
        hint.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hint)
        let close = UIButton(type: .system)
        close.setTitle("Отмена", for: .normal)
        close.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        close.tintColor = .white
        close.translatesAutoresizingMaskIntoConstraints = false
        close.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        view.addSubview(close)
        NSLayoutConstraint.activate([
            hint.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            hint.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
            close.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            close.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24)
        ])
        DispatchQueue.global(qos: .userInitiated).async { self.session.startRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        view.layer.sublayers?.compactMap { $0 as? AVCaptureVideoPreviewLayer }.forEach { $0.frame = view.layer.bounds }
    }

    @objc private func cancelTapped() { finish(nil) }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let code = metadataObjects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        finish(code)
    }

    private func finish(_ text: String?) {
        guard !finished else { return }
        finished = true
        session.stopRunning()
        let done = completion
        completion = nil
        if presentingViewController != nil { dismiss(animated: true) { done?(text) } } else { done?(text) }
    }
}
