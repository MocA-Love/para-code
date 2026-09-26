// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
//
// 案 B「エージェント」: PC で動いているエージェントの状態を一覧で見る。
// 見た目は paracode-widgets-mock.html の WB / accCirc / accRect / accInline（d === 'B'）。
// 出す状態・並び・件数はアプリの設定（設定 → ウィジェット）、並びはウィジェット側の設定があればそちらを優先する。

import AppIntents
import SwiftUI
import WidgetKit

@available(iOS 17.0, *)
struct AgentsWidget: Widget {
	var body: some WidgetConfiguration {
		AppIntentConfiguration(kind: WidgetKinds.agents, intent: AgentsConfigIntent.self, provider: AgentsProvider()) { entry in
			AgentsWidgetView(entry: entry)
		}
		.configurationDisplayName("エージェント")
		.description("PC で動いているエージェントの状態を一覧で見ます。")
		.supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline])
	}
}

@available(iOS 17.0, *)
struct AgentsProvider: AppIntentTimelineProvider {
	func placeholder(in context: Context) -> ParaWidgetEntry {
		ParaWidgetTimeline.sample()
	}

	func snapshot(for configuration: AgentsConfigIntent, in context: Context) async -> ParaWidgetEntry {
		ParaWidgetTimeline.current(config: configuration.resolved, context: context)
	}

	func timeline(for configuration: AgentsConfigIntent, in context: Context) async -> Timeline<ParaWidgetEntry> {
		Timeline(entries: ParaWidgetTimeline.entries(config: configuration.resolved), policy: .atEnd)
	}
}

@available(iOS 17.0, *)
extension AgentsConfigIntent {
	var resolved: ParaWidgetConfig {
		var config = ParaWidgetConfig()
		if let id = pc?.id, id != WidgetPcEntity.activeId {
			config.pcId = id
		}
		if let ref = WidgetSpaceRef.parse(space?.id) {
			config.space = .init(pcId: ref.pcId, spaceId: ref.spaceId)
		}
		switch order {
		case .attention: config.agentsOrder = "attention"
		case .newest: config.agentsOrder = "newest"
		case .appDefault: config.agentsOrder = nil
		}
		return config
	}
}

@available(iOS 17.0, *)
extension ParaWidgetModel {
	/// 設定で選んだ状態だけを、設定の並びで。
	var listedAgents: [WidgetAgent] {
		let filters = Set(settings.agents.states)
		let filtered = agents.filter { agent in
			switch agent.state {
			case "approve", "question", "error": return filters.contains("attention")
			case "running": return filters.contains("running")
			case "unread": return filters.contains("unread")
			default: return filters.contains("idle")
			}
		}
		let order = entry.config.agentsOrder ?? settings.agents.order
		if order == "newest" {
			// 新しく動いた順。時刻の分からないものは後ろ。
			return filtered.sorted { ($0.since ?? -Double.greatestFiniteMagnitude) > ($1.since ?? -Double.greatestFiniteMagnitude) }
		}
		let rank: [String: Int] = ["approve": 0, "question": 1, "error": 2, "running": 3, "unread": 4, "idle": 5]
		return filtered.sorted { a, b in
			let ra = rank[a.state] ?? 9
			let rb = rank[b.state] ?? 9
			if ra != rb { return ra < rb }
			return (a.since ?? Double.greatestFiniteMagnitude) < (b.since ?? Double.greatestFiniteMagnitude)
		}
	}

	var activeCount: Int { agents.filter { $0.state != "idle" }.count }

	var pcURL: URL {
		guard let pc else { return WidgetLink.attention }
		return WidgetLink.pc(pc.id)
	}
}

@available(iOS 17.0, *)
struct AgentsWidgetView: View {
	@Environment(\.widgetFamily) private var family
	let entry: ParaWidgetEntry

	var body: some View {
		WidgetCanvas(settings: entry.settings) { palette in
			content(palette)
		}
	}

	@ViewBuilder
	private func content(_ palette: WidgetPalette) -> some View {
		let model = ParaWidgetModel(entry: entry, spaceMode: .filter)
		if !model.paired {
			UnpairedWidgetView(family: family, label: "エージェントの一覧", noData: model.noData, palette: palette)
		} else {
			switch family {
			case .accessoryCircular: AgentsCircular(model: model)
			case .accessoryRectangular: AgentsRectangular(model: model)
			case .accessoryInline:
				Label("稼働 \(model.activeCount) ・ 要対応 \(model.attentionCount)", systemImage: "p.square")
					.widgetURL(model.pcURL)
			case .systemSmall: AgentsSmall(model: model, palette: palette)
			case .systemMedium: AgentsMedium(model: model, palette: palette)
			default: AgentsLarge(model: model, palette: palette)
			}
		}
	}
}

