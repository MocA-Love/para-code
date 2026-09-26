// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
//
// ホーム画面・ロック画面のウィジェットと通知拡張（NotifyExtension）が共有する、App Group の要約ファイルの
// 形と読み書き。このファイルは ParaCodeWidgets と NotifyExtension の両方のターゲットに入っている
// （SwiftUI を使わない。通知拡張でも読めるように Foundation だけで書く）。
//
// 形は JS 側（app/mobile/src/widgets/snapshot.ts・settings.ts）と一致させること。
// アプリ本体からの書き込みは modules/para-live-activity/ios/ParaLiveActivityModule.swift の ParaWidgetFiles。

import Foundation
#if canImport(WidgetKit)
import WidgetKit
#endif

enum WidgetFiles {
	static let appGroup = "group.ltd.paradis.paracode.mobile"
	static let snapshot = "widget-snapshot.json"
	static let settings = "widget-settings.json"
	static let outbox = "widget-outbox.json"

	static func url(_ name: String) -> URL? {
		return FileManager.default
			.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
			.appendingPathComponent(name, isDirectory: false)
	}
}

/// ウィジェットの種類（JS の WIDGET_KINDS と一致させる）。
enum WidgetKinds {
	static let attention = "ParaCodeAttention"
	static let agents = "ParaCodeAgents"
	static let pcStatus = "ParaCodePcStatus"
	static let space = "ParaCodeSpace"
}

// MARK: - 要約（スナップショット）

struct WidgetBattery: Codable, Hashable {
	var level: Int
	var charging: Bool
}

struct WidgetResources: Codable, Hashable {
	var cpu: Double?
	var memPercent: Double?
	var memTotal: Double?
	var diskFree: Double?
	var diskTotal: Double?
}

struct WidgetLimit: Codable, Hashable {
	var key: String
	var label: String
	var usedPercent: Double
	var resetsAt: Double?
}

struct WidgetUsage: Codable, Hashable {
	var todayCost: Double?
	var costClaude: Double?
	var costCodex: Double?
	var limits: [WidgetLimit]
	var fetchedAt: Double
}

struct WidgetAgent: Codable, Hashable, Identifiable {
	var key: String
	var title: String
	var kind: String
	var spaceId: String?
	var state: String
	var since: Double?
	var detail: String?

	var id: String { key }
	var isAttention: Bool { state == "approve" || state == "question" }
}

struct WidgetSpaceFile: Codable, Hashable {
	var code: String
	var path: String
}

struct WidgetSpaceCommit: Codable, Hashable {
	var subject: String
	var at: Double?
}

struct WidgetSpace: Codable, Hashable, Identifiable {
	var id: String
	var name: String
	var branch: String?
	var changes: Int?
	var files: [WidgetSpaceFile]?
	var commits: [WidgetSpaceCommit]?
	var scmAt: Double?
}

struct WidgetPc: Codable, Hashable, Identifiable {
	var id: String
	var name: String
	var online: Bool
	var lastSeenAt: Double?
	var updatedAt: Double?
	var eventAt: Double?
	var battery: WidgetBattery?
	var resources: WidgetResources?
	var usage: WidgetUsage?
	var attention: Int
	var agents: [WidgetAgent]
	var spaces: [WidgetSpace]

	/// 「◯分前の状態」の元になる時刻（アプリが取った時刻と、通知拡張が書き換えた時刻の新しい方）。
	var freshAt: Double? {
		switch (updatedAt, eventAt) {
		case let (a?, b?): return max(a, b)
		case let (a?, nil): return a
		case let (nil, b?): return b
		default: return lastSeenAt
		}
	}

	func space(_ id: String?) -> WidgetSpace? {
		guard let id else { return nil }
		return spaces.first { $0.id == id }
	}
}

struct WidgetSnapshot: Codable, Hashable {
	static let version = 1
	var v: Int
	var writtenAt: Double
	var source: String
	var paired: Bool
	var activePcId: String?
	var pcs: [WidgetPc]

	func pc(_ id: String?) -> WidgetPc? {
		guard let id else { return nil }
		return pcs.first { $0.id == id }
	}
}

struct WidgetOutboxEntry: Codable, Hashable {
	var t: String
	var pcId: String
	var key: String
	var at: Double
	/// 押した時点の「未確認の始まり」（要約の agent.since）。アプリはこれと同じか前に始まった未確認だけを
	/// 確認済みにする（押した後に終わった別の完了まで確認済みにしない）。分からなければ無し（アプリは送らない）。
	var since: Double?
}

struct WidgetOutbox: Codable {
	var v: Int
	var entries: [WidgetOutboxEntry]
}

