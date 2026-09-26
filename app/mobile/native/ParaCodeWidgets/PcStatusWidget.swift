// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
//
// 案 C「PC の状態」: PC が生きているか、使いすぎていないか。電池・CPU・メモリ・SSD・今日のコスト・利用上限。
// 見た目は paracode-widgets-mock.html の WC / accCirc / accRect / accInline（d === 'C'）。
// 出す指標と並びはアプリの設定（設定 → ウィジェット）。中サイズの利用上限はウィジェット側の設定を優先する。
// 数値はアプリが開いていた時の値なので、下端に「◯分前」を必ず出す。

import AppIntents
import SwiftUI
import WidgetKit

@available(iOS 17.0, *)
struct PcStatusWidget: Widget {
	var body: some WidgetConfiguration {
		AppIntentConfiguration(kind: WidgetKinds.pcStatus, intent: PcStatusConfigIntent.self, provider: PcStatusProvider()) { entry in
			PcStatusWidgetView(entry: entry)
		}
		.configurationDisplayName("PC の状態")
		.description("PC の電池・負荷・今日のコスト・利用上限を確かめます。")
		.supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline])
	}
}

@available(iOS 17.0, *)
struct PcStatusProvider: AppIntentTimelineProvider {
	func placeholder(in context: Context) -> ParaWidgetEntry {
		ParaWidgetTimeline.sample()
	}

	func snapshot(for configuration: PcStatusConfigIntent, in context: Context) async -> ParaWidgetEntry {
		ParaWidgetTimeline.current(config: configuration.resolved, context: context)
	}

	func timeline(for configuration: PcStatusConfigIntent, in context: Context) async -> Timeline<ParaWidgetEntry> {
		Timeline(entries: ParaWidgetTimeline.entries(config: configuration.resolved), policy: .atEnd)
	}
}

@available(iOS 17.0, *)
extension PcStatusConfigIntent {
	var resolved: ParaWidgetConfig {
		var config = ParaWidgetConfig()
		if let id = pc?.id, id != WidgetPcEntity.activeId {
			config.pcId = id
		}
		switch limit {
		case .claude: config.limitTarget = "claude"
		case .codex: config.limitTarget = "codex"
		case .appDefault: config.limitTarget = nil
		}
		return config
	}
}

/// 指標1つぶんの表示材料。
struct PcMetric: Identifiable {
	let id: String
	let label: String
	let short: String
	let value: String
	/// バーやリングに使う 0〜100。無ければバーを出さない。
	let percent: Double?
	/// 警告の度合い（0 平常 / 1 警告 / 2 危険）。
	let level: Int
	let sub: String?
}

@available(iOS 17.0, *)
extension ParaWidgetModel {
	static let limitKeys: Set<String> = ["claude5h", "claudeWeek", "codex5h", "codexWeek"]

