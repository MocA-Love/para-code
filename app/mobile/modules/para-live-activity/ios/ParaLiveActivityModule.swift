// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import ActivityKit
import ExpoModulesCore
import Foundation
import WidgetKit

/// ParaCodeActivityAttributes のアプリ本体側コピー。
/// native/ParaCodeWidgets/ParaCodeActivityAttributes.swift（ios/ParaCodeWidgets/ へ写したもの）と完全に同一定義を保つこと
/// （ActivityKit は型名でアクティビティをマッチングする。フィールド変更時は両方と JS 側を揃える）。
/// 各フィールドの意味は Widget 側のファイルに書いてある。
struct ParaCodeActivityAttributes: ActivityAttributes {
	public struct ContentState: Codable, Hashable {
		var phase: String
		var waitingCount: Int
		var runningCount: Int
		var doneCount: Int
		var attention: [AttentionItem]
		var running: [RunningItem]
		var done: [DoneItem]
		var battery: Battery?
		var updatedAt: Double
		var asOf: Double?
		var endsAt: Double?
	}

	public struct AttentionItem: Codable, Hashable {
		var key: String
		var space: String?
		var name: String
		var kind: String
		var since: Double?
		var tool: String?
		var detail: String?
	}

	public struct RunningItem: Codable, Hashable {
		var key: String
		var space: String?
		var name: String
		var since: Double?
		var tool: String?
		var target: String?
	}

	public struct DoneItem: Codable, Hashable {
		var key: String
		var space: String?
		var name: String
		var at: Double?
		var took: Double?
	}

	public struct Battery: Codable, Hashable {
		var level: Int
		var charging: Bool
	}

