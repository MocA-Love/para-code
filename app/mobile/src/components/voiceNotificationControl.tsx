// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { BottomSheet } from './bottomSheet.js';
import { colors, radius } from '../theme.js';
import { hapticImpact } from '../haptics.js';

const STATUS_LABELS = {
	idle: '停止中',
	connecting: '接続しています',
	live: '音声通知を受信中',
	reconnecting: '再接続しています',
	unsupported: 'このビルドでは利用できません',
	error: '開始できませんでした',
} as const;

/** モックA: ヘッダーの音声ボタンと、開始・停止を行うボトムシート。 */
export function VoiceNotificationControl() {
	const [visible, setVisible] = useState(false);
	const { voice, pcOnline, start, stop } = useAppStore(useShallow(state => ({
		voice: state.voiceNotifications,
		pcOnline: state.pcOnline,
		start: state.startVoiceNotifications,
		stop: state.stopVoiceNotifications,
	})));
	const busy = voice.status === 'connecting';
	const active = voice.desired;

	const toggle = () => {
		hapticImpact('medium');
		if (active) {
			stop();
		} else {
			start();
		}
	};

	return (
		<>
			{/* ヘッダー右のガラスのピルの中に入るので、ここでガラスを重ねない（Apple HIG）。
			    受信中はアクセント色の淡い地でそれと分かるようにする。 */}
			<Pressable
				style={({ pressed }) => [styles.headerButton, active && styles.headerButtonActive, pressed && styles.headerButtonPressed]}
				hitSlop={{ top: 5, bottom: 5, left: 4, right: 4 }}
				onPress={() => { hapticImpact('light'); setVisible(true); }}
				accessibilityRole="button"
				accessibilityLabel={active ? '音声通知を受信中' : '音声通知を開始'}
			>
				<Ionicons name={active ? 'volume-high' : 'volume-high-outline'} size={17} color={active ? colors.accent : colors.text} />
				{active ? <View style={styles.liveBadge} /> : null}
			</Pressable>

			<BottomSheet visible={visible} onClose={() => setVisible(false)} title="音声通知" glass>
				<ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
					<View style={styles.hero}>
						<View style={[styles.heroIcon, active && styles.heroIconActive]}>
							{busy ? (
								<ActivityIndicator size="small" color={colors.accent} />
							) : (
								<Ionicons name={active ? 'radio' : 'volume-high-outline'} size={30} color={active ? colors.accent : colors.textDim} />
							)}
						</View>
						<Text style={styles.status}>{STATUS_LABELS[voice.status]}</Text>
						<Text style={styles.description}>
							{active
								? 'Macで作られたAivisの音声を、このiPhoneでも再生します。画面を閉じても受信を続けます。'
								: '必要なときだけ開始すると、Macで流れるAivisの音声をこのiPhoneでも聞けます。'}
						</Text>
					</View>

					<View style={styles.infoCard}>
						<View style={styles.infoRow}>
							<Ionicons name="desktop-outline" size={18} color={pcOnline ? colors.green : colors.textDim} />
							<View style={styles.infoText}>
								<Text style={styles.infoTitle}>接続中のPC</Text>
								<Text style={styles.infoValue}>{pcOnline ? 'オンライン' : 'オフライン・接続待ち'}</Text>
							</View>
							<View style={[styles.connectionDot, pcOnline && styles.connectionDotOnline]} />
						</View>
						<View style={styles.divider} />
						<View style={styles.infoRow}>
							<Ionicons name="apps-outline" size={18} color={colors.textDim} />
							<View style={styles.infoText}>
								<Text style={styles.infoTitle}>対象</Text>
								<Text style={styles.infoValue}>すべてのスペース</Text>
							</View>
						</View>
						<View style={styles.divider} />
						<View style={styles.infoRow}>
							<Ionicons name="lock-closed-outline" size={18} color={colors.textDim} />
							<View style={styles.infoText}>
								<Text style={styles.infoTitle}>再生について</Text>
								<Text style={styles.infoValue}>開始後はロック画面から停止できます</Text>
							</View>
						</View>
					</View>

					{voice.error ? <Text style={styles.errorText}>{voice.error}</Text> : null}
					{Platform.OS !== 'ios' ? <Text style={styles.platformNote}>現在はiOS版のみ対応しています。Android版は後日対応予定です。</Text> : null}

					<Pressable
						style={({ pressed }) => [styles.primaryButton, active && styles.stopButton, pressed && styles.pressed]}
						onPress={toggle}
						accessibilityRole="button"
						accessibilityLabel={busy ? '音声通知の開始をキャンセル' : active ? '音声通知を停止' : '音声通知を開始'}
					>
						{busy ? <Ionicons name="stop" size={17} color={colors.text} /> : <Ionicons name={active ? 'stop' : 'play'} size={17} color={active ? colors.text : colors.bg} />}
						<Text style={[styles.primaryText, active && styles.stopText]}>{busy ? '開始をキャンセル' : active ? '音声通知を停止' : '音声通知を開始'}</Text>
					</Pressable>
					<Text style={styles.footnote}>開始しない限り、iPhoneでは音声を再生しません。</Text>
				</ScrollView>
			</BottomSheet>
		</>
	);
}

const styles = StyleSheet.create({
	headerButton: { width: 34, height: 34, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
	headerButtonActive: { backgroundColor: colors.accentWash },
	headerButtonPressed: { backgroundColor: 'rgba(255,255,255,0.16)' },
	liveBadge: { position: 'absolute', top: 0, right: 0, width: 9, height: 9, borderRadius: 5, backgroundColor: colors.green, borderWidth: 2, borderColor: colors.bg },
	content: { paddingHorizontal: 20, paddingBottom: 28, gap: 16 },
	hero: { alignItems: 'center', paddingTop: 8, paddingBottom: 4 },
	heroIcon: { width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border },
	heroIconActive: { backgroundColor: colors.accentWash, borderColor: colors.accent + '66' },
	status: { marginTop: 14, color: colors.text, fontSize: 19, fontWeight: '800' },
	description: { marginTop: 8, maxWidth: 330, color: colors.textDim, fontSize: 13, lineHeight: 20, textAlign: 'center' },
	infoCard: { paddingHorizontal: 15, borderRadius: 18, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border },
	infoRow: { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 12 },
	infoText: { flex: 1, gap: 3 },
	infoTitle: { color: colors.text, fontSize: 13, fontWeight: '700' },
	infoValue: { color: colors.textDim, fontSize: 11 },
	connectionDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.textDim },
	connectionDotOnline: { backgroundColor: colors.green },
	divider: { height: StyleSheet.hairlineWidth, marginLeft: 30, backgroundColor: colors.borderStrong },
	errorText: { color: colors.red, fontSize: 12, lineHeight: 18, textAlign: 'center' },
	platformNote: { color: colors.yellow, fontSize: 11, lineHeight: 17, textAlign: 'center' },
	primaryButton: { height: 52, borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, backgroundColor: colors.accent },
	stopButton: { backgroundColor: colors.surface3, borderWidth: 1, borderColor: colors.borderStrong },
	pressed: { opacity: 0.75 },
	primaryText: { color: colors.bg, fontSize: 14, fontWeight: '800' },
	stopText: { color: colors.text },
	footnote: { color: colors.textDim, fontSize: 10, textAlign: 'center' },
});
