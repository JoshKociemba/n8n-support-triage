import Foundation
import Security

// Secrets enter through stdin and leave through a captured pipe, never argv.
let service = "com.raeltek.n8n-support-triage"
func fail(_ message: String, _ code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}
let input = FileHandle.standardInput.readDataToEndOfFile()
guard let request = try? JSONSerialization.jsonObject(with: input) as? [String: String],
      let operation = request["operation"], let account = request["account"],
      account.range(of: "^[A-Z][A-Z0-9_]*$", options: .regularExpression) != nil else {
    fail("Invalid Keychain request.")
}
let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service, kSecAttrAccount as String: account]
if operation == "get" {
    var lookup = query
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &result)
    if status == errSecItemNotFound { exit(44) }
    guard status == errSecSuccess, let data = result as? Data else {
        fail("Keychain read failed (OSStatus \(status)).")
    }
    FileHandle.standardOutput.write(data)
} else if operation == "set" {
    guard let value = request["value"], !value.isEmpty else { fail("Empty secret rejected.") }
    let data = Data(value.utf8)
    var add = query
    add[kSecValueData as String] = data
    add[kSecAttrLabel as String] = "n8n support triage: " + account
    let status = SecItemAdd(add as CFDictionary, nil)
    if status == errSecDuplicateItem {
        let updated = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        guard updated == errSecSuccess else { fail("Keychain update failed (OSStatus \(updated)).") }
    } else if status != errSecSuccess { fail("Keychain write failed (OSStatus \(status)).") }
} else { fail("Unsupported Keychain operation.") }
