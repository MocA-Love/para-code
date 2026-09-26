// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
//
// 案 A「要対応」: 質問や許可を待っているエージェントを確かめ、そのまま開く。
// 小・中・大と、ロック画面の circular / rectangular / inline。見た目は paracode-widgets-mock.html の WA / accCirc / accRect / accInline。
// 「許可」「答える」はアプリの該当セッションを開く Link。ウィジェットの中で完結するのは「確認済みにする」（App Intent）だけ。

import AppIntents
import SwiftUI
import WidgetKit

@available(iOS 17.0, *)
struct AttentionWidget: Widget {
	var body: some WidgetConfiguration {
		AppIntentConfiguration(kind: WidgetKinds.attention, intent: AttentionConfigIntent.self, provider: AttentionProvider()) { entry in
			AttentionWidgetView(entry: entry)
		}
		.configurationDisplayName("要対応")
		.description("質問や許可を待っているエージェントを確かめ、そのまま開きます。")
		.supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline])
	}
}

@available(iOS 17.0, *)
struct AttentionProvider: AppIntentTimelineProvider {
	func placeholder(in context: Context) -> ParaWidgetEntry {
		ParaWidgetTimeline.sample()
	}

	func snapshot(for configuration: AttentionConfigIntent, in context: Context) async -> ParaWidgetEntry {
		ParaWidgetTimeline.current(config: configuration.resolved, context: context)
	}

	func timeline(for configuration: AttentionConfigIntent, in context: Context) async -> Timeline<ParaWidgetEntry> {
		Timeline(entries: ParaWidgetTimeline.entries(config: configuration.resolved), policy: .atEnd)
	}
}

@available(iOS 17.0, *)
extension AttentionConfigIntent {
	var resolved: ParaWidgetConfig {
		var config = ParaWidgetConfig()
		if let id = pc?.id, id != WidgetPcEntity.activeId {
			config.pcId = id
		}
		if let ref = WidgetSpaceRef.parse(space?.id) {
			config.space = .init(pcId: ref.pcId, spaceId: ref.spaceId)
		}
		switch detail {
		case .show: config.showDetail = true
		case .hide: config.showDetail = false
		case .appDefault: config.showDetail = nil
		}
		return config
	}
}

// MARK: - 共通の入れ物

/// 色を決めて、背景（containerBackground）を付ける。ティント・クリア・ロック画面では背景を外す。
@available(iOS 17.0, *)
struct WidgetCanvas<Content: View>: View {
	@Environment(\.widgetRenderingMode) private var mode
	@Environment(\.colorScheme) private var scheme
	let settings: WidgetAppSettings
	@ViewBuilder var content: (WidgetPalette) -> Content

	var body: some View {
		let palette = WidgetPalette.make(mode: mode, scheme: scheme, accentHex: settings.accentHex, accentTextHex: settings.accentTextHex)
		content(palette)
			.containerBackground(for: .widget) { palette.background }
	}
}

/// ペアリングしていない・アプリが一度も書いていないとき。
@available(iOS 17.0, *)
struct UnpairedWidgetView: View {
	let family: WidgetFamily
	let label: String
	let noData: Bool
	let palette: WidgetPalette

