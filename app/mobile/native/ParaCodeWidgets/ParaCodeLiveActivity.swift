// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
//
// Para Code の Live Activity（案 D「状態で切り替え」。paracode-live-activity-mock.html の案 D）。
// 状態（要対応あり／実行中だけ／全部完了／PC オフライン）で、Dynamic Island の compact・minimal・expanded と
// ロック画面の形を切り替える。左に状態の印、右に数（expanded とロック画面は右に PC 名）という並びは
// 全状態で変えない（HIG: 展開しても配置を保つ）。中身は JS（src/liveActivityState.ts）が組み立てる。
//
// Apple の制約: Dynamic Island の背景は黒で固定（色はキーラインと文字だけ）。expanded とロック画面は高さ 160pt まで。
// アニメーションは使えない（回る輪は止まった輪で描く）。ボタン（許可）は段階 3 で expanded とロック画面にだけ足す。

import ActivityKit
import SwiftUI
import WidgetKit

// MARK: - 色（アプリの src/theme.ts のトークン）

private enum LiveColor {
	/// 要対応（theme.status.attention = colors.red）。
	static let attention = Color(hex: 0xEF4444)
	/// 実行中（theme.status.running = colors.yellow）。
	static let running = Color(hex: 0xEAB308)
	/// 完了・未確認（theme.status.review = colors.emerald）。
	static let done = Color(hex: 0x10B981)
	/// ツール名（colors.accent）。
	static let accent = Color(hex: 0x3B82F6)
	/// 本文（colors.text）。
	static let text = Color(hex: 0xE0E0E0)
	/// 古い・オフラインの色（colors.textDim）。
	static let grey = Color(hex: 0xA1A1A1)
	/// 古い・オフラインのキーライン。
	static let greyKeyline = Color(hex: 0x666666)
	/// コマンドの枠（colors.raised）。
	static let codeBg = Color(hex: 0x242424)
	/// 「アプリで回答」の枠。
	static let secondBg = Color(hex: 0x2E2E2E)
	/// ロック画面の背景（colors.bg を 84%）。
	static let lockBg = Color(hex: 0x111111).opacity(0.84)
	static let dim6 = Color.white.opacity(0.6)
	static let dim85 = Color.white.opacity(0.85)
}

private func dateFromMillis(_ ms: Double) -> Date {
	return Date(timeIntervalSince1970: ms / 1000)
}

// MARK: - 見え方の判断

private enum LiveShape {
	case attention, running, done
}

/// ContentState と「古いか」から、形・色・文言・行き先を決める。
private struct LiveModel {
	let state: ParaCodeActivityAttributes.ContentState
	let attributes: ParaCodeActivityAttributes
	let stale: Bool

	init(_ context: ActivityViewContext<ParaCodeActivityAttributes>) {
		state = context.state
		attributes = context.attributes
		stale = context.isStale
	}

	var offline: Bool { state.phase == "offline" }
	/// オフライン・古い表示（色を落とし、時計を止める）。
	var grey: Bool { offline || stale }

	/// 形。オフラインは直前の中身の形のまま灰色にする。
	var shape: LiveShape {
		switch state.phase {
		case "attention": return .attention
		case "running": return .running
		case "done": return .done
		default:
			if state.waitingCount > 0 { return .attention }
			if state.runningCount > 0 { return .running }
			return .done
		}
	}

	var color: Color {
		if grey { return LiveColor.grey }
		switch shape {
		case .attention: return LiveColor.attention
		case .running: return LiveColor.running
		case .done: return LiveColor.done
		}
	}

	var keyline: Color {
		return grey ? LiveColor.greyKeyline : color
	}

	var count: Int {
		switch shape {
		case .attention: return state.waitingCount
		case .running: return state.runningCount
		case .done: return state.doneCount
		}
	}

	var title: String {
		switch shape {
		case .attention: return "要対応"
		case .running: return "実行中"
		case .done: return "完了"
		}
	}