	func metric(_ key: String) -> PcMetric? {
		guard let pc else { return nil }
		let resources = pc.resources
		switch key {
		case "battery":
			guard let battery = pc.battery else {
				return PcMetric(id: key, label: "電源", short: "電池", value: "電源", percent: nil, level: 0, sub: "電源に接続")
			}
			let level = battery.level <= 10 ? 2 : battery.level <= 20 ? 1 : 0
			return PcMetric(id: key, label: "電池", short: "電池", value: "\(battery.level)%", percent: Double(battery.level), level: level, sub: battery.charging ? "充電中" : nil)
		case "cpu":
			guard let cpu = resources?.cpu else { return nil }
			return PcMetric(id: key, label: "CPU", short: "CPU", value: "\(Int(cpu.rounded()))%", percent: cpu, level: cpu >= 92 ? 2 : cpu >= 75 ? 1 : 0, sub: nil)
		case "memory":
			guard let mem = resources?.memPercent else { return nil }
			let total = resources?.memTotal.map { WidgetText.bytes($0) }
			return PcMetric(id: key, label: "メモリ", short: "メモリ", value: "\(Int(mem.rounded()))%", percent: mem, level: mem >= 92 ? 2 : mem >= 78 ? 1 : 0, sub: total)
		case "disk":
			guard let free = resources?.diskFree else { return nil }
			let total = resources?.diskTotal ?? 0
			let used = total > 0 ? (total - free) / total * 100 : nil
			let gb = free / 1_073_741_824
			let level = gb <= 10 ? 2 : gb <= 25 ? 1 : (used ?? 0) >= 96 ? 2 : (used ?? 0) >= 88 ? 1 : 0
			return PcMetric(id: key, label: "SSD の空き", short: "SSD 空き", value: WidgetText.bytes(free), percent: used, level: level, sub: nil)
		case "cost":
			guard let cost = pc.usage?.todayCost else { return nil }
			return PcMetric(id: key, label: "今日のコスト", short: "今日", value: WidgetText.cost(cost), percent: nil, level: 0, sub: nil)
		default:
			guard Self.limitKeys.contains(key), let limit = pc.usage?.limits.first(where: { $0.key == key }) else { return nil }
			let reset = WidgetText.until(limit.resetsAt, now: now).map { "\($0)にリセット" }
			let short = limit.label.replacingOccurrences(of: "5時間", with: "5h")
			return PcMetric(id: key, label: limit.label, short: short, value: "\(Int(limit.usedPercent.rounded()))%", percent: limit.usedPercent, level: limit.usedPercent >= 90 ? 2 : limit.usedPercent >= 70 ? 1 : 0, sub: reset)
		}
	}

	/// 設定で選んだ指標（取れているものだけ、設定の並びで）。
	var metrics: [PcMetric] {
		settings.pc.metrics.compactMap { metric($0) }
	}

	/// 中サイズに1つだけ出す利用上限。ウィジェット側で選んでいればその 5 時間の枠、無ければ設定の先頭の上限。
	var primaryLimit: PcMetric? {
		if let target = entry.config.limitTarget {
			return metric("\(target)5h") ?? metric("\(target)Week")
		}
		return settings.pc.metrics.filter { Self.limitKeys.contains($0) }.lazy.compactMap { metric($0) }.first
	}

	var systemURL: URL {
		guard let pc else { return WidgetLink.attention }
		// 使用量の画面はアプリで見ている PC を出すので、別の PC ならその PC の画面を開く。
		return pc.id == entry.snapshot?.activePcId ? WidgetLink.system(pc.id) : WidgetLink.pc(pc.id)
	}

	var usageAgo: String? {
		guard let at = pc?.usage?.fetchedAt else { return nil }
		return "コストと上限は\(WidgetText.ago(at, now: now))に取得"
	}
}

@available(iOS 17.0, *)
private func levelColor(_ level: Int, _ palette: WidgetPalette) -> Color {
	level >= 2 ? palette.red : level == 1 ? palette.yellow : palette.text
}

@available(iOS 17.0, *)
struct PcStatusWidgetView: View {
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
			UnpairedWidgetView(family: family, label: "PC の状態", noData: model.noData, palette: palette)
		} else {
			switch family {
			case .accessoryCircular: PcCircular(model: model)
			case .accessoryRectangular: PcRectangular(model: model)
			case .accessoryInline:
				Label("\(model.pcName)\(model.pc?.battery.map { " \($0.level)%" } ?? "")", systemImage: "laptopcomputer")
					.privacySensitive()
					.widgetURL(model.systemURL)
			case .systemSmall: PcSmall(model: model, palette: palette)
			case .systemMedium: PcMedium(model: model, palette: palette)
			default: PcLarge(model: model, palette: palette)
			}
		}
	}
}

@available(iOS 17.0, *)
private struct PcSmall: View {
	let model: ParaWidgetModel
	let palette: WidgetPalette

