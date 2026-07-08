// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import ActivityKit
import Foundation

/// Para Code Live Activity の状態（live.html 案L1「ステータス集約型」）。
/// アプリ本体（modules/para-live-activity 側の同名コピー）と Widget Extension の
/// 両ターゲットに同一定義を置く（ActivityKit は型名でアクティビティをマッチングするため、
/// フィールドを変える場合は必ず両方を揃えること）。
struct ParaCodeActivityAttributes: ActivityAttributes {
	public struct ContentState: Codable, Hashable {
		/// 応答待ち（質問・許可）のエージェント数。
		var waitingCount: Int
		/// 実行中のエージェント数。
		var runningCount: Int
		/// 表示するエージェント行（応答待ち優先で最大2件）。
		var agents: [AgentRow]
		/// 応答待ちが1件だけのときの質問文プレビュー（L2ハイブリッド）。
		var questionPreview: String?
	}

	public struct AgentRow: Codable, Hashable {
		/// 表示名（"Claude Code" / "Codex" / ターミナルタイトル）。
		var name: String
		/// ワークスペース名。
		var ws: String
		/// "waiting"（応答待ち・赤） or "running"（実行中・緑）。
		var status: String
	}

	/// 接続中のPC名（Activity開始時に固定される静的属性）。
	var pcName: String
}