	var body: some View {
		switch family {
		case .accessoryCircular:
			ZStack {
				AccessoryWidgetBackground()
				ParaLogo(size: 26, color: .white)
			}
			.widgetURL(WidgetLink.pair)
		case .accessoryRectangular:
			VStack(alignment: .leading, spacing: 1) {
				Label { Text("Para Code").font(.headline) } icon: { ParaLogo(size: 13, color: .white) }
				Text(noData ? "アプリを開くと" : "PC とペアリング")
				Text(noData ? "表示されます" : "されていません")
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			.widgetURL(noData ? WidgetLink.make("") : WidgetLink.pair)
		case .accessoryInline:
			Label(noData ? "Para Code" : "未ペアリング", systemImage: "p.square")
				.widgetURL(WidgetLink.pair)
		case .systemSmall:
			VStack(alignment: .leading, spacing: 8) {
				ParaLogo(size: 26, color: palette.text).widgetAccentable()
				Text(noData ? "Para Code を開く" : "PC とペアリング")
					.font(.system(size: 14, weight: .semibold))
					.foregroundStyle(palette.text)
				Text(noData ? "アプリを一度開くと\(label)が出ます" : "PC の QR を読み取ると\(label)が出ます")
					.font(.system(size: 11))
					.foregroundStyle(palette.dim)
				Spacer(minLength: 0)
			}
			.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
			.widgetURL(noData ? WidgetLink.attention : WidgetLink.pair)
		default:
			VStack(alignment: .leading, spacing: 10) {
				ParaLogo(size: 30, color: palette.text).widgetAccentable()
				Text(noData ? "アプリを開くと表示されます" : "PC とまだペアリングしていません")
					.font(.system(size: 15, weight: .semibold))
					.foregroundStyle(palette.text)
				Text(noData ? "Para Code を一度開くと、\(label)がここに出ます。" : "PC の Para Code で「モバイル」を開き、表示された QR を読み取ると\(label)がここに出ます。")
					.font(.system(size: 11))
					.foregroundStyle(palette.dim)
				if !noData {
					Link(destination: WidgetLink.pair) {
						PillLabel(title: "ペアリングする", systemImage: "chevron.right", palette: palette, primary: true, imageTrailing: true)
					}
				}
			}
			.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
			.widgetURL(noData ? WidgetLink.attention : WidgetLink.pair)
		}
	}
}

// MARK: - A

@available(iOS 17.0, *)
struct AttentionWidgetView: View {
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
			UnpairedWidgetView(family: family, label: "要対応のエージェント", noData: model.noData, palette: palette)
		} else {
			switch family {
			case .accessoryCircular: AttentionCircular(model: model)
			case .accessoryRectangular: AttentionRectangular(model: model)
			case .accessoryInline: AttentionInline(model: model)
			case .systemSmall: AttentionSmall(model: model, palette: palette)
			case .systemMedium: AttentionMedium(model: model, palette: palette)
			default: AttentionLarge(model: model, palette: palette)
			}
		}
	}
}

@available(iOS 17.0, *)
extension ParaWidgetModel {
	/// 要対応の行（待機を除く）。要対応 → エラー → 実行中 → 未確認の順、同じ状態の中は設定の並び。
	var attentionRows: [WidgetAgent] {
		let order: [String: Int] = ["approve": 0, "question": 1, "error": 2, "running": 3, "unread": 4]
		let newest = settings.attention.order == "newest"
		return agents.filter { $0.state != "idle" }.sorted { a, b in
			let sa = order[a.state] ?? 9
			let sb = order[b.state] ?? 9
			if sa != sb { return sa < sb }
			let ta = a.since ?? (newest ? -Double.greatestFiniteMagnitude : Double.greatestFiniteMagnitude)
			let tb = b.since ?? (newest ? -Double.greatestFiniteMagnitude : Double.greatestFiniteMagnitude)
			return newest ? ta > tb : ta < tb
		}
	}

	var firstAttention: WidgetAgent? { attentionRows.first { $0.isAttention } }

	var unreadKeys: [String] { agents.filter { $0.state == "unread" }.map(\.key) }

	var attentionURL: URL {
		if let first = firstAttention { return sessionURL(first) }
		return WidgetLink.attention
	}

	/// 「許可待ち ・ 3分」。
	func stateMeta(_ agent: WidgetAgent) -> String {
		guard !offline, let elapsed = elapsed(agent) else { return WidgetText.stateLabel(agent.state) }
		return "\(WidgetText.stateLabel(agent.state)) ・ \(elapsed)"
	}
}

/// 行の右端のボタン。許可・答えるはアプリを開く Link、確認済みは App Intent。オフライン中は出さない。
@available(iOS 17.0, *)
struct AgentActionButton: View {
	let model: ParaWidgetModel
	let agent: WidgetAgent
	let palette: WidgetPalette