@available(iOS 17.0, *)
private struct CountsLabel: View {
	let model: ParaWidgetModel
	let palette: WidgetPalette

	var body: some View {
		Text(model.offline ? "オフライン" : "\(model.attentionCount > 0 ? "要対応 \(model.attentionCount) ・ " : "")実行中 \(model.count("running"))")
			.font(.system(size: 11))
			.foregroundStyle(palette.muted)
			.lineLimit(1)
	}
}

@available(iOS 17.0, *)
private struct EmptyAgents: View {
	let palette: WidgetPalette
	var body: some View {
		Text("エージェントはいません")
			.font(.system(size: 11))
			.foregroundStyle(palette.dim)
			.padding(.top, 20)
	}
}

@available(iOS 17.0, *)
private struct AgentsSmall: View {
	let model: ParaWidgetModel
	let palette: WidgetPalette

	var body: some View {
		let rows = Array(model.listedAgents.prefix(4))
		VStack(alignment: .leading, spacing: 0) {
			WidgetHeader(title: "エージェント", palette: palette)
			if rows.isEmpty {
				EmptyAgents(palette: palette)
			} else {
				VStack(alignment: .leading, spacing: 0) {
					ForEach(rows) { agent in
						HStack(spacing: 8) {
							StateGlyph(state: agent.state, palette: palette)
							Text(model.title(agent))
								.font(.system(size: 12.5, weight: .medium))
								.foregroundStyle(palette.text)
								.lineLimit(1)
								.privacySensitive()
						}
						.frame(height: 24)
					}
				}
				.padding(.top, 8)
				.opacity(model.offline ? 0.5 : 1)
			}
			Spacer(minLength: 0)
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.widgetURL(model.pcURL)
	}
}

@available(iOS 17.0, *)
private struct AgentsMedium: View {
	let model: ParaWidgetModel
	let palette: WidgetPalette

	var body: some View {
		let rows = Array(model.listedAgents.prefix(4))
		VStack(alignment: .leading, spacing: 0) {
			WidgetHeader(title: model.pcName, palette: palette, privateTitle: true) {
				CountsLabel(model: model, palette: palette)
			}
			if rows.isEmpty {
				EmptyAgents(palette: palette)
			} else {
				VStack(spacing: 0) {
					ForEach(rows) { agent in
						Link(destination: model.sessionURL(agent)) {
							HStack(spacing: 8) {
								StateGlyph(state: agent.state, palette: palette)
								Text(model.title(agent))
									.font(.system(size: 12.5, weight: .medium))
									.foregroundStyle(palette.text)
									.lineLimit(1)
									.privacySensitive()
								Spacer(minLength: 4)
								if let space = model.spaceName(id: agent.spaceId) {
									Text(space)
										.font(.system(size: 11))
										.foregroundStyle(palette.muted)
										.lineLimit(1)
										.frame(maxWidth: 80, alignment: .trailing)
										.privacySensitive()
								}
								timeLabel(agent)
									.font(.system(size: 11))
									.foregroundStyle(palette.dim)
									.lineLimit(1)
									.frame(width: 48, alignment: .trailing)
							}
							.frame(height: 24)
						}
					}
				}
				.padding(.top, 6)
				.opacity(model.offline ? 0.5 : 1)
			}
			Spacer(minLength: 0)
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.widgetURL(model.pcURL)
	}

	/// 実行中は経過を刻み（拡張を起こさずに進む）、ほかは状態の呼び名。
	@ViewBuilder
	private func timeLabel(_ agent: WidgetAgent) -> some View {
		if agent.state == "running", !model.offline, let since = agent.since {
			Text(Date(timeIntervalSince1970: since / 1000), style: .timer).monospacedDigit().multilineTextAlignment(.trailing)
		} else {
			Text(WidgetText.stateLabel(agent.state))
		}
	}
}

@available(iOS 17.0, *)
private struct AgentsLarge: View {
	let model: ParaWidgetModel
	let palette: WidgetPalette

