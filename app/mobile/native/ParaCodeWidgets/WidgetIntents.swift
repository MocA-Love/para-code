// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
//
// ウィジェットの設定（長押し →「ウィジェットを編集」）と、ウィジェットのボタン（確認済みにする）の App Intent。
// どちらも iOS 17 以上（AppIntentConfiguration / Button(intent:)）。
//
// 設定で選べる PC・スペースの候補は、App Group の要約（WidgetStore.loadSnapshot）から出す。
// 「既定」を選んだ項目は、アプリの設定（設定 → ウィジェット）の値を使う。

import AppIntents
import WidgetKit

// MARK: - PC

@available(iOS 17.0, *)
struct WidgetPcEntity: AppEntity {
	/// 「アプリで見ている PC」を表す特別な ID。
	static let activeId = "__active__"

	static var typeDisplayRepresentation: TypeDisplayRepresentation = "PC"
	static var defaultQuery = WidgetPcQuery()

	var id: String
	var name: String

	var displayRepresentation: DisplayRepresentation {
		DisplayRepresentation(title: "\(name)")
	}

	static var active: WidgetPcEntity { WidgetPcEntity(id: activeId, name: "アプリで見ている PC") }
}

@available(iOS 17.0, *)
struct WidgetPcQuery: EntityQuery {
	func entities(for identifiers: [String]) async throws -> [WidgetPcEntity] {
		let all = try await suggestedEntities()
		return identifiers.map { id in all.first { $0.id == id } ?? WidgetPcEntity(id: id, name: "見つからない PC") }
	}

	func suggestedEntities() async throws -> [WidgetPcEntity] {
		let pcs = WidgetStore.loadSnapshot()?.pcs ?? []
		return [WidgetPcEntity.active] + pcs.map { WidgetPcEntity(id: $0.id, name: $0.name) }
	}

	func defaultResult() async -> WidgetPcEntity? {
		return WidgetPcEntity.active
	}
}

// MARK: - スペース

/// A・B の「スペース」: 「すべて」か、1 つのスペース。
@available(iOS 17.0, *)
struct WidgetSpaceFilterEntity: AppEntity {
	static let allId = "__all__"

	static var typeDisplayRepresentation: TypeDisplayRepresentation = "スペース"
	static var defaultQuery = WidgetSpaceFilterQuery()

	var id: String
	var name: String
	var pcName: String?

	var displayRepresentation: DisplayRepresentation {
		if let pcName {
			return DisplayRepresentation(title: "\(name)", subtitle: "\(pcName)")
		}
		return DisplayRepresentation(title: "\(name)")
	}

	static var all: WidgetSpaceFilterEntity { WidgetSpaceFilterEntity(id: allId, name: "すべて") }
}

@available(iOS 17.0, *)
struct WidgetSpaceFilterQuery: EntityQuery {
	func entities(for identifiers: [String]) async throws -> [WidgetSpaceFilterEntity] {
		let all = try await suggestedEntities()
		return identifiers.map { id in all.first { $0.id == id } ?? WidgetSpaceFilterEntity(id: id, name: "見つからないスペース") }
	}

	func suggestedEntities() async throws -> [WidgetSpaceFilterEntity] {
		return [WidgetSpaceFilterEntity.all] + widgetSpaceChoices().map { WidgetSpaceFilterEntity(id: $0.id, name: $0.name, pcName: $0.pcName) }
	}

	func defaultResult() async -> WidgetSpaceFilterEntity? {
		return WidgetSpaceFilterEntity.all
	}
}

/// D の「スペース」: 1 つのスペースか、「既定」（アプリの設定のスペース、無ければアプリで見ているスペース）。
@available(iOS 17.0, *)
struct WidgetSpacePickEntity: AppEntity {
	static let defaultId = "__default__"

	static var typeDisplayRepresentation: TypeDisplayRepresentation = "スペース"
	static var defaultQuery = WidgetSpacePickQuery()

	var id: String
	var name: String
	var pcName: String?

	var displayRepresentation: DisplayRepresentation {
		if let pcName {
			return DisplayRepresentation(title: "\(name)", subtitle: "\(pcName)")
		}
		return DisplayRepresentation(title: "\(name)")
	}

	static var appDefault: WidgetSpacePickEntity { WidgetSpacePickEntity(id: defaultId, name: "既定（アプリの設定）") }
}

@available(iOS 17.0, *)
struct WidgetSpacePickQuery: EntityQuery {
	func entities(for identifiers: [String]) async throws -> [WidgetSpacePickEntity] {
		let all = try await suggestedEntities()
		return identifiers.map { id in all.first { $0.id == id } ?? WidgetSpacePickEntity(id: id, name: "見つからないスペース") }
	}

	func suggestedEntities() async throws -> [WidgetSpacePickEntity] {
		return [WidgetSpacePickEntity.appDefault] + widgetSpaceChoices().map { WidgetSpacePickEntity(id: $0.id, name: $0.name, pcName: $0.pcName) }
	}

	func defaultResult() async -> WidgetSpacePickEntity? {
		return WidgetSpacePickEntity.appDefault
	}
}

/// スペースの ID は「PC の ID + 区切り + スペースの ID」（同じスペース ID が別の PC にありうるため）。
enum WidgetSpaceRef {
	static let separator: Character = "\u{1F}"