	/// 灰色のときに時計を止める時刻（オフラインは PC を最後に見た時刻、古いときは最後の更新）。
	var frozenAt: Double? {
		guard grey else { return nil }
		return offline ? (state.asOf ?? state.updatedAt) : state.updatedAt
	}

	/// 押したときの行き先。表示していた 1 件のセッションを直接開く（src/features/links/widgetLinks.ts）。
	var url: URL {
		let pc = attributes.pcId
		guard !pc.isEmpty else {
			// PC が分からない（以前の版で始めたもの）: 中継の画面で要対応の先頭を探す。
			return WidgetLink.attention
		}
		if offline {
			return WidgetLink.home
		}
		let at = dateFromMillis(state.updatedAt)
		switch shape {
		case .attention:
			if let item = state.attention.first {
				return WidgetLink.session(pc: pc, space: item.space, terminal: item.key, at: at)
			}
		case .running:
			if let item = state.running.first {
				return WidgetLink.session(pc: pc, space: item.space, terminal: item.key, at: at)
			}
		case .done:
			// 未確認はエージェントの一覧（PC の画面）で見る。
			return WidgetLink.pc(pc)
		}
		return WidgetLink.attention
	}
}

// MARK: - 文言

private enum LiveText {
	/// 「3分前」（止まった表示用）。
	static func ago(_ ms: Double, reference: Double) -> String {
		let minutes = Int(max(0, reference - ms) / 60_000)
		if minutes < 1 { return "たった今" }
		if minutes < 60 { return "\(minutes)分前" }
		let hours = minutes / 60
		if hours < 24 { return "\(hours)時間前" }
		return "\(hours / 24)日前"
	}

	/// 「12:40」「1:02:03」（止まった経過時間）。
	static func clock(_ ms: Double) -> String {
		let total = Int(max(0, ms) / 1000)
		let hours = total / 3600
		let minutes = (total % 3600) / 60
		let seconds = total % 60
		if hours > 0 {
			return String(format: "%d:%02d:%02d", hours, minutes, seconds)
		}
		return String(format: "%d:%02d", minutes, seconds)
	}

	/// 「12分40秒」「1時間5分」（かかった時間）。
	static func took(_ ms: Double) -> String {
		let total = Int(max(0, ms) / 1000)
		let hours = total / 3600
		let minutes = (total % 3600) / 60
		let seconds = total % 60
		if hours > 0 { return "\(hours)時間\(minutes)分" }
		if minutes > 0 { return String(format: "%d分%02d秒", minutes, seconds) }
		return "\(seconds)秒"
	}

	static func kindLabel(_ kind: String) -> String {
		return kind == "question" ? "質問" : "許可待ち"
	}
}

// MARK: - 部品

/// 状態の印（要対応 = 赤の丸に「!」、実行中 = 輪、完了 = 緑の丸にチェック、オフライン = 斜線の丸）。
private struct StateIcon: View {
	let model: LiveModel
	let size: CGFloat

	var body: some View {
		Group {
			if model.offline {
				Image(systemName: "slash.circle")
					.resizable()
					.foregroundStyle(LiveColor.grey)
			} else {
				switch model.shape {
				case .attention:
					Image(systemName: "exclamationmark.circle.fill")
						.resizable()
						.symbolRenderingMode(.palette)
						.foregroundStyle(Color.black, model.color)
				case .running:
					SpinnerRing(color: model.color, lineWidth: 2)
						.padding(size * 0.06)
				case .done:
					Image(systemName: "checkmark.circle.fill")
						.resizable()
						.symbolRenderingMode(.palette)
						.foregroundStyle(Color.black, model.color)
				}
			}
		}
		.frame(width: size, height: size)
	}
}

/// 実行中の輪（モックの .spin）。Live Activity では回せないので、4分の1だけ濃い止まった輪で描く。
private struct SpinnerRing: View {
	let color: Color
	let lineWidth: CGFloat

