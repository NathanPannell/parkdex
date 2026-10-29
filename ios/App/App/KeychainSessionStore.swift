import Foundation
import Security

/// The signed-in Parkdex session, kept in the Keychain for this device only.
///
/// iOS keeps Keychain items when the app is deleted, but Android drops its Keystore session with the
/// app. A marker in UserDefaults, which iOS does delete with the app, tells a fresh install apart:
/// without it any leftover session is removed, so a reinstall starts signed out as on Android.
struct KeychainSessionStore {
    struct Session {
        let token: String
        /// Unix epoch time in milliseconds.
        let expiresAt: Int64
        let apiOrigin: String
    }

    enum StoreError: Error {
        case invalid
        case keychain(OSStatus)
    }

    private static let service = "app.parkdex.account-session"
    private static let account = "native-session"
    private static let installMarker = "parkdex.native-session.installed"
    private static let maxTokenBytes = 4096
    private static let maxOriginBytes = 512

    static func isValidApiOrigin(_ value: String) -> Bool {
        guard !value.isEmpty, value.utf8.count <= maxOriginBytes,
              let components = URLComponents(string: value),
              components.scheme == "https", let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil, components.port == nil,
              components.path.isEmpty, components.query == nil, components.fragment == nil
        else { return false }
        return value == "https://" + host.lowercased()
    }

    func write(token: String, expiresAt: Int64, apiOrigin: String) throws {
        guard !token.isEmpty, token == token.trimmingCharacters(in: .whitespacesAndNewlines),
              token.utf8.count <= Self.maxTokenBytes, Self.isValidApiOrigin(apiOrigin),
              expiresAt > Self.nowMillis()
        else { throw StoreError.invalid }
        let payload: [String: Any] = ["token": token, "expiresAt": expiresAt, "apiOrigin": apiOrigin]
        let data = try JSONSerialization.data(withJSONObject: payload)
        try clear()
        var item = Self.baseQuery()
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw StoreError.keychain(status) }
        UserDefaults.standard.set(true, forKey: Self.installMarker)
    }

    /// Nil when there is no session. A malformed item is removed and reads as no session.
    func read() throws -> Session? {
        if !UserDefaults.standard.bool(forKey: Self.installMarker) {
            // A fresh install (or a restore onto another device) never inherits a session.
            try clear()
            UserDefaults.standard.set(true, forKey: Self.installMarker)
            return nil
        }
        var query = Self.baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw StoreError.keychain(status) }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = object["token"] as? String, !token.isEmpty,
              let expiry = (object["expiresAt"] as? NSNumber)?.int64Value,
              let apiOrigin = object["apiOrigin"] as? String, Self.isValidApiOrigin(apiOrigin)
        else {
            try clear()
            return nil
        }
        return Session(token: token, expiresAt: expiry, apiOrigin: apiOrigin)
    }

    func clear() throws {
        let status = SecItemDelete(Self.baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw StoreError.keychain(status) }
    }

    static func nowMillis() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }

    private static func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