	static func make(pcId: String, spaceId: String) -> String {
		return "\(pcId)\(separator)\(spaceId)"
	}

	static func parse(_ id: String?) -> (pcId: String, spaceId: String)? {
		guard let id, let at = id.firstIndex(of: separator) else { return nil }
		let pcId = String(id[..<at])
		let spaceId = String(id[id.index(after: at)...])
		return pcId.isEmpty || spaceId.isEmpty ? nil : (pcId, spaceId)
	}
}

private func widgetSpaceChoices() -> [(id: String, name: String, pcName: String?)] {
	let pcs = WidgetStore.loadSnapshot()?.pcs ?? []
	let multiple = pcs.count > 1
	return pcs.flatMap { pc in
		pc.spaces.map { space in (id: WidgetSpaceRef.make(pcId: pc.id, spaceId: space.id), name: space.name, pcName: multiple ? pc.name : nil) }
	}
}

// MARK: - 選択肢

@available(iOS 17.0, *)
enum WidgetDetailOption: String, AppEnum {
	case appDefault, show, hide

	static var typeDisplayRepresentation: TypeDisplayRepresentation = "質問文とコマンド"
	static var caseDisplayRepresentations: [WidgetDetailOption: DisplayRepresentation] = [
		.appDefault: "既定（アプリの設定）",
		.show: "表示する",
		.hide: "表示しない",
	]
}

@available(iOS 17.0, *)
enum WidgetAgentsOrderOption: String, AppEnum {
	case appDefault, attention, newest

	static var typeDisplayRepresentation: TypeDisplayRepresentation = "並び順"
	static var caseDisplayRepresentations: [WidgetAgentsOrderOption: DisplayRepresentation] = [
		.appDefault: "既定（アプリの設定）",
		.attention: "要対応を先に",
		.newest: "新しく動いた順",
	]
}

@available(iOS 17.0, *)
enum WidgetLimitOption: String, AppEnum {
	case appDefault, claude, codex

	static var typeDisplayRepresentation: TypeDisplayRepresentation = "利用上限の対象"
	static var caseDisplayRepresentations: [WidgetLimitOption: DisplayRepresentation] = [
		.appDefault: "既定（アプリの設定）",
		.claude: "Claude",
		.codex: "Codex",
	]
}

// MARK: - ウィジェットごとの設定

@available(iOS 17.0, *)
struct AttentionConfigIntent: WidgetConfigurationIntent {
	static var title: LocalizedStringResource = "要対応"
	static var description = IntentDescription("質問や許可を待っているエージェントを確かめ、そのまま開きます。")

	@Parameter(title: "PC")
	var pc: WidgetPcEntity?

	@Parameter(title: "スペース")
	var space: WidgetSpaceFilterEntity?

	@Parameter(title: "質問文とコマンドを表示", default: .appDefault)
	var detail: WidgetDetailOption
}

@available(iOS 17.0, *)
struct AgentsConfigIntent: WidgetConfigurationIntent {
	static var title: LocalizedStringResource = "エージェント"
	static var description = IntentDescription("PC で動いているエージェントの状態を一覧で見ます。")

	@Parameter(title: "PC")
	var pc: WidgetPcEntity?

	@Parameter(title: "スペース")
	var space: WidgetSpaceFilterEntity?

	@Parameter(title: "並び順", default: .appDefault)
	var order: WidgetAgentsOrderOption
}

@available(iOS 17.0, *)
struct PcStatusConfigIntent: WidgetConfigurationIntent {
	static var title: LocalizedStringResource = "PC の状態"
	static var description = IntentDescription("PC の電池・負荷・今日のコスト・利用上限を確かめます。")

	@Parameter(title: "PC")
	var pc: WidgetPcEntity?

	@Parameter(title: "利用上限の対象", default: .appDefault)
	var limit: WidgetLimitOption
}

@available(iOS 17.0, *)
struct SpaceConfigIntent: WidgetConfigurationIntent {
	static var title: LocalizedStringResource = "スペース"
	static var description = IntentDescription("1 つのスペースのエージェント・変更・コミットを追います。")

	@Parameter(title: "スペース")
	var space: WidgetSpacePickEntity?
}

// MARK: - ボタン（確認済みにする）

/// 未確認のエージェントを確認済みにする。ウィジェットの表示はすぐ変え、PC へは次にアプリが繋いだときに
/// 既存の「確認済みにする」で送る（ウィジェットから PC へ届ける経路は無い）。
/// ロック中は実行させない（解除してから）。
@available(iOS 17.0, *)
struct MarkReviewedIntent: AppIntent {
	static var title: LocalizedStringResource = "確認済みにする"
	static var isDiscoverable = false
	static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

	@Parameter(title: "PC")
	var pcId: String

	/// 改行区切りの terminalKey（「すべて確認済み」は複数を渡す）。
	@Parameter(title: "エージェント")
	var agentKeys: String

	init() {}

	init(pcId: String, agentKeys: [String]) {
		self.pcId = pcId
		self.agentKeys = agentKeys.joined(separator: "\n")
	}

	func perform() async throws -> some IntentResult {
		let keys = agentKeys.split(separator: "\n").map(String.init).filter { !$0.isEmpty }
		WidgetStore.markReviewed(pcId: pcId, keys: keys)
		// perform から戻るとタイムラインは描き直される（予算に数えない）。
		return .result()
	}
}