	var body: some View {
		if model.offline || model.pc == nil {
			EmptyView()
		} else if agent.state == "approve", model.settings.attention.showApprove {
			Link(destination: model.sessionURL(agent)) {
				PillLabel(title: "許可", systemImage: "chevron.right", palette: palette, primary: true, imageTrailing: true)
			}
		} else if agent.state == "question", model.settings.attention.showAnswer {
			Link(destination: model.sessionURL(agent)) {
				PillLabel(title: "答える", systemImage: "chevron.right", palette: palette, imageTrailing: true)
			}
		} else if agent.state == "unread", model.settings.attention.showReview, let pc = model.pc {
			Button(intent: MarkReviewedIntent(pcId: pc.id, agentKeys: [agent.key])) {
				PillLabel(title: "確認済み", systemImage: "checkmark", palette: palette)
			}
			.buttonStyle(.plain)
		}
	}
}

@available(iOS 17.0, *)
struct ReviewAllButton: View {
	let model: ParaWidgetModel
	let palette: WidgetPalette

	var body: some View {
		if let pc = model.pc, !model.offline, model.settings.attention.showReview, !model.unreadKeys.isEmpty {
			Button(intent: MarkReviewedIntent(pcId: pc.id, agentKeys: model.unreadKeys)) {
				PillLabel(title: "すべて確認済み", systemImage: "checkmark", palette: palette)
			}
			.buttonStyle(.plain)
		}
	}
}

@available(iOS 17.0, *)
struct BigCount: View {
	let value: String
	let unit: String
	let palette: WidgetPalette
	var size: CGFloat = 42

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: 3) {
			Text(value)
				.font(.system(size: size, weight: .semibold))
				.tracking(-1)
				.foregroundStyle(palette.text)
				.widgetAccentable()
			Text(unit)
				.font(.system(size: 14, weight: .medium))
				.foregroundStyle(palette.dim)
		}
	}
}

@available(iOS 17.0, *)
private struct AttentionSmall: View {
	let model: ParaWidgetModel
	let palette: WidgetPalette

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			WidgetHeader(title: "要対応", palette: palette) {
				if model.offline {
					Text("オフライン").font(.system(size: 11)).foregroundStyle(palette.muted)
				}
			}
			if let first = model.firstAttention {
				BigCount(value: "\(model.attentionCount)", unit: "件", palette: palette)
					.padding(.top, 8)
					.opacity(model.offline ? 0.5 : 1)
				Spacer(minLength: 0)
				HStack(alignment: .top, spacing: 6) {
					StateGlyph(state: first.state, palette: palette).padding(.top, 2)
					VStack(alignment: .leading, spacing: 2) {
						Text(model.title(first))
							.font(.system(size: 13, weight: .semibold))
							.foregroundStyle(palette.text)
							.lineLimit(2)
							.privacySensitive()
						Text(model.offline ? (model.freshness ?? "") : model.stateMeta(first))
							.font(.system(size: 11))
							.foregroundStyle(palette.dim)
							.lineLimit(1)
					}
				}
			} else {
				Image(systemName: "checkmark")
					.font(.system(size: 26, weight: .semibold))
					.foregroundStyle(palette.green)
					.widgetAccentable()
					.padding(.top, 12)
				Text("要対応なし")
					.font(.system(size: 15, weight: .semibold))
					.foregroundStyle(palette.text)
					.padding(.top, 4)
				Text("実行中 \(model.count("running")) ・ 未確認 \(model.count("unread"))")
					.font(.system(size: 11))
					.foregroundStyle(palette.dim)
					.padding(.top, 2)
				Spacer(minLength: 0)
				ReviewAllButton(model: model, palette: palette)
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.widgetURL(model.attentionURL)
	}
}

@available(iOS 17.0, *)
private struct AttentionMedium: View {
	let model: ParaWidgetModel
	let palette: WidgetPalette

