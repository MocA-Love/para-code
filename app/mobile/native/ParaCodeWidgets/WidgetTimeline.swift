// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
//
// ウィジェットのタイムライン。拡張は App Group の要約を読むだけで、PC やリレーには繋がない。
// 要約はアプリ（前面の間と背面へ移るとき）と通知拡張（通知を開けたとき）が書き、そのたびにリロードされる。
// タイムラインには 5 分おきの項目を 2 時間ぶん並べ、「◯分前の状態」と経過時間だけを進める
// （項目を並べるのは予算に数えない。実行中の経過は Text(date, style: .timer) で拡張を起こさずに進む）。

import SwiftUI
import WidgetKit

/// ウィジェットごとの設定を、描画に使う形へ解決したもの。
struct ParaWidgetConfig: Hashable {
	/// 選んだ PC（nil はアプリで見ている PC）。
	var pcId: String?
	/// 選んだスペース（nil は A・B なら「すべて」、D なら既定）。
	var space: SpaceSelection?
	/// 質問文とコマンドを出すか（nil はアプリの設定に従う）。
	var showDetail: Bool?
	/// B の並び（nil はアプリの設定に従う）。
	var agentsOrder: String?
	/// C の利用上限の対象（nil はアプリの設定に従う）。
	var limitTarget: String?

	struct SpaceSelection: Hashable {
		var pcId: String
		var spaceId: String
	}

	static let empty = ParaWidgetConfig()
}

struct ParaWidgetEntry: TimelineEntry {
	let date: Date
	let snapshot: WidgetSnapshot?
	let settings: WidgetAppSettings
	let config: ParaWidgetConfig
	/// ギャラリーやプレースホルダーの見本（架空のデータ）。
	let isSample: Bool
}

enum ParaWidgetTimeline {
	static let step: TimeInterval = 5 * 60
	static let count = 25

	static func entries(config: ParaWidgetConfig, now: Date = Date()) -> [ParaWidgetEntry] {
		let snapshot = WidgetStore.loadSnapshot()
		let settings = WidgetStore.loadSettings()
		return (0..<count).map { index in
			ParaWidgetEntry(date: now.addingTimeInterval(Double(index) * step), snapshot: snapshot, settings: settings, config: config, isSample: false)
		}
	}

	static func current(config: ParaWidgetConfig, context: TimelineProviderContext, now: Date = Date()) -> ParaWidgetEntry {
		if context.isPreview {
			return sample(config: config, now: now)
		}
		return entries(config: config, now: now).first ?? sample(config: config, now: now)
	}

	static func sample(config: ParaWidgetConfig = .empty, now: Date = Date()) -> ParaWidgetEntry {
		return ParaWidgetEntry(date: now, snapshot: WidgetSamples.snapshot(now: now), settings: WidgetAppSettings(), config: config, isSample: true)
	}
}

// MARK: - 描画に使う材料の引き当て

struct ParaWidgetModel {
	let entry: ParaWidgetEntry
	let pc: WidgetPc?
	/// 表示の対象にしたスペース（A・B の絞り込み、D の対象）。
	let space: WidgetSpace?
	let paired: Bool
	/// アプリが一度も要約を書いていない。
	let noData: Bool

	var settings: WidgetAppSettings { entry.settings }
	var now: Date { entry.date }

	init(entry: ParaWidgetEntry, spaceMode: SpaceMode) {
		self.entry = entry
		guard let snapshot = entry.snapshot else {
			pc = nil
			space = nil
			paired = false
			noData = true
			return
		}
		noData = false
		paired = snapshot.paired && !snapshot.pcs.isEmpty
		var chosenPc: WidgetPc?
		var chosenSpace: WidgetSpace?
		if let selection = entry.config.space, let pc = snapshot.pc(selection.pcId) {
			// スペースを選んでいるなら、そのスペースの PC を使う。
			chosenPc = pc
			chosenSpace = pc.space(selection.spaceId)
		} else {
			chosenPc = snapshot.pc(entry.config.pcId) ?? snapshot.pc(snapshot.activePcId) ?? snapshot.pcs.first
		}
		if spaceMode == .pick, chosenSpace == nil {
			// D で既定のとき: アプリの設定のスペース → エージェントのいるスペース → 先頭のスペース。
			if let ref = entry.settings.space.defaultSpace, let pc = snapshot.pc(ref.pcId), let space = pc.space(ref.spaceId), entry.config.space == nil {
				chosenPc = pc
				chosenSpace = space
			} else if let pc = chosenPc {
				let withAgent = pc.agents.first { $0.spaceId != nil && pc.space($0.spaceId) != nil }
				chosenSpace = pc.space(withAgent?.spaceId) ?? pc.spaces.first
			}
		}
		pc = chosenPc
		space = chosenSpace
	}

	enum SpaceMode {
		/// A・B: 選んだときだけ絞る。
		case filter
		/// D: 必ず 1 つ選ぶ。
		case pick
	}

