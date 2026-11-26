import UIKit
import Capacitor

/// Root view controller: the standard Capacitor bridge plus the ModelLink native plugin.
@objc(ModelLinkViewController)
public final class ModelLinkViewController: CAPBridgeViewController {
    override public func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(ModelLinkNativePlugin())
    }
}
