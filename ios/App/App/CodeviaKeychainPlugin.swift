import Foundation
import Security
import Capacitor

/// Stores small secrets (the GitHub session) in the iOS Keychain.
/// Items are this-device-only, readable after first unlock, and never synced to iCloud.
/// JS: registerPlugin('CodeviaKeychain') in src/github/secure-store.ts.
@objc(CodeviaKeychainPlugin)
public class CodeviaKeychainPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CodeviaKeychainPlugin"
    public let jsName = "CodeviaKeychain"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    private let service = "com.codevia.pocket.github"

    private func baseQuery(_ key: String) -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrSynchronizable as String: false
        ]
    }

    /// Resolves { value } when the item exists, {} otherwise.
    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("Missing key")
            return
        }
        var query = baseQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            call.resolve([:])
            return
        }
        guard status == errSecSuccess, let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
            call.reject("Keychain read failed", String(status))
            return
        }
        call.resolve(["value": value])
    }

    /// Creates or replaces the item for `key`.
    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty, let value = call.getString("value") else {
            call.reject("Missing key or value")
            return
        }
        let query = baseQuery(key)
        let attributes: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]

        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            for (attribute, attributeValue) in attributes {
                item[attribute] = attributeValue
            }
            status = SecItemAdd(item as CFDictionary, nil)
        }
        if status == errSecSuccess {
            call.resolve()
        } else {
            call.reject("Keychain write failed", String(status))
        }
    }

    /// Deletes the item for `key`; succeeds when it does not exist.
    @objc func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("Missing key")
            return
        }
        let status = SecItemDelete(baseQuery(key) as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            call.resolve()
        } else {
            call.reject("Keychain delete failed", String(status))
        }
    }
}
