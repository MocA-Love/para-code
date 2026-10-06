// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useState } from 'react';
import { Linking } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
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
import { settingsRoutes } from '../../src/features/settings/settingsRoutes.js';
import { useUsageAutoRefresh, useUsageOverview } from '../../src/features/usage/usageStore.js';
import { groupVoiceUsage, voiceEmptyReason, voiceEmptyText, voiceSummaryHint } from '../../src/features/usage/voiceUsageModel.js';
import type { UsageKind } from '../../src/features/usage/usageAggregate.js';
import { useNow } from '../../src/time.js';
import { PcDoNotDisturbSection } from '../../src/features/doNotDisturb/pcDoNotDisturbSection.js';

const VOICE_KINDS: readonly UsageKind[] = ['voice'];

/** 「読み上げの使用量」の行の補足（残りと残高。無ければ、出ない理由）。 */
function useVoiceUsageHint(): string | undefined {
	const now = useNow();
	const overview = useUsageOverview({ resources: false });
	useUsageAutoRefresh(VOICE_KINDS);
	const entries = overview.entries.filter(entry => entry.kind === 'pc');
	const groups = groupVoiceUsage(entries, now);
	const summary = voiceSummaryHint(groups);
	if (summary !== undefined) {
		return summary;
	}
	const errors = entries.flatMap(entry => entry.sourceKeys.map(key => overview.errorOf(key, 'voice')).filter(error => error !== undefined));
	const reason = voiceEmptyReason({ groups, anyValue: entries.some(entry => entry.values.voice !== undefined), errors, loading: overview.isLoading('voice') });
	return reason === 'no-keys' || reason === 'update-pc' ? voiceEmptyText(reason) : undefined;
}

const PERMISSION_VALUE: Record<NotificationPermissionState, string> = {
	granted: '許可済み',
	denied: 'オフ',
	undetermined: '未設定',
};

/**
 * 通知と音声（`/settings/notifications`。モックの「通知」と「音声」、旧「通知と音声」画面）。
 *
 * スイッチはどれも OS のバナーを止めるだけで、通知そのものはアプリ内の一覧に残る。
 * 種類と条件と中身の4つ（`notifyPrefs`）は PC へ同期し、鳴らすか・本文に何を入れるかの判断は PC 側が持つ（`src/appState.ts`）。
 * 「他の PC からの通知も出す」はこの端末の中だけの判断。
 *
 * モックの「通知を有効にする」（全体のスイッチ）は、Para Code では OS の通知の許可そのものになる。
 * 許可はアプリから取り消せないので、スイッチではなく許可の状態を出す行にしている。
 *
 * 先頭の「PC のおやすみモード」は PC ごとに PC の音・デスクトップ通知・読み上げを止める（Q253 B）。この端末への
 * プッシュは止めない（Q228 A）。
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
	const router = useRouter();
	const voiceUsageHint = useVoiceUsageHint();
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
			<PcDoNotDisturbSection />

			<GroupHeader title="通知の許可" />
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

			<GroupHeader title="通知の中身" />
			<ListGroup>
				<ListRow
					label="通知に内容を含める"
					hint="完了は最後の発言、承認待ちはコマンド、質問は質問文を本文に出します"
					trailing={<SettingsSwitch value={notifyPrefs.includeContent} onValueChange={value => setNotifyPref('includeContent', value)} accessibilityLabel="通知に内容を含める" />}
				/>
			</ListGroup>
			<GroupNote after>オフにすると「エージェントが作業を完了しました」などの決まった文だけになります。ロック画面で隠すだけなら、設定アプリの「プレビューを表示」でも変えられます。</GroupNote>

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
				<ListRow
					label="読み上げの使用量"
					hint={voiceUsageHint}
					trailing="chevron"
					onPress={() => { haptic('move'); router.push(settingsRoutes.usageDetail('voice')); }}
				/>
			</ListGroup>
		</SettingsScreen>
	);
}
