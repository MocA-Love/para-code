// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import ActivityKit
import SwiftUI
import UIKit
import WidgetKit

@main
struct ParaCodeWidgetsBundle: WidgetBundle {
	var body: some Widget {
		ParaCodeLiveActivity()
	}
}

private let brandCyan = Color(red: 0.04, green: 0.69, blue: 0.85) // #09AFD9

/// Para Code の Live Activity（plan.html「B-2確定デザイン」）。
/// Dynamic Island コンパクト/ミニマル面は従来通り「ロゴ + 応答待ち/実行中カウント」。
/// 展開面とロック画面は、稼働数の内訳をステータスリング（案B）で示し、ヘッダーに
/// PC本体のバッテリーピル（B-2）を添える。低残量（非充電・20%未満）は文言を出さず、
/// 枠の赤リング（keyline / ロック画面の縁取り）とピルの赤字だけで示す。
struct ParaCodeLiveActivity: Widget {
	var body: some WidgetConfiguration {
		ActivityConfiguration(for: ParaCodeActivityAttributes.self) { context in
			// ロック画面 / 通知バナー
			LockScreenView(context: context)
				.activityBackgroundTint(Color.black.opacity(0.55))
				.activitySystemActionForegroundColor(.white)
		} dynamicIsland: { context in
			DynamicIsland {
				DynamicIslandExpandedRegion(.leading) {
					LogoBadge()
						.padding(.leading, 4)
				}
				DynamicIslandExpandedRegion(.trailing) {
					if let battery = context.state.battery {
						BatteryPill(battery: battery)
							.padding(.trailing, 4)
					}
				}
				DynamicIslandExpandedRegion(.bottom) {
					VStack(alignment: .leading, spacing: 8) {
						StatusRingRow(state: context.state)
						ForEach(Array(waitingAgents(context.state).enumerated()), id: \.offset) { _, agent in
							AgentRowView(agent: agent)
						}
						if let question = context.state.questionPreview, !question.isEmpty {
							Text(question)
								.font(.caption)
								.foregroundStyle(.white.opacity(0.85))
								.lineLimit(2)
								.padding(8)
								.frame(maxWidth: .infinity, alignment: .leading)
								.background(RoundedRectangle(cornerRadius: 10).fill(Color.red.opacity(0.14)))
						}
					}
					.padding(.top, 4)
				}
			} compactLeading: {
				LogoBadge()
			} compactTrailing: {
				CountsView(state: context.state)
			} minimal: {
				if context.state.waitingCount > 0 {
					Text("\(context.state.waitingCount)")
						.font(.caption2.bold())
						.foregroundStyle(.red)
				} else {
					Image(systemName: "play.circle.fill")
						.font(.system(size: 12))
						.foregroundStyle(.green)
						.frame(width: 14, height: 14)
				}
			}
			// 低残量時は展開面の縁（keyline）を赤にして異常を示す（B-2: 文言警告は出さない）
			.keylineTint(isBatteryLow(context.state.battery) ? Color.red : brandCyan)
		}
	}
}

/// 低残量判定（非充電 かつ 20%未満）。
private func isBatteryLow(_ battery: ParaCodeActivityAttributes.Battery?) -> Bool {
	guard let battery else {
		return false
	}
	return !battery.charging && battery.level < 20
}

/// 展開面に出す応答待ち行（agents は応答待ち優先で最大2件届く）。
private func waitingAgents(_ state: ParaCodeActivityAttributes.ContentState) -> [ParaCodeActivityAttributes.AgentRow] {
	state.agents.filter { $0.status == "waiting" }
}

