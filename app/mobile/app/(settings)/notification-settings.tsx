// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { ScreenHeader } from '../../src/components/screenHeader.js';
import { SectionHeader } from '../../src/components/sectionHeader.js';
import { SettingsCard, SettingsRow } from '../../src/components/settingsRow.js';
import { VoiceNotificationControl } from '../../src/components/voiceNotificationControl.js';
import { useStableInsets } from '../../src/hooks/useStableInsets.js';
import { useContentColumnStyle } from '../../src/ipad/useContentColumn.js';
import { colors, type } from '../../src/theme.js';
import { hapticSelection } from '../../src/haptics.js';

/**
 * 「通知と音声」画面。設定 →「通知と音声」から開く。
 *
 * 以前は通知まわりが3か所に分かれていた（設定の「通知」セクション、PCの下の無題のカードにあった
 * 「他のPCからの通知も出す」、ホームの … メニューの音声通知）。ここに1つにまとめる。
 * ホームの … メニューからの音声通知の入口は、すぐ開始・停止したい人のためにそのまま残っている。
 *
 * スイッチはどれもOSのバナーを止めるだけで、通知そのものはアプリ内の一覧に残る。
 */
export default function NotificationSettingsScreen() {
	const insets = useStableInsets();
	// ヘッダーは本文の上に浮いているので、その実測高さぶんだけ本文の頭を空ける
	const [headerHeight, setHeaderHeight] = useState(0);
	// iPadの広い幅では本文を読みやすい列幅に収める（iPhoneでは無変化）
	const column = useContentColumnStyle();
	const [voiceSheetOpen, setVoiceSheetOpen] = useState(false);
	const { notifyPrefs, setNotifyPref, notifyOtherPcs, setNotifyOtherPcs, voice } = useAppStore(useShallow(s => ({
		notifyPrefs: s.notifyPrefs, setNotifyPref: s.setNotifyPref,
		notifyOtherPcs: s.notifyOtherPcs, setNotifyOtherPcs: s.setNotifyOtherPcs,
		voice: s.voiceNotifications,
	})));

	const toggle = (key: 'agentDone' | 'agentQuestion' | 'suppressWhenPcFocused') => (value: boolean) => {
		hapticSelection();
		setNotifyPref(key, value);
	};

	// 開始していても、繋がるまでは「受信中」と言い切らない（シートの状態表示と同じ区別）。
	const voiceValue = !voice.desired ? 'オフ'
		: voice.status === 'live' ? '受信中'
			: voice.status === 'error' || voice.status === 'unsupported' ? '開始できず' : '接続中';

	return (
		<View style={styles.screen}>
			<ScreenHeader title="通知と音声" onHeightChange={setHeaderHeight} />
			<ScrollView style={styles.scroll} contentContainerStyle={[{ paddingTop: headerHeight, paddingBottom: insets.bottom + 24 }, column]}>
				<SectionHeader first title="バナー" />
				<SettingsCard>
					<SettingsRow
						title="作業完了を通知"
						description="エージェントの作業が終わったときにバナーを出します"
						right={<Switch value={notifyPrefs.agentDone} onValueChange={toggle('agentDone')} trackColor={{ true: colors.accent2 }} />}
					/>
					<SettingsRow
						title="質問を通知"
						description="エージェントから質問・承認要求があったときにバナーを出します"
						right={<Switch value={notifyPrefs.agentQuestion} onValueChange={toggle('agentQuestion')} trackColor={{ true: colors.accent2 }} />}
					/>
				</SettingsCard>

				<SectionHeader title="鳴らす条件" />
				<SettingsCard>
					<SettingsRow
						title="PC作業中は鳴らさない"
						description="PCを操作している間はバナーを出しません"
						right={<Switch value={notifyPrefs.suppressWhenPcFocused} onValueChange={toggle('suppressWhenPcFocused')} trackColor={{ true: colors.accent2 }} />}
					/>
					<SettingsRow
						title="他のPCからの通知も出す"
						description="アプリを開いている間の話です。オフにすると、いま見ているPCの通知だけがバナーで出ます（アプリを閉じている間はどのPCからも届きます）"
						right={(
							<Switch
								value={notifyOtherPcs}
								onValueChange={value => { hapticSelection(); setNotifyOtherPcs(value); }}
								trackColor={{ true: colors.accent2 }}
							/>
						)}
					/>
				</SettingsCard>
				<Text style={styles.note}>
					どれもバナーを止めるだけで、通知そのものは届きます（ホーム右上のベルからあとで読み返せます）。このアプリでそのエージェントの画面を開いている間も、同じ内容のバナーは出しません。
				</Text>

				<SectionHeader title="音声" />
				<SettingsCard>
					<SettingsRow
						icon="volume-high-outline"
						title="音声通知"
						description="PCで流れる読み上げの音声を、この端末でも再生します"
						value={voiceValue}
						onPress={() => { hapticSelection(); setVoiceSheetOpen(true); }}
					/>
				</SettingsCard>
			</ScrollView>
			{/* 開始・停止はホームの … メニューと同じシートで行う（状態と操作を1か所に保つ）。 */}
			<VoiceNotificationControl visible={voiceSheetOpen} onClose={() => setVoiceSheetOpen(false)} />
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	scroll: { flex: 1, paddingHorizontal: 16 },
	note: { color: colors.textDim, fontSize: type.meta, lineHeight: 18, marginTop: 10, paddingHorizontal: 4 },
});