	var body: some View {
		let rows = Array(model.attentionRows.prefix(2))
		HStack(spacing: 12) {
			VStack(alignment: .leading, spacing: 0) {
				WidgetHeader(title: "要対応", palette: palette)
				BigCount(value: "\(model.attentionCount)", unit: "件", palette: palette).padding(.top, 8)
				Text("許可待ち \(model.count("approve"))\n質問 \(model.count("question"))")
					.font(.system(size: 11))
					.foregroundStyle(palette.dim)
					.padding(.top, 4)
				Spacer(minLength: 0)
				if let freshness = model.freshness {
					Text(freshness)
						.font(.system(size: 11))
						.foregroundStyle(palette.muted)
						.lineLimit(2)
				}
			}
			.frame(width: 88, alignment: .leading)
			VStack(spacing: 8) {
				if rows.isEmpty {
					AllDoneCard(palette: palette, compact: true)
				} else {
					ForEach(rows) { agent in
						// 行（見出し）は Link、右端のボタンはその外に置く（Link の中にボタンを入れると押し分けられない）。
						HStack(spacing: 8) {
							Link(destination: model.sessionURL(agent)) {
								HStack(spacing: 8) {
									StateGlyph(state: agent.state, palette: palette)
									VStack(alignment: .leading, spacing: 1) {
										Text(model.title(agent))
											.font(.system(size: 13, weight: .semibold))
											.foregroundStyle(palette.text)
											.lineLimit(1)
											.privacySensitive()
										Text(model.stateMeta(agent))
											.font(.system(size: 11))
											.foregroundStyle(palette.dim)
											.lineLimit(1)
									}
									Spacer(minLength: 0)
								}
								.frame(maxHeight: .infinity)
								.contentShape(Rectangle())
							}
							AgentActionButton(model: model, agent: agent, palette: palette)
						}
						.padding(.horizontal, 10)
						.frame(maxWidth: .infinity, maxHeight: .infinity)
						.background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(palette.panel))
					}
					if rows.count == 1 {
						Spacer(minLength: 0).frame(maxHeight: .infinity)
					}
				}
			}
			.frame(maxWidth: .infinity, maxHeight: .infinity)
			.opacity(model.offline ? 0.5 : 1)
		}
		.widgetURL(model.attentionURL)
	}
}

@available(iOS 17.0, *)
struct AllDoneCard: View {
	let palette: WidgetPalette
	var compact = false

	var body: some View {
		VStack(spacing: compact ? 6 : 8) {
			Image(systemName: "checkmark")
				.font(.system(size: compact ? 18 : 24, weight: .semibold))
				.foregroundStyle(palette.green)
				.widgetAccentable()
			Text("すべて完了しています")
				.font(.system(size: compact ? 13 : 14))
				.foregroundStyle(compact ? palette.dim : palette.text)
			if !compact {
				Text("新しい質問や許可が来るとここに出ます")
					.font(.system(size: 11))
					.foregroundStyle(palette.dim)
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(palette.panel))
	}
}

@available(iOS 17.0, *)
private struct AttentionLarge: View {
	let model: ParaWidgetModel
	let palette: WidgetPalette

