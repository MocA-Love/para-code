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
			  let combined = Self.decodeBase64URL(cipherText) else {
			deliverFallback()
			return
		}

		// 鍵はペアリング相手のPCごとに違う。どのPCから届いた通知かはペイロードに書かれていないため、
		// 保存されている鍵を順に試す（AES-GCM の認証タグが合う鍵は1つだけ）。
		guard let opened = Self.decryptWithAnyKey(combined: combined),
			  let json = try? JSONSerialization.jsonObject(with: opened.plaintext) as? [String: Any] else {
			deliverFallback()
			return
		}

		if let title = json["title"] as? String {
			bestAttempt.title = title
		}
		if let body = json["body"] as? String {
			bestAttempt.body = body
		}

		// ディープリンクと対象検証に必要な識別子を userInfo へ残す。
		var userInfo = bestAttempt.userInfo
		// 送信元PCは「復号できた鍵」からしか決めない。APNs の生ペイロードに載っていた値は
		// リレーが差し込めるため、必ず捨ててから入れ直す。
		userInfo.removeValue(forKey: "pcId")
		if let ws = json["ws"] { userInfo["ws"] = ws }
		if let terminalId = json["terminalId"] { userInfo["terminalId"] = terminalId }
		if let terminalKey = json["terminalKey"] { userInfo["terminalKey"] = terminalKey }
		if let agentToken = json["agentToken"] { userInfo["agentToken"] = agentToken }
		if let windowId = json["windowId"] { userInfo["windowId"] = windowId }
		if let kind = json["kind"] { userInfo["kind"] = kind }
		// どのPCから届いたかは「復号できた鍵の名前」でしか分からない。アプリはこれを見て、
		// 通知をタップされたときにそのPCへ切り替える。
		if let pcId = opened.pcId { userInfo["pcId"] = pcId }
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

	/// 保存されている通知鍵を、対応するPC識別子と一緒に返す。
	/// アカウント名は `notifyKey`（単一PC時代）または `notifyKey.<pcId>`（複数PC対応後）。
	private static func loadNotifyKeys() -> [(pcId: String?, key: SymmetricKey)] {
		var results: [(pcId: String?, key: SymmetricKey)] = []
		var seenAccounts = Set<String>()
		for service in keychainServices {
			for (account, hex) in readKeychainStrings(service: service) {
				guard !seenAccounts.contains(account),
					  let keyBytes = Self.dataFromHex(hex),
					  keyBytes.count == 32 else {
					continue
				}
				seenAccounts.insert(account)
				let pcId = account.hasPrefix("\(keychainAccount).")
					? String(account.dropFirst(keychainAccount.count + 1))
					: nil
				results.append((pcId: pcId, key: SymmetricKey(data: keyBytes)))
			}
		}
		return results
	}

	/// 指定 service の汎用パスワード項目を「アカウント名 → 値」で全件読む。
	/// アカウント名でPCを見分けるため、1件だけ取る検索ではなく全件を取る。
	private static func readKeychainStrings(service: String) -> [(account: String, value: String)] {
		let query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccessGroup as String: keychainAccessGroup,
			kSecReturnData as String: true,
			kSecReturnAttributes as String: true,
			kSecMatchLimit as String: kSecMatchLimitAll
		]
		var item: CFTypeRef?
		guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
			  let entries = item as? [[String: Any]] else {
			return []
		}
		return entries.compactMap { entry in
			guard let account = entry[kSecAttrAccount as String] as? String,
				  account == keychainAccount || account.hasPrefix("\(keychainAccount)."),
				  let data = entry[kSecValueData as String] as? Data,
				  let value = String(data: data, encoding: .utf8) else {
				return nil
			}
			return (account: account, value: value)
		}
	}

	/// 保存されている鍵を順に試して復号する。復号できた鍵のPC識別子も一緒に返す。
	private static func decryptWithAnyKey(combined: Data) -> (plaintext: Data, pcId: String?)? {
		guard let sealedBox = try? AES.GCM.SealedBox(combined: combined) else {
			return nil
		}
		for candidate in loadNotifyKeys() {
			if let plaintext = try? AES.GCM.open(sealedBox, using: candidate.key) {
				return (plaintext: plaintext, pcId: candidate.pcId)
			}
		}
		return nil
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

}
