import UIKit
import Capacitor

/// Registers Parkdex's own native plugins, which live in the app target as they do on Android
/// (`NativeIdentityPlugin.java`, `NativeInstallInfoPlugin.java`, `WifiContentTransportPlugin.java`).
class ParkdexBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(NativeIdentityPlugin())
        bridge?.registerPluginInstance(NativeInstallInfoPlugin())
        bridge?.registerPluginInstance(WifiContentTransportPlugin())
    }
}