	var body: some View {
		let tiles = Array(model.metrics.prefix(4))
		VStack(alignment: .leading, spacing: 8) {
			WidgetHeader(title: model.offline ? "オフライン" : model.pcName, palette: palette, privateTitle: !model.offline)
			LazyVGrid(columns: [GridItem(.flexible(), spacing: 6), GridItem(.flexible(), spacing: 6)], spacing: 6) {
				ForEach(tiles) { metric in
					VStack(alignment: .leading, spacing: 2) {
						Text(metric.short).font(.system(size: 11)).foregroundStyle(palette.dim).lineLimit(1)
						Spacer(minLength: 0)
						Text(metric.value)
							.font(.system(size: 19, weight: .semibold))
							.tracking(-0.4)
							.foregroundStyle(levelColor(metric.level, palette))
							.lineLimit(1)
							.minimumScaleFactor(0.6)
							.widgetAccentable()
					}
					.padding(.horizontal, 9)
					.padding(.vertical, 8)
					.frame(maxWidth: .infinity, minHeight: 50, alignment: .leading)
					.background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(palette.panel))
				}
			}
			.opacity(model.offline ? 0.5 : 1)
			Spacer(minLength: 0)
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.widgetURL(model.systemURL)
	}
}

/// 度合い（0 平常 / 1 警告 / 2 危険）を指定して描く横棒（SSD のように、使用率と空き容量の厳しいほうで色を決めるもの）。
@available(iOS 17.0, *)
private struct LevelBar: View {
	let percent: Double
	let level: Int
	let palette: WidgetPalette

	var body: some View {
		GeometryReader { proxy in
			ZStack(alignment: .leading) {
				Capsule().fill(palette.raised)
				Capsule()
					.fill(levelColor(level, palette))
					.frame(width: max(5, proxy.size.width * CGFloat(min(100, max(0, percent)) / 100)))
					.widgetAccentable()
			}
		}
		.frame(height: 5)
	}
}

@available(iOS 17.0, *)
private struct MetricBarRow: View {
	let metric: PcMetric
	let palette: WidgetPalette

	var body: some View {
		VStack(alignment: .leading, spacing: 3) {
			HStack {
				Text(metric.label)
				Spacer(minLength: 4)
				Text(metric.sub.map { "\(metric.value) ・ \($0)" } ?? metric.value)
			}
			.font(.system(size: 11))
			.foregroundStyle(palette.dim)
			.lineLimit(1)
			if let percent = metric.percent {
				LevelBar(percent: percent, level: metric.level, palette: palette)
			}
		}
	}
}

@available(iOS 17.0, *)
private struct PcMedium: View {
	let model: ParaWidgetModel
	let palette: WidgetPalette

	var body: some View {
		let chosen = Set(model.settings.pc.metrics)
		let bars = model.metrics.filter { $0.id == "cpu" || $0.id == "memory" }.prefix(2)
		HStack(spacing: 12) {
			VStack(alignment: .leading, spacing: 3) {
				WidgetHeader(title: model.offline ? "オフライン" : "接続中", palette: palette)
				Text(model.pcName)
					.font(.system(size: 14, weight: .semibold))
					.foregroundStyle(palette.text)
					.lineLimit(1)
					.padding(.top, 6)
					.privacySensitive()
				if chosen.contains("battery") {
					HStack(spacing: 5) {
						if let battery = model.pc?.battery {
							BatteryGlyphView(level: battery.level, palette: palette)
							Text("\(battery.level)%").font(.system(size: 15, weight: .semibold)).foregroundStyle(palette.text)
						} else {
							Text("電源に接続").font(.system(size: 11)).foregroundStyle(palette.dim)
						}
					}
				}
				Spacer(minLength: 0)
				Text("要対応 \(model.attentionCount) ・ 実行中 \(model.count("running"))")
					.font(.system(size: 11))
					.foregroundStyle(palette.dim)
					.lineLimit(1)
				if let freshness = model.freshness {
					Text(freshness).font(.system(size: 11)).foregroundStyle(palette.muted).lineLimit(1)
				}
			}
			.frame(width: 118, alignment: .leading)
			VStack(alignment: .leading, spacing: 8) {
				ForEach(Array(bars)) { metric in
					VStack(alignment: .leading, spacing: 3) {
						HStack {
							Text(metric.label)
							Spacer(minLength: 2)
							Text(metric.value)
						}
						.font(.system(size: 11))
						.foregroundStyle(palette.dim)
						MeterBar(percent: metric.percent ?? 0, warn: metric.id == "cpu" ? 75 : 78, critical: 92, palette: palette)
					}
				}
				if let disk = model.metrics.first(where: { $0.id == "disk" }) {
					Text("空き \(disk.value)").font(.system(size: 11)).foregroundStyle(palette.dim)
				}
			}
			.frame(maxWidth: .infinity, maxHeight: .infinity)
			.opacity(model.offline ? 0.5 : 1)
			VStack(alignment: .leading, spacing: 4) {
				if chosen.contains("cost") {
					Text("今日のコスト").font(.system(size: 11)).foregroundStyle(palette.dim)
					Text(WidgetText.cost(model.pc?.usage?.todayCost))
						.font(.system(size: 20, weight: .semibold))
						.tracking(-0.4)
						.foregroundStyle(palette.text)
						.widgetAccentable()
				}
				if let limit = model.primaryLimit {
					Text("\(limit.label) \(limit.value)").font(.system(size: 11)).foregroundStyle(palette.dim).lineLimit(1).padding(.top, 4)
					MeterBar(percent: limit.percent ?? 0, warn: 70, critical: 90, palette: palette)
					if let sub = limit.sub {
						Text(sub).font(.system(size: 11)).foregroundStyle(palette.muted).lineLimit(2)
					}
				}
			}
			.frame(width: 104, alignment: .leading)
			.frame(maxHeight: .infinity)
			.opacity(model.offline ? 0.5 : 1)
		}
		.widgetURL(model.systemURL)
	}
}

