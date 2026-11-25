import UIKit
import Capacitor

/// Root view controller: the stock Capacitor bridge plus the app's local plugins.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(CodeviaKeychainPlugin())
    }
}