private struct LogoBadge: View {
	var body: some View {
		// ホームタブのPCカードと同じPara Codeロゴ（paracode-logo.png、Extension同梱リソース。
		// 元画像は app/mobile/assets/pairing-logo.png の縮小コピー）。
		// リソースが見つからないビルド（手動復元漏れ等）ではターミナルシンボルへフォールバック。
		if let logo = UIImage(named: "paracode-logo") {
			Image(uiImage: logo)
				.resizable()
				.scaledToFit()
				.frame(width: 18, height: 18)
				.clipShape(RoundedRectangle(cornerRadius: 4))
		} else {
			Image(systemName: "apple.terminal")
				.font(.system(size: 14, weight: .bold))
				.foregroundStyle(brandCyan)
		}
	}
}

/// コンパクト面のカウント（従来デザインを維持。バッテリーはここでは表示しない）。
private struct CountsView: View {
	let state: ParaCodeActivityAttributes.ContentState
	var body: some View {
		HStack(spacing: 7) {
			if state.waitingCount > 0 {
				HStack(spacing: 3) {
					Circle().fill(.red).frame(width: 7, height: 7)
					Text("\(state.waitingCount)").font(.caption.bold()).foregroundStyle(.white)
				}
				.frame(height: 16)
			}
			if state.runningCount > 0 {
				HStack(spacing: 3) {
					Image(systemName: "arrow.triangle.2.circlepath")
						.font(.system(size: 11))
						.foregroundStyle(.green)
						.frame(width: 12, height: 12)
					Text("\(state.runningCount)").font(.caption.bold()).foregroundStyle(.white)
				}
				.frame(height: 16)
			}
			if state.waitingCount == 0 && state.runningCount == 0 {
				Image(systemName: "checkmark.circle.fill")
					.font(.caption)
					.foregroundStyle(.green)
					.frame(height: 16)
			}
		}
	}
}

/// ステータスリング（案B）: 中央が合計稼働数、周囲のリングが応答待ち(赤)/実行中(緑)の割合。
private struct StatusRing: View {
	let waitingCount: Int
	let runningCount: Int
	var body: some View {
		let total = waitingCount + runningCount
		let waitingFraction = total > 0 ? CGFloat(waitingCount) / CGFloat(total) : 0
		ZStack {
			Circle()
				.stroke(Color.green, lineWidth: 6)
			Circle()
				.trim(from: 0, to: waitingFraction)
				.stroke(Color.red, style: StrokeStyle(lineWidth: 6, lineCap: .butt))
				.rotationEffect(.degrees(-90))
			Text("\(total)")
				.font(.system(size: 16, weight: .heavy))
				.foregroundStyle(.white)
		}
		.frame(width: 50, height: 50)
	}
}

/// リング + 「N体稼働中 / 内訳」のテキストを並べた行（展開面）。
private struct StatusRingRow: View {
	let state: ParaCodeActivityAttributes.ContentState
	var body: some View {
		let total = state.waitingCount + state.runningCount
		HStack(spacing: 12) {
			StatusRing(waitingCount: state.waitingCount, runningCount: state.runningCount)
			VStack(alignment: .leading, spacing: 2) {
				Text(state.waitingCount > 0 ? "\(total)体稼働中" : "\(total)体実行中")
					.font(.footnote.bold())
					.foregroundStyle(.white)
				Text(state.waitingCount > 0 ? "応答待ち \(state.waitingCount) ・ 実行中 \(state.runningCount)" : "応答待ちなし")
					.font(.caption2)
					.foregroundStyle(.white.opacity(0.6))
			}
			Spacer(minLength: 0)
		}
	}
}

/// バッテリーピル（B-2）: 電池グリフ + 残量%。充電中は⚡を先頭に付け、低残量は赤字。
private struct BatteryPill: View {
	let battery: ParaCodeActivityAttributes.Battery
	var body: some View {
		let low = isBatteryLow(battery)
		HStack(spacing: 4) {
			if battery.charging {
				Image(systemName: "bolt.fill")
					.font(.system(size: 9))
					.foregroundStyle(.yellow)
			}
			BatteryGlyph(level: battery.level, low: low, charging: battery.charging)
			Text("\(battery.level)%")
				.font(.caption2.bold())
				.foregroundStyle(low ? Color.red : .white)
		}
	}
}