	var body: some View {
		ZStack {
			Circle().stroke(color.opacity(0.25), lineWidth: lineWidth)
			Circle()
				.trim(from: 0, to: 0.25)
				.stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
				.rotationEffect(.degrees(-90))
		}
	}
}

/// 経過時間（実行中の行）。灰色のときは止めた値を出す。
private struct ElapsedText: View {
	let since: Double?
	let frozenAt: Double?
	let font: Font
	let color: Color
	let width: CGFloat

	var body: some View {
		if let since {
			Group {
				if let frozenAt {
					Text(LiveText.clock(frozenAt - since))
				} else {
					Text(timerInterval: dateFromMillis(since)...Date.distantFuture, countsDown: false)
				}
			}
			.font(font)
			.monospacedDigit()
			.foregroundStyle(color)
			.multilineTextAlignment(.trailing)
			.frame(width: width, alignment: .trailing)
		}
	}
}

/// 「許可待ち · 3分前」。
private func statusLine(_ item: ParaCodeActivityAttributes.AttentionItem, model: LiveModel) -> Text {
	let label = Text(LiveText.kindLabel(item.kind))
	guard let since = item.since else {
		return label
	}
	if let frozenAt = model.frozenAt {
		return label + Text(" · \(LiveText.ago(since, reference: frozenAt))")
	}
	return label + Text(" · ") + Text(dateFromMillis(since), style: .relative) + Text("前")
}

/// 要対応の 1 件（名前・種類・経過と、コマンドまたは質問文）。段階 3 ではコマンドの右に「許可」ボタンを置く。
private struct RequestBlock: View {
	let item: ParaCodeActivityAttributes.AttentionItem
	let model: LiveModel

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			HStack(spacing: 8) {
				Text(item.name)
					.font(.system(size: 13, weight: .semibold))
					.foregroundStyle(LiveColor.text)
					.lineLimit(1)
					.privacySensitive()
				Spacer(minLength: 4)
				statusLine(item, model: model)
					.font(.system(size: 12))
					.foregroundStyle(LiveColor.dim6)
					.lineLimit(1)
			}
			if item.kind == "question" {
				HStack(spacing: 8) {
					Text(item.detail ?? "アプリで回答してください")
						.font(.system(size: 12))
						.foregroundStyle(LiveColor.dim85)
						.lineLimit(1)
						.privacySensitive()
					Spacer(minLength: 0)
					// 本体を押すとこのセッションが開く（ボタンではなく、行き先の目印）。
					Text("アプリで回答")
						.font(.system(size: 13, weight: .semibold))
						.foregroundStyle(LiveColor.text)
						.padding(.horizontal, 12)
						.padding(.vertical, 6)
						.background(Capsule().fill(LiveColor.secondBg))
				}
			} else if item.tool != nil || item.detail != nil {
				commandText
					.font(.system(size: 12, design: .monospaced))
					.lineLimit(1)
					.padding(.horizontal, 9)
					.padding(.vertical, 6)
					.frame(maxWidth: .infinity, alignment: .leading)
					.background(RoundedRectangle(cornerRadius: 10).fill(LiveColor.codeBg))
					.privacySensitive()
			}
		}
	}

	private var commandText: Text {
		let tool = item.tool.map { Text($0).foregroundColor(model.grey ? LiveColor.grey : LiveColor.accent) } ?? Text("")
		let gap = item.tool != nil && item.detail != nil ? Text(" ") : Text("")
		let detail = Text(item.detail ?? "").foregroundColor(LiveColor.text)
		return tool + gap + detail
	}
}

/// 要対応の下の「実行中 N · 名前  12:40」。
private struct RunLine: View {
	let model: LiveModel

	var body: some View {
		if model.state.runningCount > 0, let first = model.state.running.first {
			HStack(spacing: 8) {
				Circle()
					.fill(model.grey ? LiveColor.grey : LiveColor.running)
					.frame(width: 7, height: 7)
				Text("実行中 \(model.state.runningCount) · \(first.name)")
					.font(.system(size: 12))
					.foregroundStyle(LiveColor.dim6)
					.lineLimit(1)
					.privacySensitive()
				Spacer(minLength: 4)
				ElapsedText(since: first.since, frozenAt: model.frozenAt, font: .system(size: 12), color: LiveColor.dim6, width: 52)
			}
			.padding(.top, 7)
		}
	}
}