@available(iOS 17.0, *)
private struct MetricRing: View {
	let metric: PcMetric
	let palette: WidgetPalette

	var body: some View {
		VStack(spacing: 4) {
			ZStack {
				Circle().stroke(palette.raised, lineWidth: 6)
				Circle()
					.trim(from: 0, to: CGFloat(min(100, max(0, metric.percent ?? 100)) / 100))
					.stroke(levelColor(metric.level, palette), style: StrokeStyle(lineWidth: 6, lineCap: .round))
					.rotationEffect(.degrees(-90))
					.widgetAccentable()
				Text(metric.id == "battery" && metric.percent == nil ? "AC" : metric.value)
					.font(.system(size: 15, weight: .semibold))
					.foregroundStyle(palette.text)
					.minimumScaleFactor(0.7)
			}
			.frame(width: 60, height: 60)
			Text(metric.sub.map { "\(metric.label) \($0)" } ?? metric.label)
				.font(.system(size: 11))
				.foregroundStyle(palette.dim)
				.lineLimit(1)
		}
	}
}

@available(iOS 17.0, *)
private struct PcLarge: View {
	let model: ParaWidgetModel
	let palette: WidgetPalette

	var body: some View {
		let chosen = Set(model.settings.pc.metrics)
		let rings = model.metrics.filter { $0.id == "battery" || $0.id == "cpu" || $0.id == "memory" }.prefix(3)
		let limits = model.metrics.filter { ParaWidgetModel.limitKeys.contains($0.id) }
		let usage = model.pc?.usage
		VStack(alignment: .leading, spacing: 0) {
			WidgetHeader(title: model.pcName, palette: palette, privateTitle: true) {
				if let pc = model.pc { PcBadge(pc: pc, palette: palette) }
			}
			VStack(alignment: .leading, spacing: 0) {
				if !rings.isEmpty {
					HStack {
						ForEach(Array(rings)) { metric in
							Spacer(minLength: 0)
							MetricRing(metric: metric, palette: palette)
							Spacer(minLength: 0)
						}
					}
					.padding(.top, 10)
					.padding(.bottom, 4)
				}
				if let disk = model.metrics.first(where: { $0.id == "disk" }) {
					MetricBarRow(metric: disk, palette: palette).padding(.top, 6)
				}
				if chosen.contains("cost") {
					SectionTitle(text: "今日のコスト", palette: palette)
					HStack(alignment: .firstTextBaseline) {
						Text(WidgetText.cost(usage?.todayCost))
							.font(.system(size: 20, weight: .semibold))
							.foregroundStyle(palette.text)
							.widgetAccentable()
						Spacer(minLength: 4)
						Text("Claude \(WidgetText.cost(usage?.costClaude)) ・ Codex \(WidgetText.cost(usage?.costCodex))")
							.font(.system(size: 11))
							.foregroundStyle(palette.dim)
							.lineLimit(1)
					}
					if let total = usage?.todayCost, total > 0 {
						GeometryReader { proxy in
							HStack(spacing: 0) {
								Rectangle().fill(palette.text).frame(width: proxy.size.width * CGFloat((usage?.costClaude ?? 0) / total))
								Rectangle().fill(palette.text.opacity(0.45)).frame(width: proxy.size.width * CGFloat((usage?.costCodex ?? 0) / total))
								Spacer(minLength: 0)
							}
							.background(palette.raised)
							.clipShape(Capsule())
						}
						.frame(height: 5)
						.padding(.top, 4)
					}
				}
				if !limits.isEmpty {
					SectionTitle(text: "利用上限", palette: palette)
					VStack(alignment: .leading, spacing: 5) {
						ForEach(limits.prefix(4)) { limit in
							VStack(alignment: .leading, spacing: 3) {
								HStack {
									Text(limit.label)
									Spacer(minLength: 4)
									Text(limit.sub.map { "\(limit.value) ・ \($0)" } ?? limit.value)
								}
								.font(.system(size: 11))
								.foregroundStyle(palette.dim)
								.lineLimit(1)
								MeterBar(percent: limit.percent ?? 0, warn: 70, critical: 90, palette: palette)
							}
						}
					}
				}
			}
			.opacity(model.offline ? 0.5 : 1)
			Spacer(minLength: 0)
			HStack {
				Text(model.offline ? (model.freshness ?? "オフライン") : "要対応 \(model.attentionCount) ・ 実行中 \(model.count("running"))")
				Spacer(minLength: 4)
				if let ago = model.usageAgo {
					Text(ago)
				}
			}
			.font(.system(size: 11))
			.foregroundStyle(palette.muted)
			.lineLimit(1)
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.widgetURL(model.systemURL)
	}
}

@available(iOS 17.0, *)
struct SectionTitle: View {
	let text: String
	let palette: WidgetPalette
	var body: some View {
		Text(text)
			.font(.system(size: 11, weight: .medium))
			.foregroundStyle(palette.muted)
			.padding(.top, 10)
			.padding(.bottom, 4)
	}
}

@available(iOS 17.0, *)
private struct PcCircular: View {
	let model: ParaWidgetModel

