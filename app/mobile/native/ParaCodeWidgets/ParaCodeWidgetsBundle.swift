// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import ActivityKit
import SwiftUI
import WidgetKit

@main
struct ParaCodeWidgetsBundle: WidgetBundle {
	var body: some Widget {
		ParaCodeLiveActivity()
	}
}

/// Para Code の Live Activity（live.html 案L1「ステータス集約型」）。
/// Dynamic Island コンパクト面は「ロゴ + 応答待ち/実行中カウント」、展開面と
/// ロック画面はエージェント行リスト。応答待ちが1件だけのときは質問文プレビューを出す。
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
					CountsView(state: context.state)
						.padding(.trailing, 4)
				}
				DynamicIslandExpandedRegion(.bottom) {
					VStack(alignment: .leading, spacing: 8) {
						ForEach(Array(context.state.agents.prefix(2).enumerated()), id: \.offset) { _, agent in
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
			.keylineTint(Color(red: 0.04, green: 0.69, blue: 0.85)) // ブランドシアン #09AFD9
		}
	}
}

private struct LogoBadge: View {
	var body: some View {
		Image(systemName: "apple.terminal")
			.font(.system(size: 14, weight: .bold))
			.foregroundStyle(Color(red: 0.04, green: 0.69, blue: 0.85))
	}
}

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
		VStack(alignment: .leading, spacing: 10) {
			HStack(spacing: 8) {
				LogoBadge()
				Text("Para Code").font(.footnote.bold()).foregroundStyle(.white)
				Spacer(minLength: 0)
				Text(context.attributes.pcName).font(.caption2).foregroundStyle(.white.opacity(0.6))
			}
			ForEach(Array(context.state.agents.prefix(2).enumerated()), id: \.offset) { _, agent in
				AgentRowView(agent: agent)
			}
			if let question = context.state.questionPreview, !question.isEmpty {
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
	}
}
