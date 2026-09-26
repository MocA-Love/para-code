// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import ActivityKit
import ExpoModulesCore
import Foundation
import WidgetKit

/// ParaCodeActivityAttributes のアプリ本体側コピー。
/// ios/ParaCodeWidgets/ParaCodeActivityAttributes.swift と完全に同一定義を保つこと
/// （ActivityKit は型名でアクティビティをマッチングする。フィールド変更時は両方を揃える）。
struct ParaCodeActivityAttributes: ActivityAttributes {
	public struct ContentState: Codable, Hashable {
		var waitingCount: Int
		var runningCount: Int
		var agents: [AgentRow]
		var questionPreview: String?
		var battery: Battery?
	}

	public struct Battery: Codable, Hashable {
		var level: Int
		var charging: Bool
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

		// --- ホーム画面・ロック画面のウィジェット（App Group の要約ファイル） -----------------
		// 形の検証は JS（src/widgets/）とウィジェット側（WidgetShared.swift）が持つ。ここは
		// 決まった名前のファイルを読み書きするだけにする（任意のパスへ書かせない）。

		Function("widgetStoreAvailable") { () -> Bool in
			return ParaWidgetFiles.containerURL() != nil
		}

		AsyncFunction("writeWidgetFile") { (name: String, contents: String) throws in
			try ParaWidgetFiles.write(name: name, contents: contents)
		}

		AsyncFunction("readWidgetFile") { (name: String) throws -> String? in
			return try ParaWidgetFiles.read(name: name)
		}

		AsyncFunction("removeWidgetOutboxEntries") { (entriesJson: String) throws in
			try ParaWidgetFiles.removeOutboxEntries(entriesJson: entriesJson)
		}

		Function("reloadWidgets") { (kinds: [String]) in
			if kinds.isEmpty {
				WidgetCenter.shared.reloadAllTimelines()
			} else {
				for kind in kinds {
					WidgetCenter.shared.reloadTimelines(ofKind: kind)
				}
			}
		}
	}
}

/**
 * App Group（`group.ltd.paradis.paracode.mobile`）の中の、ウィジェットと受け渡すファイル。
 * ウィジェット・通知拡張の側は `ios/ParaCodeWidgets/WidgetShared.swift` の `WidgetStore` が同じ場所を読む。
 * 書き込みは NSFileCoordinator で順番を取り、ファイル保護は「最初のロック解除まで」にする
 * （ロック中にも通知拡張とウィジェットが読めるように。鍵と同じ AFTER_FIRST_UNLOCK の扱い）。
 */
enum ParaWidgetFiles {
	static let appGroup = "group.ltd.paradis.paracode.mobile"
	static let allowedNames: Set<String> = ["widget-snapshot.json", "widget-settings.json", "widget-outbox.json"]

	static func containerURL() -> URL? {
		return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
	}

	static func url(for name: String) throws -> URL {
		guard allowedNames.contains(name) else {
			throw ParaLiveActivityError.badWidgetFile
		}
		guard let container = containerURL() else {
			throw ParaLiveActivityError.noAppGroup
		}
		return container.appendingPathComponent(name, isDirectory: false)
	}

	static func write(name: String, contents: String) throws {
		let target = try url(for: name)
		guard let data = contents.data(using: .utf8) else {
			throw ParaLiveActivityError.badState
		}
		var coordinationError: NSError?
		var writeError: Error?
		NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: target, options: .forReplacing, error: &coordinationError) { url in
			do {
				try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
			} catch {
				writeError = error
			}
		}
		if let error = coordinationError ?? writeError {
			throw error
		}
	}

	static func read(name: String) throws -> String? {
		let target = try url(for: name)
		var coordinationError: NSError?
		var result: String?
		NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: target, options: [], error: &coordinationError) { url in
			if let data = try? Data(contentsOf: url) {
				result = String(data: data, encoding: .utf8)
			}
		}
		if let error = coordinationError, (error.domain != NSCocoaErrorDomain || error.code != NSFileReadNoSuchFileError) {
			throw error
		}
		return result
	}

	/// 積み置き（ウィジェットの「確認済みにする」）から、送り終えたものを消す。
	/// ウィジェットが同時に積み足しても消えないよう、読み・書きを1回の協調の中で行う。
	static func removeOutboxEntries(entriesJson: String) throws {
		guard let removeData = entriesJson.data(using: .utf8),
			  let removeList = try JSONSerialization.jsonObject(with: removeData) as? [[String: Any]] else {
			throw ParaLiveActivityError.badState
		}
		let removeKeys = Set(removeList.compactMap { item -> String? in
			guard let pcId = item["pcId"] as? String, let key = item["key"] as? String else {
				return nil
			}
			return pcId + "\u{0}" + key
		})
		if removeKeys.isEmpty {
			return
		}
		let target = try url(for: "widget-outbox.json")
		var coordinationError: NSError?
		var writeError: Error?
		NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: target, options: .forMerging, error: &coordinationError) { url in
			guard let data = try? Data(contentsOf: url),
				  var root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
				  let entries = root["entries"] as? [[String: Any]] else {
				return
			}
			let kept = entries.filter { entry in
				guard let pcId = entry["pcId"] as? String, let key = entry["key"] as? String else {
					return false
				}
				return !removeKeys.contains(pcId + "\u{0}" + key)
			}
			root["entries"] = kept
			do {
				let next = try JSONSerialization.data(withJSONObject: root)
				try next.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
			} catch {
				writeError = error
			}
		}
		if let error = coordinationError ?? writeError {
			throw error
		}
	}
}

enum ParaLiveActivityError: Error {
	case badState
	case badWidgetFile
	case noAppGroup
}