	var body: some View {
		Group {
			if let battery = model.pc?.battery {
				Gauge(value: Double(battery.level), in: 0...100) {
					Text("PC 電池")
				} currentValueLabel: {
					Text("\(battery.level)")
				}
				.gaugeStyle(.accessoryCircular)
			} else {
				ZStack {
					AccessoryWidgetBackground()
					VStack(spacing: 0) {
						Text("AC").font(.system(size: 20, weight: .semibold))
						Text("PC 電源").font(.system(size: 10)).opacity(0.8)
					}
				}
			}
		}
		.widgetURL(model.systemURL)
	}
}

@available(iOS 17.0, *)
private struct PcRectangular: View {
	let model: ParaWidgetModel

	var body: some View {
		let pc = model.pc
		VStack(alignment: .leading, spacing: 1) {
			HStack(spacing: 4) {
				ParaLogo(size: 12, color: .white)
				Text(model.pcName).font(.headline).lineLimit(1).privacySensitive()
			}
			if model.offline {
				Text(model.freshness ?? "オフライン").lineLimit(1)
			} else {
				let battery = pc?.battery.map { "電池 \($0.level)%" } ?? "電源"
				let cpu = pc?.resources?.cpu.map { " ・ CPU \(Int($0.rounded()))%" } ?? ""
				Text("\(battery)\(cpu)").lineLimit(1)
			}
			let limit = model.primaryLimit.map { " ・ 上限 \($0.value)" } ?? ""
			Text("今日 \(WidgetText.cost(pc?.usage?.todayCost))\(limit)").lineLimit(1).foregroundStyle(.secondary)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.widgetURL(model.systemURL)
	}
}
