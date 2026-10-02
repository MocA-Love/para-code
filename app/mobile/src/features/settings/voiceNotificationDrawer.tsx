// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import { Lock, Monitor, Play, Radio, Square, Volume2, LayoutGrid } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../appState.js';
import { haptic } from '../../haptics.js';
import { colors, radius, space, type } from '../../theme.js';
import type { VoiceNotificationStatus } from './settingsSummary.js';
import { BottomDrawer, Button, DrawerTitle, Icon, ListGroup, ListRow, StatusDot } from '../../ui/index.js';

/** 状態の呼び名（旧 `voiceNotificationControl.tsx` と同じ）。 */
const STATUS_LABELS: Record<VoiceNotificationStatus, string> = {
	idle: '停止中',
	connecting: '接続しています',
	live: '音声通知を受信中',
	reconnecting: '再接続しています',
	unsupported: 'このビルドでは利用できません',
	error: '開始できませんでした',
};

/** 状態を示す丸の大きさ（pt）。 */
const HERO_SIZE = 64;

/**
 * 音声通知の開始・停止（旧 `src/components/voiceNotificationControl.tsx` のシートを BottomDrawer に作り直したもの）。
 * PC で流れる読み上げを、この端末でも再生する。開始・停止の処理は既存の
 * `startVoiceNotifications` / `stopVoiceNotifications`（`src/appState.ts`）。
 */
export function VoiceNotificationDrawer({ visible, onClose }: { visible: boolean; onClose: () => void }) {
	const { voice, pcOnline, start, stop } = useAppStore(useShallow(state => ({
		voice: state.voiceNotifications,
		pcOnline: state.pcOnline,
		start: state.startVoiceNotifications,
		stop: state.stopVoiceNotifications,
	})));
	const busy = voice.status === 'connecting';
	const active = voice.desired;
	const toggle = () => {
		haptic('commit');
		if (active) {
			stop();
		} else {
			start();
		}
	};
	return (
		<BottomDrawer visible={visible} onClose={onClose} accessibilityLabel="音声通知">
			<DrawerTitle title="音声通知" />
			<View style={styles.hero}>
				<View style={[styles.heroIcon, active ? styles.heroIconActive : undefined]}>
					{busy ? <ActivityIndicator color={colors.textDim} /> : <Icon icon={active ? Radio : Volume2} size={iconHero} color={active ? colors.text : colors.textDim} />}
				</View>
				<Text style={styles.status}>{STATUS_LABELS[voice.status]}</Text>
				<Text style={styles.description}>
					{active
						? 'PC で作られた読み上げの音声を、この端末でも再生します。画面を閉じても受信を続けます。'
						: '必要なときだけ開始すると、PC で流れる読み上げの音声をこの端末でも聞けます。'}
				</Text>
			</View>
			<ListGroup>
				<ListRow icon={Monitor} label="接続中の PC" hint={pcOnline ? 'オンライン' : 'オフライン・接続待ち'} trailing={<StatusDot kind={pcOnline ? 'connected' : 'offline'} />} />
				<ListRow icon={LayoutGrid} label="対象" hint="すべてのスペース" />
				<ListRow icon={Lock} label="再生について" hint="開始後はロック画面から停止できます" />
			</ListGroup>
			{voice.error !== undefined ? <Text style={styles.error}>{voice.error}</Text> : null}
			{Platform.OS !== 'ios' ? <Text style={styles.note}>いまは iOS 版だけで使えます。</Text> : null}
			<Button
				variant={active ? 'secondary' : 'primary'}
				icon={busy || active ? Square : Play}
				label={busy ? '開始をキャンセル' : active ? '音声通知を停止' : '音声通知を開始'}
				onPress={toggle}
				style={styles.button}
			/>
			<Text style={styles.note}>開始しない限り、この端末では音声を再生しません。</Text>
		</BottomDrawer>
	);
}

/** 状態の丸の中のアイコン（pt）。 */
const iconHero = 28;

const styles = StyleSheet.create({
	hero: {
		alignItems: 'center',
		paddingTop: space.xs,
		paddingBottom: space.lg,
	},
	heroIcon: {
		width: HERO_SIZE,
		height: HERO_SIZE,
		borderRadius: radius.pill,
		backgroundColor: colors.raised,
		alignItems: 'center',
		justifyContent: 'center',
	},
	heroIconActive: {
		backgroundColor: colors.borderStrong,
	},
	status: {
		marginTop: space.md,
		fontSize: type.heading,
		fontWeight: '700',
		color: colors.text,
	},
	description: {
		marginTop: space.sm,
		fontSize: type.body,
		lineHeight: 20,
		color: colors.textDim,
		textAlign: 'center',
		paddingHorizontal: space.sm,
	},
	error: {
		marginTop: space.md,
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.red,
		textAlign: 'center',
	},
	button: {
		marginTop: space.lg,
	},
	note: {
		marginTop: space.sm,
		fontSize: type.meta,
		color: colors.textMuted,
		textAlign: 'center',
	},
});