/// 実行中の 1 行（名前・経過時間と、最後のツールと対象）。
private struct RunRow: View {
	let item: ParaCodeActivityAttributes.RunningItem
	let model: LiveModel

	var body: some View {
		VStack(alignment: .leading, spacing: 1) {
			HStack(spacing: 8) {
				Circle()
					.fill(model.grey ? LiveColor.grey : LiveColor.running)
					.frame(width: 8, height: 8)
				Text(item.name)
					.font(.system(size: 13, weight: .semibold))
					.foregroundStyle(LiveColor.text)
					.lineLimit(1)
					.privacySensitive()
				Spacer(minLength: 4)
				ElapsedText(since: item.since, frozenAt: model.frozenAt, font: .system(size: 13, weight: .semibold), color: LiveColor.text, width: 56)
			}
			if let tool = item.tool {
				(Text(tool).foregroundColor(model.grey ? LiveColor.grey : LiveColor.accent) + Text(item.target.map { " \($0)" } ?? "").foregroundColor(LiveColor.dim6))
					.font(.system(size: 11, design: .monospaced))
					.lineLimit(1)
					.padding(.leading, 16)
					.privacySensitive()
			}
		}
		.padding(.top, 7)
	}
}

/// 右上の PC 名。灰色のときは「14:02 時点」。
private struct TrailingLabel: View {
	let model: LiveModel

	var body: some View {
		Group {
			if let frozenAt = model.frozenAt {
				Text(dateFromMillis(frozenAt), style: .time) + Text(" 時点")
			} else {
				Text(model.attributes.pcName)
			}
		}
		.font(.system(size: 12))
		.foregroundStyle(LiveColor.dim6)
		.lineLimit(1)
		.privacySensitive()
	}
}

/// 完了の要約（展開表示）。
private struct DoneSummary: View {
	let model: LiveModel

	var body: some View {
		let state = model.state
		VStack(alignment: .leading, spacing: 2) {
			if let first = state.done.first {
				Text(state.doneCount > 1 ? "\(first.name) ほか \(state.doneCount - 1) 件" : first.name)
					.font(.system(size: 13, weight: .semibold))
					.foregroundStyle(LiveColor.text)
					.lineLimit(1)
					.privacySensitive()
			}
			doneFootnote(state, includeLast: true)
				.font(.system(size: 12))
				.foregroundStyle(LiveColor.dim6)
				.lineLimit(1)
		}
		.padding(.top, 4)
		.frame(maxWidth: .infinity, alignment: .leading)
	}
}

/// 「未確認 3 · 最後の完了 1分前 · 14:41 に消えます」。
private func doneFootnote(_ state: ParaCodeActivityAttributes.ContentState, includeLast: Bool) -> Text {
	var text = Text("未確認 \(state.doneCount)")
	if includeLast, let at = state.done.first?.at {
		text = text + Text(" · 最後の完了 ") + Text(dateFromMillis(at), style: .relative) + Text("前")
	}
	if let endsAt = state.endsAt {
		text = text + Text(" · ") + Text(dateFromMillis(endsAt), style: .time) + Text(" に消えます")
	}
	return text
}

// MARK: - 電池（ロック画面の実行中の見出しに出す）

/// 残量の段階。色は残量だけを表し、充電しているかどうかは⚡の有無だけが表す。
/// 判定はJS側の `src/batteryLevel.ts` と同じにしておくこと（ドロワーとロック画面で色が食い違わないため）。
private enum BatteryLevelClass {
	case ok, warn, low

	var fillColor: Color {
		switch self {
		case .low: return LiveColor.attention
		case .warn: return LiveColor.running
		case .ok: return LiveColor.done
		}
	}
}

