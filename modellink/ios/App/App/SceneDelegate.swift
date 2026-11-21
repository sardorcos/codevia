import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = ModelLinkViewController()
        window?.makeKeyAndVisible()

        // Cold start from "Open in ModelLink": queue the files before the web layer asks for them.
        receiveFiles(connectionOptions.urlContexts)
        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        receiveFiles(URLContexts)
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    /// Files shared to ModelLink from Files, Mail, AirDrop or other apps arrive as file URLs.
    private func receiveFiles(_ contexts: Set<UIOpenURLContext>) {
        let files = contexts.map(\.url).filter(\.isFileURL)
        guard !files.isEmpty else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            var queued = 0
            for url in files {
                do {
                    try ModelLinkImportStore.shared.enqueueIncoming(url)
                    queued += 1
                } catch {
                    NSLog("ModelLink: could not receive \(url.lastPathComponent): \(error.localizedDescription)")
                }
            }
            if queued > 0 {
                DispatchQueue.main.async {
                    NotificationCenter.default.post(name: ModelLinkNativePlugin.inboxChanged, object: nil)
                }
            }
        }
    }
}