// MARK: - アプリ内の設定（設定 → ウィジェット）

/// 足りない項目は既定で埋めて読む（古いアプリが書いた設定でも読めるように）。既定は JS の DEFAULT_WIDGET_SETTINGS と同じ。
struct WidgetAppSettings: Decodable, Hashable {
	struct Attention: Decodable, Hashable {
		var order = "oldest"
		var showApprove = true
		var showAnswer = true
		var showReview = true

		init() {}
		init(from decoder: Decoder) throws {
			let c = try decoder.container(keyedBy: CodingKeys.self)
			order = (try? c.decodeIfPresent(String.self, forKey: .order)) ?? order
			showApprove = (try? c.decodeIfPresent(Bool.self, forKey: .showApprove)) ?? showApprove
			showAnswer = (try? c.decodeIfPresent(Bool.self, forKey: .showAnswer)) ?? showAnswer
			showReview = (try? c.decodeIfPresent(Bool.self, forKey: .showReview)) ?? showReview
		}
		enum CodingKeys: String, CodingKey { case order, showApprove, showAnswer, showReview }
	}

	struct Agents: Decodable, Hashable {
		var states = ["attention", "running", "unread", "idle"]
		var order = "attention"
		var limit = 8

		init() {}
		init(from decoder: Decoder) throws {
			let c = try decoder.container(keyedBy: CodingKeys.self)
			states = (try? c.decodeIfPresent([String].self, forKey: .states)) ?? states
			order = (try? c.decodeIfPresent(String.self, forKey: .order)) ?? order
			limit = min(8, max(3, (try? c.decodeIfPresent(Int.self, forKey: .limit)) ?? limit))
		}
		enum CodingKeys: String, CodingKey { case states, order, limit }
	}

	struct Pc: Decodable, Hashable {
		var metrics = ["battery", "cpu", "memory", "cost", "claude5h", "claudeWeek", "codex5h"]

		init() {}
		init(from decoder: Decoder) throws {
			let c = try decoder.container(keyedBy: CodingKeys.self)
			metrics = (try? c.decodeIfPresent([String].self, forKey: .metrics)) ?? metrics
		}
		enum CodingKeys: String, CodingKey { case metrics }
	}

	struct SpaceRef: Decodable, Hashable {
		var pcId: String
		var spaceId: String
	}

	struct Space: Decodable, Hashable {
		var defaultSpace: SpaceRef?
		var showAgents = true
		var showChanges = true
		var showCommits = true

		init() {}
		init(from decoder: Decoder) throws {
			let c = try decoder.container(keyedBy: CodingKeys.self)
			defaultSpace = try? c.decodeIfPresent(SpaceRef.self, forKey: .defaultSpace)
			showAgents = (try? c.decodeIfPresent(Bool.self, forKey: .showAgents)) ?? showAgents
			showChanges = (try? c.decodeIfPresent(Bool.self, forKey: .showChanges)) ?? showChanges
			showCommits = (try? c.decodeIfPresent(Bool.self, forKey: .showCommits)) ?? showCommits
		}
		enum CodingKeys: String, CodingKey { case defaultSpace, showAgents, showChanges, showCommits }
	}

	var accentHex: String?
	/// 主ボタンの上の文字の色。アプリがコントラスト比で決めて書く（無い古い設定は WidgetPalette が明るさで補う）。
	var accentTextHex: String?
	var showNames = true
	var showDetail = false
	var freshness = "always"
	var attention = Attention()
	var agents = Agents()
	var pc = Pc()
	var space = Space()

	init() {}

	init(from decoder: Decoder) throws {
		let c = try decoder.container(keyedBy: CodingKeys.self)
		accentHex = try? c.decodeIfPresent(String.self, forKey: .accentHex)
		accentTextHex = try? c.decodeIfPresent(String.self, forKey: .accentTextHex)
		showNames = (try? c.decodeIfPresent(Bool.self, forKey: .showNames)) ?? showNames
		showDetail = (try? c.decodeIfPresent(Bool.self, forKey: .showDetail)) ?? showDetail
		freshness = (try? c.decodeIfPresent(String.self, forKey: .freshness)) ?? freshness
		attention = (try? c.decodeIfPresent(Attention.self, forKey: .attention)) ?? attention
		agents = (try? c.decodeIfPresent(Agents.self, forKey: .agents)) ?? agents
		pc = (try? c.decodeIfPresent(Pc.self, forKey: .pc)) ?? pc
		space = (try? c.decodeIfPresent(Space.self, forKey: .space)) ?? space
	}

