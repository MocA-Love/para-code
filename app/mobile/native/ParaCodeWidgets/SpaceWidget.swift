// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
//
// 案 D「スペース」: 1 つのスペースのエージェント・変更・コミットを追う。
// 見た目は paracode-widgets-mock.html の WD / accCirc / accRect / accInline（d === 'D'）。
// スペースはウィジェット側の設定（AppIntentConfiguration）で選ぶ。選んでいなければアプリの設定のスペース、
// それも無ければエージェントのいるスペース。変更件数とコミットはアプリが開いていた時の値。
// 行数の増減（+/-）は PC から届かないので出さない（モックとの違い）。

import AppIntents
import SwiftUI
import WidgetKit

@available(iOS 17.0, *)
struct SpaceWidget: Widget {
	var body: some WidgetConfiguration {
		AppIntentConfiguration(kind: WidgetKinds.space, intent: SpaceConfigIntent.self, provider: SpaceProvider()) { entry in
			SpaceWidgetView(entry: entry)
		}
		.configurationDisplayName("スペース")
		.description("1 つのスペースのエージェント・変更・コミットを追います。")
		.supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline])
	}
}

@available(iOS 17.0, *)
struct SpaceProvider: AppIntentTimelineProvider {
	func placeholder(in context: Context) -> ParaWidgetEntry {
		ParaWidgetTimeline.sample()
	}

	func snapshot(for configuration: SpaceConfigIntent, in context: Context) async -> ParaWidgetEntry {
		ParaWidgetTimeline.current(config: configuration.resolved, context: context)
	}

	func timeline(for configuration: SpaceConfigIntent, in context: Context) async -> Timeline<ParaWidgetEntry> {
		Timeline(entries: ParaWidgetTimeline.entries(config: configuration.resolved), policy: .atEnd)
	}
}

@available(iOS 17.0, *)
extension SpaceConfigIntent {
	var resolved: ParaWidgetConfig {
		var config = ParaWidgetConfig()
		if let ref = WidgetSpaceRef.parse(space?.id) {
			config.space = .init(pcId: ref.pcId, spaceId: ref.spaceId)
		}
		return config
	}
}

@available(iOS 17.0, *)
extension ParaWidgetModel {
	var spaceURL: URL {
		guard let pc else { return WidgetLink.attention }
		return WidgetLink.session(pc: pc.id, space: space?.id, terminal: nil, at: now)
	}

	var sourceControlURL: URL? {
		guard let pc, let space else { return nil }
		return WidgetLink.sourceControl(pc: pc.id, space: space.id)
	}

	var reviewURL: URL? {
		guard let pc, let space else { return nil }
		return WidgetLink.review(pc: pc.id, space: space.id)
	}

	var changesText: String {
		guard let changes = space?.changes else { return "—" }
		return "\(changes)"
	}

	var latestCommit: WidgetSpaceCommit? { space?.commits?.first }

	func commitAgo(_ commit: WidgetSpaceCommit) -> String {
		guard let at = commit.at else { return "" }
		return WidgetText.ago(at, now: now)
	}
}

@available(iOS 17.0, *)
struct SpaceWidgetView: View {
	@Environment(\.widgetFamily) private var family
	let entry: ParaWidgetEntry

	var body: some View {
		WidgetCanvas(settings: entry.settings) { palette in
			content(palette)
		}
	}

	@ViewBuilder
	private func content(_ palette: WidgetPalette) -> some View {
		let model = ParaWidgetModel(entry: entry, spaceMode: .pick)
		if !model.paired {
			UnpairedWidgetView(family: family, label: "スペースの様子", noData: model.noData, palette: palette)
		} else if model.space == nil {
			NoSpaceView(family: family, palette: palette)
		} else {
			switch family {
			case .accessoryCircular: SpaceCircular(model: model)
			case .accessoryRectangular: SpaceRectangular(model: model)
			case .accessoryInline:
				Label("\(model.spaceName(model.space)) 変更 \(model.changesText)", systemImage: "arrow.triangle.branch")
					.privacySensitive()
					.widgetURL(model.spaceURL)
			case .systemSmall: SpaceSmall(model: model, palette: palette)
			case .systemMedium: SpaceMedium(model: model, palette: palette)
			default: SpaceLarge(model: model, palette: palette)
			}
		}
	}
}

@available(iOS 17.0, *)
private struct NoSpaceView: View {
	let family: WidgetFamily
	let palette: WidgetPalette

	var body: some View {
		switch family {
		case .accessoryCircular, .accessoryRectangular, .accessoryInline:
			Label("スペースなし", systemImage: "arrow.triangle.branch")
				.widgetURL(WidgetLink.attention)
		default:
			VStack(alignment: .leading, spacing: 6) {
				WidgetHeader(title: "スペース", palette: palette)
				Text("スペースがまだありません")
					.font(.system(size: 13, weight: .semibold))
					.foregroundStyle(palette.text)
					.padding(.top, 8)
				Text("アプリで PC を開くと、スペースの一覧が届きます。")
					.font(.system(size: 11))
					.foregroundStyle(palette.dim)
				Spacer(minLength: 0)
			}
			.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
			.widgetURL(WidgetLink.attention)
		}
	}
}

