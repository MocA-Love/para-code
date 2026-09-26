// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import SwiftUI
import WidgetKit

@main
struct ParaCodeWidgetsBundle: WidgetBundle {
	var body: some Widget {
		// Live Activity（案 D「状態で切り替え」）。本体は ParaCodeLiveActivity.swift。
		ParaCodeLiveActivity()
		// ホーム画面・ロック画面のウィジェット（案 A〜D）。設定とボタンに iOS 17 の App Intents を使うため 17 以上だけ。
		// 中身は App Group の要約（WidgetShared.swift）を読むだけで、PC やリレーには繋がない。
		if #available(iOS 17.0, *) {
			AttentionWidget()
			AgentsWidget()
			PcStatusWidget()
			SpaceWidget()
		}
	}
}