	var body: some View {
		let rows = Array(model.listedAgents.prefix(model.settings.agents.limit))
		let groups = grouped(rows)
		VStack(alignment: .leading, spacing: 0) {
			WidgetHeader(title: model.pcName, palette: palette, privateTitle: true) {
				CountsLabel(model: model, palette: palette)
			}
			if rows.isEmpty {
				EmptyAgents(palette: palette)
			} else {
				VStack(alignment: .leading, spacing: 0) {
					ForEach(groups, id: \.id) { group in
						Text(group.name)
							.font(.system(size: 11, weight: .medium))
							.foregroundStyle(palette.muted)
							.padding(.top, 8)
							.padding(.bottom, 2)
							.privacySensitive()
						ForEach(group.agents) { agent in
							HStack(spacing: 8) {
								Link(destination: model.sessionURL(agent)) {
									HStack(spacing: 8) {
										StateGlyph(state: agent.state, palette: palette)
										VStack(alignment: .leading, spacing: 1) {
											Text(model.title(agent))
												.font(.system(size: 13, weight: .medium))
												.foregroundStyle(palette.text)
												.lineLimit(1)
												.privacySensitive()
											Text("\(WidgetText.kindLabel(agent.kind)) ・ \(WidgetText.stateLabel(agent.state))")
												.font(.system(size: 11))
												.foregroundStyle(palette.dim)
												.lineLimit(1)
										}
										Spacer(minLength: 0)
									}
									.contentShape(Rectangle())
								}
								trailing(agent)
							}
							.frame(height: 34)
						}
					}
				}
				.opacity(model.offline ? 0.5 : 1)
			}
			Spacer(minLength: 0)
			if let freshness = model.freshness {
				Text(freshness).font(.system(size: 11)).foregroundStyle(palette.muted)
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.widgetURL(model.pcURL)
	}

	@ViewBuilder
	private func trailing(_ agent: WidgetAgent) -> some View {
		if agent.state == "unread", !model.offline, model.settings.attention.showReview, let pc = model.pc {
			Button(intent: MarkReviewedIntent(pcId: pc.id, agentKeys: [agent.key])) {
				PillLabel(title: "確認済み", systemImage: "checkmark", palette: palette)
			}
			.buttonStyle(.plain)
		} else if !model.offline {
			Group {
				if agent.state == "running", let since = agent.since {
					Text(Date(timeIntervalSince1970: since / 1000), style: .timer).monospacedDigit().multilineTextAlignment(.trailing)
				} else {
					Text(model.elapsed(agent) ?? "")
				}
			}
			.font(.system(size: 11))
			.foregroundStyle(palette.dim)
			.frame(width: 52, alignment: .trailing)
		}
	}

	private struct Group_: Identifiable {
		let id: String
		let name: String
		var agents: [WidgetAgent]
	}

	private func grouped(_ agents: [WidgetAgent]) -> [Group_] {
		var result: [Group_] = []
		for agent in agents {
			let id = agent.spaceId ?? ""
			if let index = result.firstIndex(where: { $0.id == id }) {
				result[index].agents.append(agent)
			} else {
				result.append(Group_(id: id, name: model.spaceName(id: agent.spaceId) ?? "スペース不明", agents: [agent]))
			}
		}
		return result
	}
}

@available(iOS 17.0, *)
private struct AgentsCircular: View {
	let model: ParaWidgetModel

	var body: some View {
		let total = max(1, model.agents.count)
		Gauge(value: Double(model.activeCount), in: 0...Double(total)) {
			Text("稼働")
		} currentValueLabel: {
			Text("\(model.activeCount)")
		}
		.gaugeStyle(.accessoryCircularCapacity)
		.widgetURL(model.pcURL)
		.accessibilityLabel("稼働 \(model.activeCount)")
	}
}

@available(iOS 17.0, *)
private struct AgentsRectangular: View {
	let model: ParaWidgetModel

	var body: some View {
		let rows = Array(model.agents.filter { $0.state != "idle" }.prefix(3))
		VStack(alignment: .leading, spacing: 1) {
			if rows.isEmpty {
				Label { Text("すべて完了").font(.headline) } icon: { ParaLogo(size: 12, color: .white) }
				Text(model.offline ? "PC オフライン" : "実行中のものはありません").foregroundStyle(.secondary)
			} else {
				ForEach(Array(rows.enumerated()), id: \.element.key) { index, agent in
					HStack(spacing: 5) {
						Image(systemName: symbol(agent.state)).font(.system(size: 8, weight: .bold))
						Text(model.title(agent)).lineLimit(1).privacySensitive()
					}
					.font(index == 0 ? .headline : .body)
				}
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.widgetURL(model.pcURL)
	}

	private func symbol(_ state: String) -> String {
		switch state {
		case "approve", "question": return "circle.fill"
		case "error": return "exclamationmark.circle.fill"
		case "running": return "circle.dashed"
		case "unread": return "checkmark.circle"
		default: return "circle"
		}
	}
}