	var pcId: String
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

/// epoch ミリ秒を Date へ。
private func dateFromMillis(_ ms: Double) -> Date {
	return Date(timeIntervalSince1970: ms / 1000)
}

/// まだ終えていない Live Activity か。staleDate（最後の更新の 2 分後）を過ぎると `.stale` になるが、
/// 終えてはいないので `.active` と同じく更新・終了の対象にする（`.ended` / `.dismissed` は完了の要約か消えたもの）。
@available(iOS 16.2, *)
private func isLive(_ activity: Activity<ParaCodeActivityAttributes>) -> Bool {
	switch activity.activityState {
	case .active, .stale:
		return true
	default:
		return false
	}
}

/**
 * JSからLive Activityを開始/更新/終了するExpoローカルモジュール。
 * 状態はJSON文字列で受けて ContentState へデコードする（Expoの型ブリッジを介さず
 * Widget側と同一のCodable定義を直接使うため）。組み立てと判断は JS（src/liveActivityState.ts）。
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

		// 同じ PC で動いているものがあれば更新し、無ければ始める。ほか（別の PC・PC 名が変わった・完了の要約として
		// 残しているもの）は即時に終えて消す（Live Activity は 1 本だけにする。HIG: 件ごとに分けない）。
		// 段階 2 では pushType を .token にし、activity.pushTokenUpdates を JS へ渡して PC に登録する。
		AsyncFunction("upsert") { (attributesJson: String, stateJson: String, staleAt: Double?) async throws in
			guard #available(iOS 16.2, *) else {
				return
			}
			guard let attributesData = attributesJson.data(using: .utf8), let stateData = stateJson.data(using: .utf8) else {
				throw ParaLiveActivityError.badState
			}
			let attributes = try JSONDecoder().decode(ParaCodeActivityAttributes.self, from: attributesData)
			let state = try JSONDecoder().decode(ParaCodeActivityAttributes.ContentState.self, from: stateData)
			let content = ActivityContent(state: state, staleDate: staleAt.map(dateFromMillis))
			var current: Activity<ParaCodeActivityAttributes>?
			for activity in Activity<ParaCodeActivityAttributes>.activities {
				let same = activity.attributes.pcId == attributes.pcId && activity.attributes.pcName == attributes.pcName
				// staleDate を過ぎたもの（.stale）も生きている。作り直さず update する（背面では request が失敗するため）
				if current == nil && same && isLive(activity) {
					current = activity
				} else {
					await activity.end(nil, dismissalPolicy: .immediate)
				}
			}
			if let current {
				await current.update(content)
			} else {
				_ = try Activity.request(attributes: attributes, content: content, pushType: nil)
			}
		}

		// 最後の中身（完了の要約）を載せて終え、dismissAt までロック画面に残す（Dynamic Island からは消える）。
		AsyncFunction("finish") { (stateJson: String, dismissAt: Double) async throws in
			guard #available(iOS 16.2, *) else {
				return
			}
			guard let data = stateJson.data(using: .utf8) else {
				throw ParaLiveActivityError.badState
			}
			let state = try JSONDecoder().decode(ParaCodeActivityAttributes.ContentState.self, from: data)
			let content = ActivityContent(state: state, staleDate: nil)
			for activity in Activity<ParaCodeActivityAttributes>.activities where isLive(activity) {
				await activity.end(content, dismissalPolicy: .after(dateFromMillis(dismissAt)))
			}
		}

		// 即時に終えて消す。includeFinished が false なら、完了の要約として残しているもの（終了済み）は残す。
		AsyncFunction("end") { (includeFinished: Bool) async in
			guard #available(iOS 16.2, *) else {
				return
			}
			for activity in Activity<ParaCodeActivityAttributes>.activities {
				if !includeFinished && !isLive(activity) {
					continue
				}
				await activity.end(nil, dismissalPolicy: .immediate)
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

		AsyncFunction("writeWidgetFileIfUnchanged") { (name: String, expected: String?, contents: String) throws -> Bool in
			return try ParaWidgetFiles.writeIfUnchanged(name: name, expected: expected, contents: contents)
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

	/// いまの中身が `expected`（無ければ nil）のときだけ書く。比べて書くのを 1 回の協調の中で行い、
	/// 読んでから書くまでの間に通知拡張・ウィジェットが書いたぶんを上書きしない（違えば false。JS が読み直して合わせる）。
	static func writeIfUnchanged(name: String, expected: String?, contents: String) throws -> Bool {
		let target = try url(for: name)
		guard let data = contents.data(using: .utf8) else {
			throw ParaLiveActivityError.badState
		}
		var coordinationError: NSError?
		var writeError: Error?
		var wrote = false
		NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: target, options: .forMerging, error: &coordinationError) { url in
			let current = (try? Data(contentsOf: url)).flatMap { String(data: $0, encoding: .utf8) }
			guard current == expected else {
				return
			}
			do {
				try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
				wrote = true
			} catch {
				writeError = error
			}
		}
		if let error = coordinationError ?? writeError {
			throw error
		}
		return wrote
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
		// 積んだ時刻（at）まで揃うものだけを消す（片付けを決めた後に押し直して積み直したものは残す）。
		let removeKeys = Set(removeList.compactMap { item -> String? in
			guard let pcId = item["pcId"] as? String, let key = item["key"] as? String else {
				return nil
			}
			return entryKey(pcId: pcId, key: key, at: item["at"])
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
				return !removeKeys.contains(entryKey(pcId: pcId, key: key, at: entry["at"]))
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

extension ParaWidgetFiles {
	/// 積み置きの1件を指す鍵。at は JSON の数（NSNumber）を整数のミリ秒にそろえて比べる。
	static func entryKey(pcId: String, key: String, at: Any?) -> String {
		var atMs = ""
		if let value = (at as? NSNumber)?.doubleValue, value.isFinite, abs(value) < 9.0e15 {
			atMs = String(Int64(value.rounded()))
		}
		return pcId + "\u{0}" + key + "\u{0}" + atMs
	}
}

enum ParaLiveActivityError: Error {
	case badState
	case badWidgetFile
	case noAppGroup
}
