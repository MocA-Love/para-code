// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { Activity, Bell, Info, ListChecks, MessageSquare, MessageSquareReply, Monitor, Palette, Terminal } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { APP_VERSION } from '../../src/components/updateSheet.js';
import { hapticSelection } from '../../src/haptics.js';
import { notificationSettingsSummary } from '../../src/notificationSettingsSummary.js';
import { routes, type RouteHref } from '../../src/routes.js';
import { ListGroup, ListRow, THEME_COLOR_SLOTS, isDefaultThemeColor, useThemeColorStore } from '../../src/ui/index.js';
import { effectiveSessionView, useSessionViewPreference } from '../../src/features/settings/onboardingStore.js';
import { useQuickReplyList } from '../../src/features/settings/quickRepliesStore.js';
import { SettingsScreen } from '../../src/features/settings/settingsScaffold.js';
import { settingsRoutes } from '../../src/features/settings/settingsRoutes.js';

/**
 * 設定（`/settings`。Orca の settings のリスト、モックの「設定」）。
 * 1つの束に各ページへの行を並べ、行の右に今の状態を出して開かなくても分かるようにする。
 *
 * 並びはモックに合わせる（ターミナル → チャット UI → 通知と音声 → …）。チャット UI の下に、モックに無い
 * クイック返信（会話画面の入力欄の上のチップ）と色（主ボタン・自分の発言・リンクの色）を足している。モックの「音声」「通知」は
 * Para Code では1ページ（通知と音声）にまとまっている。Para Code に無いもの（トラブルシューティング・
 * プライバシーポリシー・サポート）は置かず、モックに無いコマンドプリセットを足している。
 */
export default function SettingsScreenRoute() {
	const router = useRouter();
	const { notifyPrefs, notifyOtherPcs, voiceDesired, fontSize, pcCount } = useAppStore(useShallow(s => ({
		notifyPrefs: s.notifyPrefs,
		notifyOtherPcs: s.notifyOtherPcs,
		voiceDesired: s.voiceNotifications.desired,
		fontSize: s.terminalPrefs.fontSize,
		pcCount: s.pcs.length,
	})));
	const sessionView = useSessionViewPreference(effectiveSessionView);
	const loadSessionView = useSessionViewPreference(s => s.load);
	useEffect(() => { void loadSessionView(); }, [loadSessionView]);
	const quickReplies = useQuickReplyList();
	const customColorCount = useThemeColorStore(s => THEME_COLOR_SLOTS.filter(slot => !isDefaultThemeColor(s.settings, slot)).length);
	const open = (href: RouteHref) => {
		hapticSelection();
		router.push(href);
	};
	return (
		<SettingsScreen title="設定">
			<ListGroup>
				<ListRow icon={Terminal} label="ターミナル" value={`${fontSize}pt`} trailing="chevron" onPress={() => open(routes.settings('terminal'))} />
				<ListRow icon={MessageSquare} label="チャット UI" value={sessionView === 'chat' ? 'チャット UI' : 'ターミナル'} trailing="chevron" onPress={() => open(settingsRoutes.sessionView())} />
				<ListRow
					icon={MessageSquareReply}
					label="クイック返信"
					value={quickReplies === undefined ? undefined : quickReplies.length > 0 ? `${quickReplies.length} 件` : 'なし'}
					trailing="chevron"
					onPress={() => open(settingsRoutes.quickReplies())}
				/>
				<ListRow
					icon={Palette}
					label="色"
					value={customColorCount > 0 ? `${customColorCount} か所を変更` : '既定'}
					trailing="chevron"
					onPress={() => open(settingsRoutes.colors())}
				/>
				<ListRow
					icon={Bell}
					label="通知と音声"
					value={notificationSettingsSummary({ agentDone: notifyPrefs.agentDone, agentQuestion: notifyPrefs.agentQuestion, notifyOtherPcs, voice: voiceDesired })}
					trailing="chevron"
					onPress={() => open(routes.settings('notifications'))}
				/>
				<ListRow icon={ListChecks} label="コマンドプリセット" trailing="chevron" onPress={() => open(routes.settings('presets'))} />
				<ListRow icon={Activity} label="使用量" trailing="chevron" onPress={() => open(routes.settings('usage'))} />
				<ListRow icon={Monitor} label="PC" value={pcCount > 0 ? `${pcCount} 台` : undefined} trailing="chevron" onPress={() => open(routes.settings('pcs'))} />
				<ListRow icon={Info} label="このアプリについて" value={APP_VERSION} trailing="chevron" onPress={() => open(routes.settings('about'))} />
			</ListGroup>
		</SettingsScreen>
	);
}