	var offline: Bool { !(pc?.online ?? false) }

	/// 絞り込んだあとのエージェント。
	var agents: [WidgetAgent] {
		guard let pc else { return [] }
		guard let space else { return pc.agents }
		return pc.agents.filter { $0.spaceId == space.id }
	}

	var showDetail: Bool { entry.config.showDetail ?? settings.showDetail }

	func title(_ agent: WidgetAgent) -> String {
		return settings.showNames ? agent.title : WidgetText.kindLabel(agent.kind)
	}

	func spaceName(_ space: WidgetSpace?) -> String {
		guard let space else { return "スペース" }
		return settings.showNames ? space.name : "スペース"
	}

	func spaceName(id: String?) -> String? {
		guard let id, let space = pc?.space(id) else { return nil }
		return spaceName(space)
	}

	var pcName: String { pc?.name ?? "PC" }

	func count(_ state: String) -> Int {
		return agents.filter { $0.state == state }.count
	}

	var attentionCount: Int {
		// 絞り込んでいなければ PC の件数（見ていない PC でも接続を保っていれば正しい）を使う。
		guard space == nil, let pc else { return agents.filter { $0.isAttention }.count }
		return max(pc.attention, pc.agents.filter { $0.isAttention }.count)
	}

	var freshness: String? { freshnessText(pc: pc, settings: settings, now: now) }

	func sessionURL(_ agent: WidgetAgent) -> URL {
		guard let pc else { return WidgetLink.attention }
		return WidgetLink.session(pc: pc.id, space: agent.spaceId, terminal: agent.key, at: now)
	}

	func elapsed(_ agent: WidgetAgent) -> String? {
		guard let since = agent.since else { return nil }
		return WidgetText.elapsedShort(since: since, now: now)
	}
}

// MARK: - 見本（ギャラリー・プレースホルダー。架空のデータ）

enum WidgetSamples {
	static func snapshot(now: Date) -> WidgetSnapshot {
		let ms = now.timeIntervalSince1970 * 1000
		let agents = [
			WidgetAgent(key: "s-auth", title: "認証フローの整理", kind: "claude", spaceId: "s1", state: "approve", since: ms - 3 * 60_000, detail: nil),
			WidgetAgent(key: "s-relay", title: "再接続のテスト", kind: "codex", spaceId: "s2", state: "question", since: ms - 60_000, detail: nil),
			WidgetAgent(key: "s-diff", title: "差分ビューの配色", kind: "claude", spaceId: "s1", state: "running", since: ms - 12 * 60_000, detail: nil),
			WidgetAgent(key: "s-readme", title: "README の更新", kind: "codex", spaceId: "s3", state: "unread", since: ms - 25 * 60_000, detail: nil),
		]
		let spaces = [
			WidgetSpace(id: "s1", name: "sample-app", branch: "feature/widgets", changes: 5,
						files: [WidgetSpaceFile(code: "A", path: "src/widgets/sync.ts"), WidgetSpaceFile(code: "M", path: "src/app.ts"), WidgetSpaceFile(code: "M", path: "README.md")],
						commits: [WidgetSpaceCommit(subject: "再接続の待ち時間を短くする", at: ms - 12 * 60_000), WidgetSpaceCommit(subject: "配色をそろえる", at: ms - 60 * 60_000)], scmAt: ms),
			WidgetSpace(id: "s2", name: "relay-retry", branch: "relay-retry", changes: 2, files: nil, commits: nil, scmAt: nil),
			WidgetSpace(id: "s3", name: "docs", branch: "docs", changes: 1, files: nil, commits: nil, scmAt: nil),
		]
		let pc = WidgetPc(
			id: "sample-pc", name: "MacBook Pro", online: true, lastSeenAt: ms, updatedAt: ms - 2 * 60_000, eventAt: nil,
			battery: WidgetBattery(level: 76, charging: false),
			resources: WidgetResources(cpu: 34, memPercent: 71, memTotal: 36 * 1_073_741_824, diskFree: 182 * 1_073_741_824, diskTotal: 1000 * 1_073_741_824),
			usage: WidgetUsage(todayCost: 4.12, costClaude: 3.05, costCodex: 1.07, limits: [
				WidgetLimit(key: "claude5h", label: "Claude 5時間", usedPercent: 62, resetsAt: ms + 80 * 60_000),
				WidgetLimit(key: "claudeWeek", label: "Claude 週", usedPercent: 38, resetsAt: ms + 3 * 24 * 60 * 60_000),
				WidgetLimit(key: "codex5h", label: "Codex 5時間", usedPercent: 21, resetsAt: ms + 125 * 60_000),
			], fetchedAt: ms - 9 * 60_000),
			attention: 2, agents: agents, spaces: spaces
		)
		return WidgetSnapshot(v: WidgetSnapshot.version, writtenAt: ms, source: "app", paired: true, activePcId: pc.id, pcs: [pc])
	}
}
