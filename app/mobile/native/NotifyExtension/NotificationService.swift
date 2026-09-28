// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
//
//  NotificationService.swift
//  NotifyExtension
//
//  Notification Service Extension が APNs のカスタムペイロード `e`
//  (base64url でエンコードされた AES-256-GCM 暗号文) を復号し、
//  通知の title / body を実際の内容へ差し替える。
//  復号鍵はメインアプリが共有 Keychain に保存した 32 バイト鍵 (hex 文字列)。
//  復号できたら、ウィジェットの要約（App Group。WidgetShared.swift の WidgetStore）の要対応も書き換える。

import UserNotifications
import CryptoKit
import Foundation

final class NotificationService: UNNotificationServiceExtension {

	private var contentHandler: ((UNNotificationContent) -> Void)?
	private var bestAttemptContent: UNMutableNotificationContent?
	/// contentHandler を一度だけ呼ぶための印。通知センターの問い合わせの返事と期限切れ
	/// （serviceExtensionTimeWillExpire）は別のスレッドから来うるので、鍵で守る。
	private let deliverLock = NSLock()
	private var delivered = false
	/// 復号した識別子を userInfo へ書き終えたか。期限切れで出すとき、書き終えていなければ
	/// 生ペイロードの識別子（リレーが差し込めるもの）を剥がしてから出す。
	private var wroteDecryptedIds = false

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
			deliver(request.content)
			return
		}

		// フォールバック: 何が起きても届いた固定文のまま返す。
		// 復号できなかったのに APNs の生ペイロードに識別子が載っていたら、それはリレーが差し込んだもの。
		// アプリはタップの遷移と通知センターの後始末で userInfo の識別子を読むので、ここで捨てる。
		func deliverFallback() {
			Self.stripAppReadKeys(bestAttempt)
			deliver(bestAttempt)
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
		// APNs の生ペイロードに載っていた識別子（送信元を含む）は必ず捨てる。そこはリレーが差し込めるため、
		// 採用してよいのは封緘を開けて得たもの（鍵の名前・復号できた本文）だけ。
		for key in Self.appReadKeys {
			userInfo.removeValue(forKey: key)
		}
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
		// 通知ID: PCが「処理済み」と知らせてきたとき、アプリが通知センターから消す手がかり
		// （app/mobile/src/notificationTray.ts）。
		if let notifyId = json["id"] as? String, !notifyId.isEmpty {
			userInfo["notifyId"] = notifyId
		}
		// 同じエージェントの通知は1件に置き換え、同じPC・スペースの通知はまとめる（W2-08）。
		// 鍵は端末の中で作るだけで、リレーやAPNsへは出ない。
		let keyPcId = (userInfo["pcId"] as? String) ?? ""
		let collapse = Self.collapseKey(pcId: keyPcId, kind: json["kind"] as? String, agentToken: json["agentToken"] as? String, terminalKey: json["terminalKey"] as? String)
		if let collapse = collapse {
			userInfo["collapse"] = collapse
		}
		bestAttempt.threadIdentifier = Self.threadKey(pcId: keyPcId, ws: json["ws"] as? String)
		// userInfo の書き換えと印は同じ鍵の区間で行う。期限切れの側がその間に割り込んで、
		// 書きかけの userInfo を剥がしたり、書いた後に剥がしたりしないように。
		deliverLock.lock()
		if !delivered {
			bestAttempt.userInfo = userInfo
			wroteDecryptedIds = true
		}
		deliverLock.unlock()

		// ホーム画面・ロック画面のウィジェットの要約（App Group）の要対応を書き換えて描き直させる
		// （アプリが閉じている間にウィジェットを新しくできる唯一の経路）。要約がまだ無い・App Group が
		// 使えないときは何もしない。通知の表示はこの成否に関わらず行う。
		// 書き換える PC は鍵の項目名から分かったものだけにする。封緘の中で PC が名乗った pcId は、ペアリング済みの
		// PC 同士なら騙れるので、別の PC の行を書き換えさせない（分からなければ要約はそのまま）。
		if let widgetPcId = opened.pcId, !widgetPcId.isEmpty {
			WidgetStore.applyNotification(json, pcId: widgetPcId)
		}

		// PC が片付いたと知らせてきた通知（W2-27）。印は通知 ID を「この PC との鍵」で HMAC にしたもので、
		// 別の PC の通知には一致しない。PC が片付いたと知っているもの（スマホで開いた、PC で確認済みにした
		// エージェントの確認より前の通知）だけが載る。
		let dismissTags = Self.dismissTags(json["dismiss"])
		guard collapse != nil || !dismissTags.isEmpty else {
			deliver(bestAttempt)
			return
		}
		let idKey = Self.pushIdKey(opened.key)
		// 同じエージェントの前の通知（プッシュ・アプリが出したローカル通知の両方）と、片付いた通知を消してから出す。
		// 消せなくても通知は必ず出す（取得が返ってこない場合は serviceExtensionTimeWillExpire が出す）。
		let center = UNUserNotificationCenter.current()
		center.getDeliveredNotifications { [weak self] deliveredNotifications in
			let previous = deliveredNotifications
				.filter { notification in
					let info = notification.request.content.userInfo
					if let collapse = collapse, (info["collapse"] as? String) == collapse {
						return true
					}
					guard !dismissTags.isEmpty, let notifyId = Self.notifyId(of: info) else {
						return false
					}
					return dismissTags.contains(Self.dismissTag(idKey: idKey, notifyId: notifyId))
				}
				.map { $0.request.identifier }
			if !previous.isEmpty {
				center.removeDeliveredNotifications(withIdentifiers: previous)
			}
			self?.deliver(bestAttempt)
		}
	}

	override func serviceExtensionTimeWillExpire() {
		// 復号が間に合わなかった場合は現時点の内容で出す。復号した識別子を書き終えていなければ、
		// 生ペイロードの識別子は剥がす（フォールバックと同じ扱い）。
		guard let bestAttemptContent = bestAttemptContent else {
			return
		}
		deliverLock.lock()
		if !wroteDecryptedIds && !delivered {
			Self.stripAppReadKeys(bestAttemptContent)
		}
		deliverLock.unlock()
		deliver(bestAttemptContent)
	}

	/// contentHandler を一度だけ呼ぶ（2回目以降は何もしない）。
	private func deliver(_ content: UNNotificationContent) {
		deliverLock.lock()
		let first = !delivered
		delivered = true
		let handler = contentHandler
		deliverLock.unlock()
		if first {
			handler?(content)
		}
	}

	/// APNs の生ペイロードに載っていたアプリ向けの識別子を捨てる（リレーが差し込めるため）。
	private static func stripAppReadKeys(_ content: UNMutableNotificationContent) {
		var userInfo = content.userInfo
		for key in appReadKeys {
			userInfo.removeValue(forKey: key)
		}
		content.userInfo = userInfo
	}

	/// アプリが userInfo から読む識別子（app/mobile/src/notificationTray.ts の readTrayData と、
	/// notificationNavigation.ts の readNotificationDeepLink）。復号できたときだけ、ここで書く。
	private static let appReadKeys = ["pcId", "ws", "terminalId", "terminalKey", "agentToken", "windowId", "kind", "notifyId", "collapse"]

	// MARK: - Collapse / thread keys

	/// 同じエージェントの通知を置き換える鍵。**`app/mobile/src/notificationTray.ts` の
	/// `notifyCollapseKey` と同じ規則**（SHA-256 の16進先頭32桁）。変えるときは両方直すこと。
	/// 同じ入力で両者が一致することは notificationTray.test.ts の値で固定している。
	/// 許可・質問（agent-question）は置き換えない。未回答の許可が次の通知の下に隠れると気づけないため
	/// （PC も許可・質問のプッシュには apns-collapse-id を付けない。リレーはその代わりに通知ごとの乱数を
	/// 付けるが、これは同じ通知の再送どうしを1件にするだけで、別の通知を置き換えない）。
	private static func collapseKey(pcId: String, kind: String?, agentToken: String?, terminalKey: String?) -> String? {
		if kind == "agent-question" {
			return nil
		}
		let subject: String
		if let token = agentToken, !token.isEmpty {
			subject = "a:\(token)"
		} else if let key = terminalKey, !key.isEmpty {
			subject = "t:\(key)"
		} else {
			return nil
		}
		return hashKey("para.notify.collapse\n\(pcId)\n\(subject)")
	}

	/// 通知センターでまとめる単位（PC × スペース）。アプリのローカル通知は expo が
	/// threadIdentifier を渡せないので、まとまるのはプッシュで届いたものだけ。
	private static func threadKey(pcId: String, ws: String?) -> String {
		return hashKey("para.notify.thread\n\(pcId)\n\(ws ?? "")")
	}

	private static func hashKey(_ input: String) -> String {
		let digest = SHA256.hash(data: Data(input.utf8))
		return String(digest.map { String(format: "%02x", $0) }.joined().prefix(32))
	}

	// MARK: - Dismiss tags (W2-27)

	/// 1回のプッシュで受け付ける印の数の上限（PC は10件まで送る。多すぎるものは切る）。
	private static let maxDismissTags = 32

	/// 本文の `dismiss`（32桁の16進の配列）を読む。形の合わないものは捨てる。
	private static func dismissTags(_ raw: Any?) -> Set<String> {
		guard let values = raw as? [Any] else {
			return []
		}
		var tags = Set<String>()
		for value in values.prefix(maxDismissTags) {
			if let tag = value as? String, tag.count == 32, tag.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) {
				tags.insert(tag)
			}
		}
		return tags
	}

	/// 通知センターの通知の通知 ID。プッシュは userInfo の最上位（この拡張が書く）、アプリが出した
	/// ローカル通知は expo が userInfo["body"] に入れた data の中にある。
	private static func notifyId(of info: [AnyHashable: Any]) -> String? {
		if let id = info["notifyId"] as? String, !id.isEmpty {
			return id
		}
		if let body = info["body"] as? [String: Any], let id = body["notifyId"] as? String, !id.isEmpty {
			return id
		}
		return nil
	}

	/// 印を作るための用途別の鍵。**PC の `paradisMobilePushIds.ts` の `pushIdHasher` と同じ規則**
	/// （HMAC-SHA256(通知鍵, "paradis-push-id-v1")）。
	private static func pushIdKey(_ notifyKey: SymmetricKey) -> SymmetricKey {
		let mac = HMAC<SHA256>.authenticationCode(for: Data("paradis-push-id-v1".utf8), using: notifyKey)
		return SymmetricKey(data: Data(mac))
	}

	/// 通知 ID の印（HMAC-SHA256(用途別の鍵, "dismiss\0" + 通知 ID) の16進先頭32桁）。
	/// 値は PC の `paradisMobilePushIds.test.ts` で固定している（鍵が全バイト 1 のとき "n1" → f6bbbd12fc1fd39b8cddf0d5c0f1f5df）。
	private static func dismissTag(idKey: SymmetricKey, notifyId: String) -> String {
		let mac = HMAC<SHA256>.authenticationCode(for: Data("dismiss\u{0}\(notifyId)".utf8), using: idKey)
		return String(Data(mac).map { String(format: "%02x", $0) }.joined().prefix(32))
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

	/// 保存されている鍵を順に試して復号する。復号できた鍵のPC識別子と、試した鍵の本数と、その鍵を一緒に返す
	/// （鍵は W2-27 の印の突き合わせに使う）。
	/// 本数は「何台のPCとペアリングしているか」として副題の組み立てに使う。
	private static func decryptWithAnyKey(combined: Data) -> (plaintext: Data, pcId: String?, keyCount: Int, key: SymmetricKey)? {
		guard let sealedBox = try? AES.GCM.SealedBox(combined: combined) else {
			return nil
		}
		let candidates = loadNotifyKeys()
		for candidate in candidates {
			if let plaintext = try? AES.GCM.open(sealedBox, using: candidate.key) {
				return (plaintext: plaintext, pcId: candidate.pcId, keyCount: candidates.count, key: candidate.key)
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