/// 電池アイコン（外枠 + 残量バー + 端子）。SF Symbolsの電池は段階が粗いため自前で描く。
private struct BatteryGlyph: View {
	let level: Int
	let low: Bool
	let charging: Bool
	var body: some View {
		let outline = low ? Color.red.opacity(0.7) : Color.white.opacity(0.55)
		let fill = low ? Color.red : (charging ? Color.yellow : Color.green)
		HStack(spacing: 1) {
			ZStack(alignment: .leading) {
				RoundedRectangle(cornerRadius: 2.5)
					.stroke(outline, lineWidth: 1.2)
					.frame(width: 19, height: 10)
				RoundedRectangle(cornerRadius: 1)
					.fill(fill)
					.frame(width: max(1.5, 15 * CGFloat(level) / 100), height: 6)
					.padding(.leading, 2)
			}
			RoundedRectangle(cornerRadius: 0.8)
				.fill(outline)
				.frame(width: 2, height: 4)
		}
	}
}

private struct AgentRowView: View {
	let agent: ParaCodeActivityAttributes.AgentRow
	var body: some View {
		HStack(spacing: 8) {
			Circle()
				.fill(agent.status == "waiting" ? Color.red : Color.green)
				.frame(width: 8, height: 8)
			VStack(alignment: .leading, spacing: 1) {
				Text(agent.name).font(.caption.bold()).foregroundStyle(.white).lineLimit(1)
				Text(agent.ws).font(.caption2).foregroundStyle(.white.opacity(0.6)).lineLimit(1)
			}
			Spacer(minLength: 0)
			Text(agent.status == "waiting" ? "応答待ち" : "実行中")
				.font(.caption2.bold())
				.foregroundStyle(agent.status == "waiting" ? .red : .green)
				.padding(.horizontal, 8)
				.padding(.vertical, 3)
				.background(Capsule().fill((agent.status == "waiting" ? Color.red : Color.green).opacity(0.16)))
		}
	}
}

private struct LockScreenView: View {
	let context: ActivityViewContext<ParaCodeActivityAttributes>
	var body: some View {
		let state = context.state
		let total = state.waitingCount + state.runningCount
		let hidden = total - min(2, state.agents.count)
		let low = isBatteryLow(state.battery)
		VStack(alignment: .leading, spacing: 8) {
			HStack(spacing: 8) {
				LogoBadge()
				Text("Para Code").font(.footnote.bold()).foregroundStyle(.white)
				Spacer(minLength: 0)
			}
			HStack(spacing: 6) {
				Text(context.attributes.pcName)
					.font(.caption2)
					.foregroundStyle(.white.opacity(0.6))
				if let battery = state.battery {
					Text("・")
						.font(.caption2)
						.foregroundStyle(.white.opacity(0.3))
					BatteryPill(battery: battery)
				}
			}
			.padding(.leading, 26)
			.padding(.top, -6)
			ForEach(Array(state.agents.prefix(2).enumerated()), id: \.offset) { _, agent in
				AgentRowView(agent: agent)
			}
			if hidden > 0 {
				Text("ほか\(hidden)体が稼働中")
					.font(.caption2)
					.foregroundStyle(.white.opacity(0.45))
			}
			if let question = state.questionPreview, !question.isEmpty {
				Text(question)
					.font(.caption)
					.foregroundStyle(.white.opacity(0.9))
					.lineLimit(2)
					.padding(9)
					.frame(maxWidth: .infinity, alignment: .leading)
					.background(RoundedRectangle(cornerRadius: 11).fill(Color.red.opacity(0.13)))
			}
		}
		.padding(14)
		// 低残量（非充電・20%未満）は文言を出さず縁取りの赤リングだけで示す（B-2）
		.overlay(
			RoundedRectangle(cornerRadius: 22)
				.stroke(Color.red.opacity(low ? 0.5 : 0), lineWidth: 1.5)
				.padding(1)
		)
	}
}