	enum CodingKeys: String, CodingKey {
		case accentHex, accentTextHex, showNames, showDetail, freshness, attention, agents, pc, space
	}
}

// MARK: - 読み書き

enum WidgetStore {
	static func readData(_ name: String) -> Data? {
		guard let url = WidgetFiles.url(name) else { return nil }
		var result: Data?
		var error: NSError?
		NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: url, options: [], error: &error) { readURL in
			result = try? Data(contentsOf: readURL)
		}
		return result
	}

	static func loadSnapshot() -> WidgetSnapshot? {
		guard let data = readData(WidgetFiles.snapshot),
			  let snapshot = try? JSONDecoder().decode(WidgetSnapshot.self, from: data),
			  snapshot.v == WidgetSnapshot.version else {
			return nil
		}
		return snapshot
	}

	static func loadSettings() -> WidgetAppSettings {
		guard let data = readData(WidgetFiles.settings),
			  let settings = try? JSONDecoder().decode(WidgetAppSettings.self, from: data) else {
			return WidgetAppSettings()
		}
		return settings
	}

	/// ファイルを読み・書き換え・書くを1回の協調の中で行う（アプリ・通知拡張・ウィジェットが同時に書いても壊さない）。
	/// `transform` が nil を返したら書かない。
	@discardableResult
	static func mutate<T: Codable>(_ name: String, as type: T.Type, transform: (T?) -> T?) -> Bool {
		guard let url = WidgetFiles.url(name) else { return false }
		var wrote = false
		var error: NSError?
		NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: url, options: .forMerging, error: &error) { fileURL in
			let current = (try? Data(contentsOf: fileURL)).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
			guard let next = transform(current), let data = try? JSONEncoder().encode(next) else {
				return
			}
			do {
				try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
				wrote = true
			} catch {
				wrote = false
			}
		}
		return wrote
	}

	/// ウィジェットの「確認済みにする」: 要約の表示を先に変え、アプリが PC へ送るための積み置きに足す。
	/// 積み置きには押した時点の未確認の始まり（agent.since）を入れる（要約を書き換える前に読む）。
	static func markReviewed(pcId: String, keys: [String], now: Date = Date()) {
		let at = (now.timeIntervalSince1970 * 1000).rounded()
		let targets = Set(keys)
		if targets.isEmpty { return }
		var sinceByKey: [String: Double] = [:]
		var unreadKeys = Set<String>()
		mutate(WidgetFiles.snapshot, as: WidgetSnapshot.self) { current in
			guard var snapshot = current, let index = snapshot.pcs.firstIndex(where: { $0.id == pcId }) else {
				return nil
			}
			for agentIndex in snapshot.pcs[index].agents.indices where targets.contains(snapshot.pcs[index].agents[agentIndex].key) && snapshot.pcs[index].agents[agentIndex].state == "unread" {
				let agent = snapshot.pcs[index].agents[agentIndex]
				unreadKeys.insert(agent.key)
				if let since = agent.since {
					sinceByKey[agent.key] = since
				}
				snapshot.pcs[index].agents[agentIndex].state = "idle"
				snapshot.pcs[index].agents[agentIndex].since = nil
			}
			snapshot.source = "widget"
			return snapshot
		}
		// 押した時点で未確認でなかったもの（もう要約に無い・別の状態）は積まない。
		if unreadKeys.isEmpty { return }
		mutate(WidgetFiles.outbox, as: WidgetOutbox.self) { current in
			var outbox = current ?? WidgetOutbox(v: 1, entries: [])
			for key in keys where unreadKeys.contains(key) {
				// 同じものを積み直すときは、押した時点の始まりで置き換える。
				outbox.entries.removeAll { $0.pcId == pcId && $0.key == key }
				outbox.entries.append(WidgetOutboxEntry(t: "dismiss", pcId: pcId, key: key, at: at, since: sinceByKey[key]))
			}
			// 押し続けても膨らまないよう、古いものから捨てる。
			if outbox.entries.count > 100 {
				outbox.entries.removeFirst(outbox.entries.count - 100)
			}
			return outbox
		}
	}

	/// 通知拡張が通知を開けたときに、要約の要対応の部分を書き換える（アプリが閉じている間の更新）。
	/// 要約がまだ無い（アプリが一度も書いていない）ときは何もしない。
	/// `pcId` は通知鍵の項目名から分かった PC だけを渡す（封緘の中で PC が名乗った値は使わない。
	/// ペアリング済みの PC 同士なら互いの ID を騙れるため）。分からなければ呼ばない。
	static func applyNotification(_ payload: [String: Any], pcId: String, now: Date = Date()) {
		guard let kind = payload["kind"] as? String else { return }
		let nowMs = (now.timeIntervalSince1970 * 1000).rounded()
		let at = (payload["at"] as? Double) ?? nowMs
		let terminalKey = payload["terminalKey"] as? String
		let ws = payload["ws"] as? String
		let subtitle = payload["subtitle"] as? String
		let body = payload["body"] as? String
		let showDetail = loadSettings().showDetail
		mutate(WidgetFiles.snapshot, as: WidgetSnapshot.self) { current in
			guard var snapshot = current, let index = snapshot.pcs.firstIndex(where: { $0.id == pcId }) else {
				return nil
			}
			var pc = snapshot.pcs[index]
			if kind == "disconnected" {
				pc.online = false
			} else if let terminalKey, !terminalKey.isEmpty {
				let nextState: String
				switch kind {
				case "agent-question": nextState = "question"
				case "agent-done": nextState = "unread"
				case "agent-error": nextState = "error"
				default: return nil
				}
				let detail = showDetail && kind == "agent-question" ? clamp(body, 120) : nil
				if let agentIndex = pc.agents.firstIndex(where: { $0.key == terminalKey }) {
					var agent = pc.agents[agentIndex]
					// 許可待ちの通知も agent-question で届く。許可待ちと分かっているものは許可待ちのままにする。
					let state = (nextState == "question" && agent.state == "approve") ? "approve" : nextState
					if agent.state != state {
						agent.since = at
					}
					agent.state = state
					agent.detail = detail ?? (state == "question" || state == "approve" ? agent.detail : nil)
					pc.agents[agentIndex] = agent
				} else {
					let kindName = (subtitle ?? "").lowercased()
					let agentKind = kindName.contains("claude") ? "claude" : kindName.contains("codex") ? "codex" : "agent"
					pc.agents.insert(WidgetAgent(
						key: terminalKey,
						title: clamp(subtitle, 40) ?? "エージェント",
						kind: agentKind,
						spaceId: ws,
						state: nextState,
						since: at,
						detail: detail
					), at: 0)
				}
				pc.attention = pc.agents.filter { $0.isAttention }.count
			} else {
				return nil
			}
			pc.eventAt = nowMs
			snapshot.pcs[index] = pc
			snapshot.source = "nse"
			return snapshot
		}
		reloadAll()
	}

	static func reloadAll() {
		#if canImport(WidgetKit)
		WidgetCenter.shared.reloadAllTimelines()
		#endif
	}

	static func clamp(_ text: String?, _ max: Int) -> String? {
		guard let text else { return nil }
		let line = text.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
		if line.isEmpty { return nil }
		return line.count > max ? String(line.prefix(max - 1)) + "…" : line
	}
}

