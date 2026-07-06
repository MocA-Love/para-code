// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
//
//  NotificationService.swift
//  NotifyExtension
//
//  Notification Service Extension が APNs のカスタムペイロード `e`
//  (base64url でエンコードされた AES-256-GCM 暗号文) を復号し、
//  通知の title / body を実際の内容へ差し替える。
//  復号鍵はメインアプリが共有 Keychain に保存した 32 バイト鍵 (hex 文字列)。

import UserNotifications
import CryptoKit
import Foundation

final class NotificationService: UNNotificationServiceExtension {

	private var contentHandler: ((UNNotificationContent) -> Void)?
	private var bestAttemptContent: UNMutableNotificationContent?

	// 共有 Keychain の座標。メインアプリ側の保存条件と一致させること。
	// expo-secure-store は requireAuthentication=false のとき kSecAttrService に
	// ":no-auth" サフィックスを付ける。まずそれを試し、無ければ素の service 名へフォールバックする。
	private static let keychainServices = ["paracode.notify:no-auth", "paracode.notify"]
	private static let keychainAccount = "notifyKey"
	private static let keychainAccessGroup = "WB4G82C384.ltd.paradis.paracode.mobile.shared"

	override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
		self.contentHandler = contentHandler
		self.bestAttemptContent = (request.content.mutableCopy() as? UNMutableNotificationContent)

		guard let bestAttempt = bestAttemptContent else {
			contentHandler(request.content)
			return
		}

		// フォールバック: 何が起きても届いた固定文のまま返す。
		func deliverFallback() {
			contentHandler(bestAttempt)
		}

		guard let cipherText = request.content.userInfo["e"] as? String,
			  let combined = Self.decodeBase64URL(cipherText),
			  let key = Self.loadNotifyKey() else {
			deliverFallback()
			return
		}

		guard let plaintext = Self.decrypt(combined: combined, key: key),
			  let json = try? JSONSerialization.jsonObject(with: plaintext) as? [String: Any] else {
			deliverFallback()
			return
		}

		if let title = json["title"] as? String {
			bestAttempt.title = title
		}
		if let body = json["body"] as? String {
			bestAttempt.body = body
		}

		// 将来のディープリンク用に ws / terminalId / kind を userInfo へ残す。
		var userInfo = bestAttempt.userInfo
		if let ws = json["ws"] { userInfo["ws"] = ws }
		if let terminalId = json["terminalId"] { userInfo["terminalId"] = terminalId }
		if let kind = json["kind"] { userInfo["kind"] = kind }
		bestAttempt.userInfo = userInfo

		contentHandler(bestAttempt)
	}

	override func serviceExtensionTimeWillExpire() {
		// 復号が間に合わなかった場合は現時点の内容をそのまま返す。
		if let contentHandler = contentHandler, let bestAttemptContent = bestAttemptContent {
			contentHandler(bestAttemptContent)
		}
	}

	// MARK: - Crypto

	/// base64url ("-" / "_" / パディング省略) を Data へデコードする。
	private static func decodeBase64URL(_ input: String) -> Data? {
		var s = input
			.replacingOccurrences(of: "-", with: "+")
			.replacingOccurrences(of: "_", with: "/")
		let remainder = s.count % 4
		if remainder > 0 {
			s.append(String(repeating: "=", count: 4 - remainder))
		}
		return Data(base64Encoded: s)
	}

	/// 共有 Keychain から通知鍵 (hex 文字列 64 桁) を読み、32 バイトの鍵へ変換する。
	/// expo-secure-store の service 名候補を順に試す。
	private static func loadNotifyKey() -> SymmetricKey? {
		for service in keychainServices {
			guard let hex = readKeychainString(service: service),
				  let keyBytes = Self.dataFromHex(hex),
				  keyBytes.count == 32 else {
				continue
			}
			return SymmetricKey(data: keyBytes)
		}
		return nil
	}

	/// 指定 service の汎用パスワード項目を UTF-8 文字列として読む。
	private static func readKeychainString(service: String) -> String? {
		let query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: keychainAccount,
			kSecAttrAccessGroup as String: keychainAccessGroup,
			kSecReturnData as String: true,
			kSecMatchLimit as String: kSecMatchLimitOne
		]
		var item: CFTypeRef?
		let status = SecItemCopyMatching(query as CFDictionary, &item)
		guard status == errSecSuccess,
			  let data = item as? Data,
			  let value = String(data: data, encoding: .utf8) else {
			return nil
		}
		return value
	}

	/// hex 文字列を Data へ変換する。桁数が奇数、または hex 以外を含む場合は nil。
	private static func dataFromHex(_ hex: String) -> Data? {
		let chars = Array(hex)
		guard chars.count % 2 == 0 else { return nil }
		var data = Data(capacity: chars.count / 2)
		var index = chars.startIndex
		while index < chars.endIndex {
			guard let hi = chars[index].hexDigitValue,
				  let lo = chars[chars.index(after: index)].hexDigitValue else {
				return nil
			}
			data.append(UInt8(hi << 4 | lo))
			index = chars.index(index, offsetBy: 2)
		}
		return data
	}

	/// CryptoKit の combined 形式 (12B ノンス || 暗号文 || 16B タグ) を復号する。
	private static func decrypt(combined: Data, key: SymmetricKey) -> Data? {
		guard let sealedBox = try? AES.GCM.SealedBox(combined: combined),
			  let plaintext = try? AES.GCM.open(sealedBox, using: key) else {
			return nil
		}
		return plaintext
	}
}