@available(iOS 17.0, *)
private struct BranchLabel: View {
	let model: ParaWidgetModel
	let palette: WidgetPalette

	var body: some View {
		if let branch = model.space?.branch {
			HStack(spacing: 4) {
				Image(systemName: "arrow.triangle.branch").font(.system(size: 10))
				Text(branch).lineLimit(1).privacySensitive()
			}
			.font(.system(size: 11))
			.foregroundStyle(palette.dim)
		}
	}
}

@available(iOS 17.0, *)
private struct SpaceAgentRow: View {
	let model: ParaWidgetModel
	let agent: WidgetAgent
	let palette: WidgetPalette
	var withAction = false

	var body: some View {
		HStack(spacing: 8) {
			Link(destination: model.sessionURL(agent)) {
				HStack(spacing: 8) {
					StateGlyph(state: agent.state, palette: palette)
					Text(model.title(agent))
						.font(.system(size: 12.5, weight: .medium))
						.foregroundStyle(palette.text)
						.lineLimit(1)
						.privacySensitive()
					Spacer(minLength: 0)
				}
				.contentShape(Rectangle())
			}
			if withAction {
				AgentActionButton(model: model, agent: agent, palette: palette)
			}
			Group {
				if agent.state == "running", !model.offline, let since = agent.since {
					Text(Date(timeIntervalSince1970: since / 1000), style: .timer).monospacedDigit().multilineTextAlignment(.trailing)
				} else {
					Text(WidgetText.stateLabel(agent.state))
				}
			}
			.font(.system(size: 11))
			.foregroundStyle(palette.dim)
			.frame(width: 50, alignment: .trailing)
		}
		.frame(height: 28)
	}
}

@available(iOS 17.0, *)
private struct SpaceSmall: View {
	let model: ParaWidgetModel
	let palette: WidgetPalette

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			WidgetHeader(title: model.spaceName(model.space), palette: palette, privateTitle: true)
			BranchLabel(model: model, palette: palette).padding(.top, 4)
			if model.settings.space.showChanges {
				BigCount(value: model.changesText, unit: "変更", palette: palette, size: 34).padding(.top, 8)
			}
			if model.settings.space.showCommits, let commit = model.latestCommit {
				Text("最新 \(model.commitAgo(commit))")
					.font(.system(size: 11))
					.foregroundStyle(palette.dim)
					.lineLimit(1)
			}
			Spacer(minLength: 0)
			if model.settings.space.showAgents {
				HStack(spacing: 4) {
					ForEach(model.agents.prefix(5)) { agent in
						StateGlyph(state: agent.state, palette: palette)
					}
					Text("エージェント \(model.agents.count)")
						.font(.system(size: 11))
						.foregroundStyle(palette.dim)
				}
			}
		}
		.opacity(model.offline ? 0.6 : 1)
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.widgetURL(model.spaceURL)
	}
}

@available(iOS 17.0, *)
private struct SpaceMedium: View {
	let model: ParaWidgetModel
	let palette: WidgetPalette

	var body: some View {
		HStack(spacing: 12) {
			VStack(alignment: .leading, spacing: 2) {
				WidgetHeader(title: model.spaceName(model.space), palette: palette, privateTitle: true)
				BranchLabel(model: model, palette: palette).padding(.top, 4)
				if model.settings.space.showChanges {
					BigCount(value: model.changesText, unit: "変更", palette: palette, size: 30).padding(.top, 6)
				}
				Spacer(minLength: 0)
				if let freshness = model.freshness {
					Text(freshness).font(.system(size: 11)).foregroundStyle(palette.muted).lineLimit(2)
				}
			}
			.frame(width: 118, alignment: .leading)
			VStack(alignment: .leading, spacing: 0) {
				if model.settings.space.showAgents {
					Text("エージェント").font(.system(size: 11, weight: .medium)).foregroundStyle(palette.muted)
					let rows = Array(model.agents.prefix(2))
					if rows.isEmpty {
						Text("エージェントはいません").font(.system(size: 11)).foregroundStyle(palette.dim).padding(.top, 4)
					}
					ForEach(rows) { agent in
						SpaceAgentRow(model: model, agent: agent, palette: palette)
					}
				}
				if model.settings.space.showCommits, let commit = model.latestCommit {
					Rectangle().fill(palette.line).frame(height: 1).padding(.vertical, 6)
					Group {
						if let url = model.sourceControlURL {
							Link(destination: url) { commitView(commit) }
						} else {
							commitView(commit)
						}
					}
				}
				Spacer(minLength: 0)
			}
			.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
			.opacity(model.offline ? 0.5 : 1)
		}
		.widgetURL(model.spaceURL)
	}

