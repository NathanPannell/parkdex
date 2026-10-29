import Capacitor
import Foundation

/// The installed package's identity, matching Android's `NativeInstallInfoPlugin.java`. The web layer
/// replays onboarding when it changes, so it must change on reinstall and update and nowhere else.
///
/// iOS has no package timestamps to read, so they are kept in UserDefaults, which iOS deletes with
/// the app: `firstInstallTime` is the first launch of this install, `lastUpdateTime` the first launch
/// of this build. `versionCode` is the build number the server's app config knows: the TestFlight
/// run number, the part of CFBundleVersion (`<run>.<attempt>`) before the dot.
@objc(NativeInstallInfoPlugin)
public class NativeInstallInfoPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeInstallInfoPlugin"
    public let jsName = "NativeInstallInfo"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getInstallInfo", returnType: CAPPluginReturnPromise),
    ]

    private static let firstInstallKey = "parkdex.install.first-launch"
    private static let lastUpdateKey = "parkdex.install.build-first-launch"
    private static let buildKey = "parkdex.install.build"

    @objc func getInstallInfo(_ call: CAPPluginCall) {
        guard let packageName = Bundle.main.bundleIdentifier,
              let bundleVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
              let versionCode = Self.buildNumber(bundleVersion)
        else {
            call.reject("The installed Parkdex package information is unavailable.")
            return
        }
        let defaults = UserDefaults.standard
        let now = Double(Int64(Date().timeIntervalSince1970 * 1000))
        var firstInstall = defaults.double(forKey: Self.firstInstallKey)
        if firstInstall <= 0 {
            firstInstall = now
            defaults.set(firstInstall, forKey: Self.firstInstallKey)
        }
        var lastUpdate = defaults.double(forKey: Self.lastUpdateKey)
        if lastUpdate <= 0 || defaults.string(forKey: Self.buildKey) != bundleVersion {
            lastUpdate = now
            defaults.set(lastUpdate, forKey: Self.lastUpdateKey)
            defaults.set(bundleVersion, forKey: Self.buildKey)
        }
        call.resolve([
            "packageName": packageName,
            "firstInstallTime": firstInstall,
            "lastUpdateTime": lastUpdate,
            "versionCode": versionCode,
        ])
    }

    static func buildNumber(_ bundleVersion: String) -> Int? {
        guard let head = bundleVersion.split(separator: ".").first, let build = Int(head), build >= 0 else { return nil }
        return build
    }
}
