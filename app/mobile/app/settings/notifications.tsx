// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useState } from 'react';
import { Linking } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { useAppIsActive } from '../../src/hooks/useAppIsActive.js';
import { haptic } from '../../src/haptics.js';
import { ensureNotificationPermission } from '../../src/platform.js';
import { ListGroup, ListRow } from '../../src/ui/index.js';
import type { NotificationPermissionState } from '../../src/features/settings/onboardingPlan.js';
import { readNotificationPermission } from '../../src/features/settings/onboardingStore.js';
import { GroupHeader, GroupNote, SettingsScreen, SettingsSwitch } from '../../src/features/settings/settingsScaffold.js';
import { voiceNotificationValue } from '../../src/features/settings/settingsSummary.js';
import { VoiceNotificationDrawer } from '../../src/features/settings/voiceNotificationDrawer.js';

const PERMISSION_VALUE: Record<NotificationPermissionState, string> = {
	granted: '許可済み',
	denied: 'オフ',
	undetermined: '未設定',
};

/**
 * 通知と音声（`/settings/notifications`。モックの「通知」と「音声」、旧「通知と音声」画面）。
 *
 * スイッチはどれも OS のバナーを止めるだけで、通知そのものはアプリ内の一覧に残る。
 * 種類と条件の3つ（`notifyPrefs`）は PC へ同期し、鳴らすかの判断は PC 側が持つ（`src/appState.ts`）。
 * 「他の PC からの通知も出す」はこの端末の中だけの判断。
 *
 * モックの「通知を有効にする」（全体のスイッチ）は、Para Code では OS の通知の許可そのものになる。
 * 許可はアプリから取り消せないので、スイッチではなく許可の状態を出す行にしている。
 */
export default function NotificationSettingsScreen() {
	const { notifyPrefs, setNotifyPref, notifyOtherPcs, setNotifyOtherPcs, voice } = useAppStore(useShallow(s => ({
		notifyPrefs: s.notifyPrefs,
		setNotifyPref: s.setNotifyPref,
		notifyOtherPcs: s.notifyOtherPcs,
		setNotifyOtherPcs: s.setNotifyOtherPcs,
		voice: s.voiceNotifications,
	})));
	const [voiceOpen, setVoiceOpen] = useState(false);
	const [permission, setPermission] = useState<NotificationPermissionState | undefined>(undefined);
	// 設定アプリで許可を変えて戻ってきたときにも読み直す
	const appActive = useAppIsActive();
	useFocusEffect(useCallback(() => {
		if (!appActive) {
			return undefined;
		}
		let cancelled = false;
		void readNotificationPermission().then(next => {
			if (!cancelled) {
				setPermission(next);
			}
		});
		return () => { cancelled = true; };
	}, [appActive]));

	const onPermissionPress = () => {
		haptic('move');
		if (permission === 'undetermined') {
			void ensureNotificationPermission().then(granted => setPermission(granted ? 'granted' : 'denied'), () => undefined);
		} else {
			void Linking.openSettings();
		}
	};

	return (
		<SettingsScreen title="通知と音声" footer={<VoiceNotificationDrawer visible={voiceOpen} onClose={() => setVoiceOpen(false)} />}>
			<ListGroup>
				<ListRow
					label="通知の許可"
					hint={permission === 'denied' ? '設定アプリで許可すると、この端末に届きます' : undefined}
					value={permission !== undefined ? PERMISSION_VALUE[permission] : undefined}
					trailing="chevron"
					onPress={onPermissionPress}
				/>
			</ListGroup>
			<GroupNote after>エージェントがあなたの入力を待っているときや作業を終えたときに、この端末へ通知します。</GroupNote>

			<GroupHeader title="知らせる出来事" />
			<ListGroup>
				<ListRow
					label="許可待ち・質問"
					hint="要対応になったとき"
					trailing={<SettingsSwitch value={notifyPrefs.agentQuestion} onValueChange={value => setNotifyPref('agentQuestion', value)} accessibilityLabel="許可待ち・質問を通知" />}
				/>
				<ListRow
					label="完了"
					hint="作業が終わって未確認になったとき"
					trailing={<SettingsSwitch value={notifyPrefs.agentDone} onValueChange={value => setNotifyPref('agentDone', value)} accessibilityLabel="完了を通知" />}
				/>
			</ListGroup>

			<GroupHeader title="鳴らす条件" />
			<ListGroup>
				<ListRow
					label="PC の操作中は鳴らさない"
					hint="PC を操作している間はバナーを出しません"
					trailing={<SettingsSwitch value={notifyPrefs.suppressWhenPcFocused} onValueChange={value => setNotifyPref('suppressWhenPcFocused', value)} accessibilityLabel="PC の操作中は鳴らさない" />}
				/>
				<ListRow
					label="他の PC からの通知も出す"
					hint="アプリを開いている間の話です。オフにすると、いま見ている PC の通知だけがバナーで出ます"
					trailing={<SettingsSwitch value={notifyOtherPcs} onValueChange={setNotifyOtherPcs} accessibilityLabel="他の PC からの通知も出す" />}
				/>
			</ListGroup>
			<GroupNote after>どれもバナーを止めるだけで、通知そのものは届きます（ホームのベルからあとで読み返せます）。そのエージェントの画面を開いている間も、同じ内容のバナーは出しません。</GroupNote>

			<GroupHeader title="音声" />
			<ListGroup>
				<ListRow
					label="音声通知"
					hint="PC で流れる読み上げを、この端末でも再生します"
					value={voiceNotificationValue(voice)}
					trailing="chevron"
					onPress={() => { haptic('move'); setVoiceOpen(true); }}
				/>
			</ListGroup>
		</SettingsScreen>
	);
}
