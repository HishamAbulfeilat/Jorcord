import UIKit
import Capacitor

/// Capacitor only auto-registers plugins that come from npm packages; plugins that live in the app target are registered here.
/// Main.storyboard points at this class instead of CAPBridgeViewController.
class JorcordBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(JorcordScreenSharePlugin())
        bridge?.registerPluginInstance(JorcordCallKitPlugin()) // UNVERIFIED: see docs/PLATFORMS.md
    }
}