	var body: some View {
		let showDetail = model.showDetail
		let rows = Array(model.attentionRows.prefix(showDetail ? 3 : 4))
		VStack(alignment: .leading, spacing: 0) {
			WidgetHeader(title: "要対応", palette: palette) {
				if let pc = model.pc { PcBadge(pc: pc, palette: palette) }
			}
			HStack(alignment: .firstTextBaseline, spacing: 8) {
				BigCount(value: "\(model.attentionCount)", unit: "件", palette: palette)
				Spacer(minLength: 0)
				Text("許可待ち \(model.count("approve")) ・ 質問 \(model.count("question")) ・ 実行中 \(model.count("running")) ・ 未確認 \(model.count("unread"))")
					.font(.system(size: 11))
					.foregroundStyle(palette.dim)
					.lineLimit(1)
					.minimumScaleFactor(0.8)
			}
			.padding(.top, 8)
			.padding(.bottom, 10)
			VStack(spacing: 6) {
				if rows.isEmpty {
					AllDoneCard(palette: palette).frame(height: 190)
				} else {
					ForEach(rows) { agent in
						VStack(alignment: .leading, spacing: 4) {
							HStack(spacing: 8) {
								Link(destination: model.sessionURL(agent)) {
									HStack(spacing: 8) {
										StateGlyph(state: agent.state, palette: palette)
										VStack(alignment: .leading, spacing: 1) {
											Text(model.title(agent))
												.font(.system(size: 13, weight: .semibold))
												.foregroundStyle(palette.text)
												.lineLimit(1)
												.privacySensitive()
											Text(largeMeta(agent))
												.font(.system(size: 11))
												.foregroundStyle(palette.dim)
												.lineLimit(1)
												.privacySensitive()
										}
										Spacer(minLength: 0)
									}
									.contentShape(Rectangle())
								}
								AgentActionButton(model: model, agent: agent, palette: palette)
							}
							if showDetail, agent.isAttention {
								Link(destination: model.sessionURL(agent)) {
									DetailBox(agent: agent, palette: palette)
								}
							}
						}
						.padding(.horizontal, 10)
						.padding(.vertical, 8)
						.frame(maxWidth: .infinity, alignment: .leading)
						.background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(palette.panel))
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
				ReviewAllButton(model: model, palette: palette)
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.widgetURL(model.attentionURL)
	}

	private func largeMeta(_ agent: WidgetAgent) -> String {
		var parts = [WidgetText.kindLabel(agent.kind)]
		if let space = model.spaceName(id: agent.spaceId) {
			parts.append(space)
		}
		parts.append(model.stateMeta(agent))
		return parts.joined(separator: " ・ ")
	}
}

/// 質問文・コマンドの箱。要約に入っていないとき（アプリの設定がオフ）は、どこで表示を許すかを書く。
@available(iOS 17.0, *)
struct DetailBox: View {
	let agent: WidgetAgent
	let palette: WidgetPalette

	var body: some View {
		Text(agent.detail ?? "設定 → ウィジェットで表示をオンにすると出ます")
			.font(.system(size: 11))
			.foregroundStyle(agent.detail != nil ? palette.text : palette.muted)
			.lineLimit(2)
			.padding(.horizontal, 8)
			.padding(.vertical, 6)
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(palette.raised))
			.privacySensitive()
	}
}

// MARK: - ロック画面

@available(iOS 17.0, *)
private struct AttentionCircular: View {
	let model: ParaWidgetModel

	var body: some View {
		ZStack {
			AccessoryWidgetBackground()
			VStack(spacing: 0) {
				ParaLogo(size: 11, color: .white)
				Text(model.offline ? "-" : "\(model.attentionCount)")
					.font(.system(size: 26, weight: .semibold))
					.minimumScaleFactor(0.6)
				Text("要対応").font(.system(size: 10)).opacity(0.8)
			}
		}
		.widgetURL(WidgetLink.attention)
		.accessibilityLabel(model.offline ? "PC オフライン" : "要対応 \(model.attentionCount) 件")
	}
}

@available(iOS 17.0, *)
private struct AttentionRectangular: View {
	let model: ParaWidgetModel

	var body: some View {
		let first = model.firstAttention
		VStack(alignment: .leading, spacing: 1) {
			HStack(spacing: 4) {
				ParaLogo(size: 12, color: .white)
				Text(model.offline ? "オフライン" : "要対応 \(model.attentionCount)").font(.headline)
			}
			if let first {
				// 名前は、ロック中に内容を隠す設定ならぼかす（privacySensitive）。
				Text(model.title(first)).lineLimit(1).privacySensitive()
				Text(model.offline ? (model.freshness ?? "") : "\(WidgetText.stateLabel(first.state))\(model.elapsed(first).map { " ・ \($0)前" } ?? "")")
					.lineLimit(1)
					.foregroundStyle(.secondary)
			} else {
				Text("要対応はありません").lineLimit(1)
				Text("実行中 \(model.count("running")) ・ 未確認 \(model.count("unread"))").lineLimit(1).foregroundStyle(.secondary)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.widgetURL(model.attentionURL)
	}
}

@available(iOS 17.0, *)
private struct AttentionInline: View {
	let model: ParaWidgetModel

	var body: some View {
		Label(model.offline ? "PC オフライン" : "要対応 \(model.attentionCount) ・ 実行中 \(model.count("running"))", systemImage: "p.square")
			.widgetURL(WidgetLink.attention)
	}
}