// MARK: - リンク（アプリの src/features/links/widgetLinks.ts が今のルートへ書き換える。Live Activity も使う）

enum WidgetLink {
	private static let allowed: CharacterSet = {
		var set = CharacterSet.alphanumerics
		set.insert(charactersIn: "-._~")
		return set
	}()

	static func make(_ target: String, _ query: [(String, String?)] = []) -> URL {
		let items = query.compactMap { name, value -> String? in
			guard let value, !value.isEmpty else { return nil }
			let encoded = value.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
			return "\(name)=\(encoded)"
		}
		let suffix = items.isEmpty ? "" : "?" + items.joined(separator: "&")
		return URL(string: "paracode-mobile:///widget/\(target)\(suffix)") ?? URL(string: "paracode-mobile:///")!
	}

	static var attention: URL { make("attention") }
	static var home: URL { make("home") }
	static var pair: URL { make("pair") }
	static var settings: URL { make("settings") }

	static func pc(_ pcId: String) -> URL { make("pc", [("pc", pcId)]) }

	/// セッション（エージェントのタブ）。許可カード・質問はこの画面で答える。
	static func session(pc: String, space: String?, terminal: String?, at date: Date) -> URL {
		make("session", [
			("pc", pc),
			("space", space),
			("terminal", terminal),
			// 会話を最新まで送る一度限りの印（タイムラインの時刻ごとに変わる）。
			("latest", terminal != nil ? "w\(Int(date.timeIntervalSince1970 * 1000))" : nil),
		])
	}

	static func system(_ pcId: String) -> URL { make("system", [("pc", pcId)]) }
	static func sourceControl(pc: String, space: String) -> URL { make("source-control", [("pc", pc), ("space", space)]) }
	static func review(pc: String, space: String) -> URL { make("review", [("pc", pc), ("space", space)]) }
}
