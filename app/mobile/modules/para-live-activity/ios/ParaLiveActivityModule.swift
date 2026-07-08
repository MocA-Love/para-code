// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import ActivityKit
import ExpoModulesCore

/// ParaCodeActivityAttributes のアプリ本体側コピー。
/// ios/ParaCodeWidgets/ParaCodeActivityAttributes.swift と完全に同一定義を保つこと
/// （ActivityKit は型名でアクティビティをマッチングする。フィールド変更時は両方を揃える）。
struct ParaCodeActivityAttributes: ActivityAttributes {
	public struct ContentState: Codable, Hashable {
		var waitingCount: Int
		var runningCount: Int
		var agents: [AgentRow]
		var questionPreview: String?
	}

	public struct AgentRow: Codable, Hashable {
		var name: String
		var ws: String
		var status: String
	}

	var pcName: String
}

/**
 * JSからLive Activityを開始/更新/終了するExpoローカルモジュール。
 * 状態はJSON文字列で受けて ContentState へデコードする（Expoの型ブリッジを介さず
 * Widget側と同一のCodable定義を直接使うため）。
 */
public class ParaLiveActivityModule: Module {
	public func definition() -> ModuleDefinition {
		Name("ParaLiveActivity")

		Function("isSupported") { () -> Bool in
			if #available(iOS 16.2, *) {
				return ActivityAuthorizationInfo().areActivitiesEnabled
			}
			return false
		}

		AsyncFunction("startOrUpdate") { (pcName: String, stateJson: String) throws in
			guard #available(iOS 16.2, *) else {
				return
			}
			guard let data = stateJson.data(using: .utf8) else {
				throw ParaLiveActivityError.badState
			}
			let state = try JSONDecoder().decode(ParaCodeActivityAttributes.ContentState.self, from: data)
			let content = ActivityContent(state: state, staleDate: nil)
			if let activity = Activity<ParaCodeActivityAttributes>.activities.first {
				Task {
					await activity.update(content)
				}
			} else {
				let attributes = ParaCodeActivityAttributes(pcName: pcName)
				_ = try Activity.request(attributes: attributes, content: content, pushType: nil)
			}
		}

		AsyncFunction("end") { () in
			guard #available(iOS 16.2, *) else {
				return
			}
			for activity in Activity<ParaCodeActivityAttributes>.activities {
				Task {
					await activity.end(nil, dismissalPolicy: .immediate)
				}
			}
		}
	}
}

enum ParaLiveActivityError: Error {
	case badState
}
