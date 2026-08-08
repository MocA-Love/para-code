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
		// タイトルの下の細い行。PCはエージェント種別までしか作れないので、2台以上と
		// ペアリングしているときにPC名を継ぎ足すのはこちらの役目
		// （app/mobile/src/notifyPresentation.ts と同じ規則。変えるときは両方直すこと）。
		if let subtitle = Self.composeSubtitle(
			json["subtitle"] as? String,
			pcName: json["pcName"] as? String,
			multiplePcs: opened.keyCount > 1
		) {
			bestAttempt.subtitle = subtitle
		}

		// ディープリンクと対象検証に必要な識別子を userInfo へ残す。
		var userInfo = bestAttempt.userInfo
		// APNs の生ペイロードに載っていた送信元は必ず捨てる。そこはリレーが差し込めるため、
		// 採用してよいのは封緘を開けて得たもの（鍵の名前・復号できた本文）だけ。
		userInfo.removeValue(forKey: "pcId")
		if let ws = json["ws"] { userInfo["ws"] = ws }
		if let terminalId = json["terminalId"] { userInfo["terminalId"] = terminalId }
		if let terminalKey = json["terminalKey"] { userInfo["terminalKey"] = terminalKey }
		if let agentToken = json["agentToken"] { userInfo["agentToken"] = agentToken }
		if let windowId = json["windowId"] { userInfo["windowId"] = windowId }
		if let kind = json["kind"] { userInfo["kind"] = kind }
		// アプリはこれを見て、通知をタップされたときにそのPCへ切り替える。
		// 第一の拠り所は「復号できた鍵の名前」。ただし鍵の項目名は保存側（expo-secure-store）が
		// Data として書くため読めるとは限らないので、読めなかったときは封緘の中でPCが名乗った値を使う。
		// そちらもリレーには触れないが、ペアリング済みのPC同士なら互いのIDを騙れるので鍵の名前を優先する。
		if let pcId = opened.pcId ?? (json["pcId"] as? String), !pcId.isEmpty {
			userInfo["pcId"] = pcId
		}
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
		// 同じ鍵は一度しか試さない。`:no-auth` 付きと素の service に同じ項目が居ることがあり、
		// 単一PC時代の `notifyKey` と `notifyKey.<pcId>` も移行の間は同じ値で並ぶため
		// （値で潰さないと、1台しか繋いでいないのに鍵が2本あることになってしまう）。
		// 突き合わせを**項目名ではなく値**で行うのは、項目名が読めないことがあるから（readKeychainEntries 参照）。
		var seenValues = Set<String>()
		// Keychainの返却順は決まっていないので、PC識別子が付いている方を先に取り込む。
		// 逆順だと、同じ値の単一PC時代の項目が先に居座って識別子を落としてしまう。
		let entries = keychainServices.flatMap { readKeychainEntries(service: $0) }
		for entry in entries.filter({ $0.pcId != nil }) + entries.filter({ $0.pcId == nil }) {
			guard !seenValues.contains(entry.value),
				  let keyBytes = Self.dataFromHex(entry.value),
				  keyBytes.count == 32 else {
				continue
			}
			seenValues.insert(entry.value)
			results.append((pcId: entry.pcId, key: SymmetricKey(data: keyBytes)))
		}
		return results
	}

	/// 指定 service の汎用パスワード項目を「PC識別子（分かれば） → 値」で全件読む。
	/// どのPCの鍵かは項目名でしか分からないため、1件だけ取る検索ではなく全件を取る。
	private static func readKeychainEntries(service: String) -> [(pcId: String?, value: String)] {
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
			guard let data = entry[kSecValueData as String] as? Data,
				  let value = String(data: data, encoding: .utf8) else {
				return nil
			}
			// 項目名は保存側（expo-secure-store）が **Data** として書き込むため、String として
			// 読み返せる保証がない。読めたときだけ絞り込みと送信元の判別に使い、読めなければ
			// 「鍵かもしれないもの」として試すだけにする（ここで捨てると本文が復号できなくなる）。
			guard let account = Self.accountString(entry[kSecAttrAccount as String]) else {
				return (pcId: nil, value: value)
			}
			let prefix = "\(keychainAccount)."
			if account == keychainAccount {
				return (pcId: nil, value: value)
			}
			guard account.hasPrefix(prefix) else {
				return nil
			}
			return (pcId: String(account.dropFirst(prefix.count)), value: value)
		}
	}

	/// Keychain が返す項目名を文字列にする。String でも Data でも受ける。
	private static func accountString(_ raw: Any?) -> String? {
		if let text = raw as? String {
			return text
		}
		if let data = raw as? Data {
			return String(data: data, encoding: .utf8)
		}
		return nil
	}

	/// 保存されている鍵を順に試して復号する。復号できた鍵のPC識別子と、試した鍵の本数を一緒に返す。
	/// 本数は「何台のPCとペアリングしているか」として副題の組み立てに使う。
	private static func decryptWithAnyKey(combined: Data) -> (plaintext: Data, pcId: String?, keyCount: Int)? {
		guard let sealedBox = try? AES.GCM.SealedBox(combined: combined) else {
			return nil
		}
		let candidates = loadNotifyKeys()
		for candidate in candidates {
			if let plaintext = try? AES.GCM.open(sealedBox, using: candidate.key) {
				return (plaintext: plaintext, pcId: candidate.pcId, keyCount: candidates.count)
			}
		}
		return nil
	}

	/// タイトルの下に出す一行を作る。組み立ての規則は `app/mobile/src/notifyPresentation.ts` と同じ。
	///
	/// ただし**材料の出どころは同じではない**。アプリは台帳（ペアリング済みPCの一覧と、ユーザーが
	/// 付け替えた名前）を見られるが、ここからは見えないので、鍵の本数を台数と見なし、名前はPCが
	/// 名乗ったものを使う。そのため次の食い違いが起きうる:
	///  - ペアリング解除に失敗して孤児になった鍵が残っていると、1台でもPC名が付く
	///  - 鍵をまだ保存できていないPCがあると、2台でもPC名が付かない
	///  - PC名をアプリ側で付け替えていると、プッシュだけ元の名前で出る
	/// どれも表示だけの差で、遷移先（pcId）は別に決めているため実害はない。
	private static func composeSubtitle(_ subtitle: String?, pcName: String?, multiplePcs: Bool) -> String? {
		var parts: [String] = []
		if let agent = clamp(subtitle), !agent.isEmpty {
			parts.append(agent)
		}
		if multiplePcs, let pc = clamp(pcName), !pc.isEmpty {
			parts.append(pc)
		}
		return parts.isEmpty ? nil : parts.joined(separator: " · ")
	}

	/// 前後の空白を落とし、長すぎるものは切る。上限はアプリ側の検証（decodeNotify）と同じ100文字。
	private static func clamp(_ value: String?) -> String? {
		guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) else {
			return nil
		}
		return trimmed.count <= 100 ? trimmed : String(trimmed.prefix(100))
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
