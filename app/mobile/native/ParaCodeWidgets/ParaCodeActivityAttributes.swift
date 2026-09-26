// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import ActivityKit
import Foundation

/// Para Code の Live Activity（案 D「状態で切り替え」）の静的属性と中身。
/// アプリ本体（modules/para-live-activity/ios/ParaLiveActivityModule.swift の同名コピー）と Widget Extension の
/// 両ターゲットに同一定義を置く（ActivityKit は型名でアクティビティをマッチングするため、
/// フィールドを変える場合は必ず両方と JS 側（modules/para-live-activity/index.ts・src/liveActivityState.ts）を揃えること）。
///
/// 時刻はすべて epoch ミリ秒の数値（Double）で持つ。Date の JSON 表現（基準日の違い）で取り違えないため
/// （段階 2 のプッシュでも PC が同じ数値をそのまま載せる）。
/// 読み込みは欠けた項目を既定値で補う（古い版の Live Activity や、段階 2 で項目を足したときに読めなくならないように）。
struct ParaCodeActivityAttributes: ActivityAttributes {
	public struct ContentState: Codable, Hashable {
		/// "attention"（要対応あり）/ "running"（実行中だけ）/ "done"（全部完了）/ "offline"（PC に繋がらない）。
		var phase: String
		/// 要対応（許可待ち・質問）の数。
		var waitingCount: Int
		/// 実行中の数。
		var runningCount: Int
		/// この Live Activity の間に終わって、まだ未確認の数。
		var doneCount: Int
		/// 要対応。古い順に最大 2 件（2 件目は「次」として名前だけ使う）。
		var attention: [AttentionItem]
		/// 実行中。最大 2 件。
		var running: [RunningItem]
		/// 終わったもの。新しい順に最大 3 件。
		var done: [DoneItem]
		/// PC 本体のバッテリー（旧 PC では未配信）。
		var battery: Battery?
		/// この中身を作った時刻（staleDate の起点、「◯時点」の表示）。
		var updatedAt: Double
		/// オフラインのとき、PC を最後に見た時刻。
		var asOf: Double?
		/// 完了の要約が消える時刻。
		var endsAt: Double?
	}

	public struct AttentionItem: Codable, Hashable {
		/// PC のターミナルの論理 ID（押したときの行き先）。
		var key: String
		/// スペースの ID。
		var space: String?
		/// 作業名（ターミナルの名前）。
		var name: String
		/// "permission"（許可待ち）/ "question"（質問）。
		var kind: String
		/// 今の状態になった時刻（分からなければ nil）。
		var since: Double?
		/// 許可待ちのツール名。
		var tool: String?
		/// 許可待ちのコマンド、または質問文。
		var detail: String?
	}

	public struct RunningItem: Codable, Hashable {
		var key: String
		var space: String?
		var name: String
		var since: Double?
		/// 最後のツールと、その対象。
		var tool: String?
		var target: String?
	}

	public struct DoneItem: Codable, Hashable {
		var key: String
		var space: String?
		var name: String
		/// 終わった時刻。
		var at: Double?
		/// かかった時間（ミリ秒）。
		var took: Double?
	}

	public struct Battery: Codable, Hashable {
		/// 残量（0〜100、PC側で5%刻みに量子化済み）。
		var level: Int
		/// 充電中か。
		var charging: Bool
	}

	/// 接続中の PC の ID（押したときの行き先）。
	var pcId: String
	/// 接続中の PC の名前（開始時に固定。変わったらアプリが作り直す）。
	var pcName: String
}

extension ParaCodeActivityAttributes {
	init(from decoder: Decoder) throws {
		let c = try decoder.container(keyedBy: CodingKeys.self)
		pcId = try c.decodeIfPresent(String.self, forKey: .pcId) ?? ""
		pcName = try c.decodeIfPresent(String.self, forKey: .pcName) ?? "PC"
	}
}

extension ParaCodeActivityAttributes.ContentState {
	init(from decoder: Decoder) throws {
		let c = try decoder.container(keyedBy: CodingKeys.self)
		phase = try c.decodeIfPresent(String.self, forKey: .phase) ?? "running"
		waitingCount = try c.decodeIfPresent(Int.self, forKey: .waitingCount) ?? 0
		runningCount = try c.decodeIfPresent(Int.self, forKey: .runningCount) ?? 0
		doneCount = try c.decodeIfPresent(Int.self, forKey: .doneCount) ?? 0
		attention = (try? c.decodeIfPresent([ParaCodeActivityAttributes.AttentionItem].self, forKey: .attention)) ?? []
		running = (try? c.decodeIfPresent([ParaCodeActivityAttributes.RunningItem].self, forKey: .running)) ?? []
		done = (try? c.decodeIfPresent([ParaCodeActivityAttributes.DoneItem].self, forKey: .done)) ?? []
		battery = try? c.decodeIfPresent(ParaCodeActivityAttributes.Battery.self, forKey: .battery)
		updatedAt = try c.decodeIfPresent(Double.self, forKey: .updatedAt) ?? 0
		asOf = try c.decodeIfPresent(Double.self, forKey: .asOf)
		endsAt = try c.decodeIfPresent(Double.self, forKey: .endsAt)
	}
}