/// 10%以下は充電中でも赤（危険域を隠さない）。緑になる境目は充電中だけ高くする。
private func batteryLevelClass(level: Int, charging: Bool) -> BatteryLevelClass {
	if level <= 10 {
		return .low
	}
	return level > (charging ? 80 : 20) ? .ok : .warn
}

/// バッテリーピル: 電池グリフ + 残量%。充電中は⚡を先頭に付け、低残量は赤字。
private struct BatteryPill: View {
	let battery: ParaCodeActivityAttributes.Battery

	var body: some View {
		let level = batteryLevelClass(level: battery.level, charging: battery.charging)
		HStack(spacing: 4) {
			if battery.charging {
				Image(systemName: "bolt.fill")
					.font(.system(size: 9))
					.foregroundStyle(LiveColor.dim6)
			}
			BatteryGlyph(level: battery.level, levelClass: level)
			Text("\(battery.level)%")
				.font(.system(size: 11, weight: .bold))
				.foregroundStyle(level == .low ? LiveColor.attention : LiveColor.text)
		}
	}
}

/// 電池アイコン（外枠 + 残量バー + 端子）。SF Symbolsの電池は段階が粗いため自前で描く。
private struct BatteryGlyph: View {
	let level: Int
	let levelClass: BatteryLevelClass

	var body: some View {
		let outline = levelClass == .low ? LiveColor.attention.opacity(0.7) : Color.white.opacity(0.55)
		HStack(spacing: 1) {
			ZStack(alignment: .leading) {
				RoundedRectangle(cornerRadius: 2.5)
					.stroke(outline, lineWidth: 1.2)
					.frame(width: 19, height: 10)
				RoundedRectangle(cornerRadius: 1)
					.fill(levelClass.fillColor)
					.frame(width: max(1.5, 15 * CGFloat(level) / 100), height: 6)
					.padding(.leading, 2)
			}
			RoundedRectangle(cornerRadius: 0.8)
				.fill(outline)
				.frame(width: 2, height: 4)
		}
	}
}

// MARK: - ロック画面

private struct LockScreenView: View {
	let model: LiveModel

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			switch model.shape {
			case .attention:
				attention
			case .running:
				running
			case .done:
				done
			}
		}
		.padding(14)
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	private func header<Middle: View>(@ViewBuilder middle: () -> Middle) -> some View {
		HStack(spacing: 8) {
			StateIcon(model: model, size: model.shape == .running && !model.offline ? 14 : 16)
			Text("\(model.title) \(model.count)")
				.font(.system(size: 13, weight: .semibold))
				.foregroundStyle(model.color)
				.contentTransition(.numericText())
			middle()
			Spacer(minLength: 4)
			TrailingLabel(model: model)
		}
	}

	private var attention: some View {
		VStack(alignment: .leading, spacing: 0) {
			header {
				if model.state.attention.count > 1, let next = model.state.attention.last {
					Text("· 次 \(next.name)")
						.font(.system(size: 12))
						.foregroundStyle(LiveColor.dim6)
						.lineLimit(1)
						.frame(maxWidth: 150, alignment: .leading)
						.privacySensitive()
				}
			}
			if let item = model.state.attention.first {
				RequestBlock(item: item, model: model)
					.padding(.top, 7)
			}
			RunLine(model: model)
		}
	}

	private var running: some View {
		VStack(alignment: .leading, spacing: 0) {
			HStack(spacing: 8) {
				StateIcon(model: model, size: model.offline ? 16 : 14)
				Text("\(model.title) \(model.count)")
					.font(.system(size: 13, weight: .semibold))
					.foregroundStyle(model.color)
					.contentTransition(.numericText())
				Spacer(minLength: 4)
				TrailingLabel(model: model)
				if let battery = model.state.battery, !model.grey {
					BatteryPill(battery: battery)
						.padding(.leading, 6)
				}
			}
			ForEach(model.state.running.prefix(2), id: \.key) { item in
				RunRow(item: item, model: model)
			}
		}
	}

	private var done: some View {
		VStack(alignment: .leading, spacing: 0) {
			header { EmptyView() }
			ForEach(model.state.done.prefix(3), id: \.key) { item in
				HStack(spacing: 8) {
					Circle()
						.fill(model.grey ? LiveColor.grey : LiveColor.done)
						.frame(width: 8, height: 8)
					Text(item.name)
						.font(.system(size: 13, weight: .semibold))
						.foregroundStyle(LiveColor.text)
						.lineLimit(1)
						.privacySensitive()
					Spacer(minLength: 4)
					if let took = item.took {
						Text(LiveText.took(took))
							.font(.system(size: 12))
							.foregroundStyle(LiveColor.dim6)
					}
				}
				.padding(.top, 6)
			}
			doneFootnote(model.state, includeLast: false)
				.font(.system(size: 11))
				.foregroundStyle(LiveColor.dim6)
				.lineLimit(1)
				.padding(.top, 6)
		}
	}
}