	private func commitView(_ commit: WidgetSpaceCommit) -> some View {
		VStack(alignment: .leading, spacing: 1) {
			Text("最新 \(model.commitAgo(commit))").font(.system(size: 11)).foregroundStyle(palette.dim)
			Text(commit.subject)
				.font(.system(size: 12.5, weight: .medium))
				.foregroundStyle(palette.text)
				.lineLimit(1)
				.privacySensitive()
		}
	}
}

@available(iOS 17.0, *)
private struct SpaceLarge: View {
	let model: ParaWidgetModel
	let palette: WidgetPalette

	var body: some View {
		let settings = model.settings.space
		let files = model.space?.files ?? []
		let changes = model.space?.changes ?? files.count
		VStack(alignment: .leading, spacing: 0) {
			WidgetHeader(title: model.spaceName(model.space), palette: palette, privateTitle: true) {
				if let pc = model.pc { PcBadge(pc: pc, palette: palette) }
			}
			BranchLabel(model: model, palette: palette).padding(.top, 4)
			VStack(alignment: .leading, spacing: 0) {
				if settings.showAgents {
					SectionTitle(text: "エージェント", palette: palette)
					let rows = Array(model.agents.prefix(4))
					if rows.isEmpty {
						Text("エージェントはいません").font(.system(size: 11)).foregroundStyle(palette.dim)
					}
					ForEach(rows) { agent in
						SpaceAgentRow(model: model, agent: agent, palette: palette, withAction: true)
					}
				}
				if settings.showChanges {
					SectionTitle(text: model.space?.changes != nil ? "変更 \(changes)" : "変更", palette: palette)
					if model.space?.changes == nil {
						Text("アプリでこのスペースを開くと届きます").font(.system(size: 11)).foregroundStyle(palette.dim)
					} else if files.isEmpty {
						Text("変更はありません").font(.system(size: 11)).foregroundStyle(palette.dim)
					} else {
						ForEach(Array(files.prefix(4).enumerated()), id: \.offset) { _, file in
							HStack(spacing: 8) {
								Text(file.code)
									.font(.system(size: 11, weight: .semibold))
									.foregroundStyle(file.code == "A" ? palette.add : file.code == "D" ? palette.del : palette.dim)
									.frame(width: 12, alignment: .leading)
								Text(file.path)
									.font(.system(size: 11))
									.foregroundStyle(palette.text)
									.lineLimit(1)
									.truncationMode(.middle)
									.privacySensitive()
							}
							.frame(height: 18)
						}
						if changes > 4 {
							Text("ほか \(changes - 4) 件").font(.system(size: 11)).foregroundStyle(palette.muted)
						}
					}
				}
				if settings.showCommits, let commits = model.space?.commits, !commits.isEmpty {
					SectionTitle(text: "最近のコミット", palette: palette)
					ForEach(Array(commits.prefix(2).enumerated()), id: \.offset) { _, commit in
						HStack(spacing: 6) {
							Text(commit.subject)
								.font(.system(size: 11))
								.foregroundStyle(palette.text)
								.lineLimit(1)
								.privacySensitive()
							Spacer(minLength: 4)
							Text(model.commitAgo(commit)).font(.system(size: 11)).foregroundStyle(palette.muted)
						}
						.frame(height: 18)
					}
				}
			}
			.opacity(model.offline ? 0.5 : 1)
			Spacer(minLength: 0)
			HStack(spacing: 6) {
				if let freshness = model.freshness {
					Text(freshness).font(.system(size: 11)).foregroundStyle(palette.muted)
				}
				Spacer(minLength: 0)
				if let url = model.reviewURL {
					Link(destination: url) {
						PillLabel(title: "差分を見る", systemImage: "chevron.right", palette: palette, imageTrailing: true)
					}
				}
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.widgetURL(model.spaceURL)
	}
}

@available(iOS 17.0, *)
private struct SpaceCircular: View {
	let model: ParaWidgetModel

	var body: some View {
		ZStack {
			AccessoryWidgetBackground()
			VStack(spacing: 0) {
				Image(systemName: "arrow.triangle.branch").font(.system(size: 11))
				Text(model.changesText).font(.system(size: 22, weight: .semibold)).minimumScaleFactor(0.6)
				Text("変更").font(.system(size: 10)).opacity(0.8)
			}
		}
		.widgetURL(model.sourceControlURL ?? model.spaceURL)
	}
}

@available(iOS 17.0, *)
private struct SpaceRectangular: View {
	let model: ParaWidgetModel

	var body: some View {
		VStack(alignment: .leading, spacing: 1) {
			HStack(spacing: 4) {
				Image(systemName: "arrow.triangle.branch").font(.system(size: 11))
				Text(model.spaceName(model.space)).font(.headline).lineLimit(1).privacySensitive()
			}
			Text("要対応 \(model.attentionCount) ・ 実行中 \(model.count("running"))").lineLimit(1)
			Text("変更 \(model.changesText)\(model.latestCommit.map { " ・ \(model.commitAgo($0))にコミット" } ?? "")")
				.lineLimit(1)
				.foregroundStyle(.secondary)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.widgetURL(model.spaceURL)
	}
}