// MARK: - Dynamic Island の expanded（下の段）

private struct ExpandedBottom: View {
	let model: LiveModel

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			switch model.shape {
			case .attention:
				if let item = model.state.attention.first {
					RequestBlock(item: item, model: model)
				}
				RunLine(model: model)
			case .running:
				ForEach(model.state.running.prefix(2), id: \.key) { item in
					RunRow(item: item, model: model)
				}
			case .done:
				DoneSummary(model: model)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}
}

// MARK: - minimal（26pt の輪と数）

private struct MinimalView: View {
	let model: LiveModel

	var body: some View {
		ZStack {
			if model.shape == .running && !model.grey {
				SpinnerRing(color: model.color, lineWidth: 2.5)
			} else {
				Circle().stroke(model.color, lineWidth: 3)
					.padding(1.5)
			}
			Text("\(model.count)")
				.font(.system(size: 12, weight: .bold))
				.monospacedDigit()
				.foregroundStyle(model.color)
				.contentTransition(.numericText())
		}
		.frame(width: 26, height: 26)
	}
}

// MARK: - 本体

struct ParaCodeLiveActivity: Widget {
	var body: some WidgetConfiguration {
		ActivityConfiguration(for: ParaCodeActivityAttributes.self) { context in
			let model = LiveModel(context)
			LockScreenView(model: model)
				.activityBackgroundTint(LiveColor.lockBg)
				.activitySystemActionForegroundColor(LiveColor.text)
				// 公式ガイドどおり、ロック画面・compact・minimal に同じ URL の widgetURL を付ける。
				.widgetURL(model.url)
		} dynamicIsland: { context in
			let model = LiveModel(context)
			return DynamicIsland {
				DynamicIslandExpandedRegion(.leading) {
					HStack(spacing: 6) {
						StateIcon(model: model, size: model.shape == .running && !model.offline ? 16 : 18)
						Text("\(model.title) \(model.count)")
							.font(.system(size: 15, weight: .semibold))
							.foregroundStyle(model.color)
							.lineLimit(1)
							.contentTransition(.numericText())
					}
					.padding(.leading, 4)
					.padding(.top, 4)
				}
				DynamicIslandExpandedRegion(.trailing) {
					TrailingLabel(model: model)
						.padding(.trailing, 4)
						.padding(.top, 6)
				}
				DynamicIslandExpandedRegion(.bottom) {
					ExpandedBottom(model: model)
						.padding(.top, 2)
				}
			} compactLeading: {
				StateIcon(model: model, size: model.shape == .running && !model.offline ? 14 : 16)
			} compactTrailing: {
				Text("\(model.count)")
					.font(.system(size: 15, weight: .semibold))
					.monospacedDigit()
					.foregroundStyle(model.color)
					.contentTransition(.numericText())
			} minimal: {
				MinimalView(model: model)
			}
			.widgetURL(model.url)
			.keylineTint(model.keyline)
		}
	}
}
