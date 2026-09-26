// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import React, { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { BottomSheet } from './bottomSheet.js';
import { alpha, colors, radius, squircle, tint, type } from '../theme.js';
import { Button } from './button.js';
import { SettingsCard, SettingsRow } from './settingsRow.js';
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
export function VoiceNotificationControl({ visible, onClose }: {
	visible?: boolean;
	onClose?: () => void;
} = {}) {
	const [internalVisible, setInternalVisible] = useState(false);
	const { voice, pcOnline, start, stop } = useAppStore(useShallow(state => ({
		voice: state.voiceNotifications,
		pcOnline: state.pcOnline,
		start: state.startVoiceNotifications,
		stop: state.stopVoiceNotifications,
	})));
	const busy = voice.status === 'connecting';
	const active = voice.desired;
	const sheetVisible = visible ?? internalVisible;
	const closeSheet = () => {
		if (visible === undefined) {
			setInternalVisible(false);
		} else {
			onClose?.();
		}
	};

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
			{visible === undefined ? (
				<Pressable
					style={({ pressed }) => [styles.headerButton, active && styles.headerButtonActive, pressed && styles.headerButtonPressed]}
					hitSlop={{ top: 5, bottom: 5, left: 4, right: 4 }}
					onPress={() => { hapticImpact('light'); setInternalVisible(true); }}
					accessibilityRole="button"
					accessibilityLabel={active ? '音声通知を受信中' : '音声通知を開始'}
				>
					<Ionicons name={active ? 'volume-high' : 'volume-high-outline'} size={17} color={active ? colors.accent : colors.text} />
					{active ? <View style={styles.liveBadge} /> : null}
				</Pressable>
			) : null}

			<BottomSheet visible={sheetVisible} onClose={closeSheet} title="音声通知" glass>
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

					<SettingsCard style={styles.infoCard}>
						<SettingsRow
							icon="desktop-outline"
							iconColor={pcOnline ? colors.green : colors.textDim}
							title="接続中のPC"
							description={pcOnline ? 'オンライン' : 'オフライン・接続待ち'}
							right={<View style={[styles.connectionDot, pcOnline && styles.connectionDotOnline]} />}
						/>
						<SettingsRow icon="apps-outline" iconColor={colors.textDim} title="対象" description="すべてのスペース" />
						<SettingsRow icon="lock-closed-outline" iconColor={colors.textDim} title="再生について" description="開始後はロック画面から停止できます" />
					</SettingsCard>

					{voice.error ? <Text style={styles.errorText}>{voice.error}</Text> : null}
					{Platform.OS !== 'ios' ? <Text style={styles.platformNote}>現在はiOS版のみ対応しています。Android版は後日対応予定です。</Text> : null}

					<Button
						variant={active ? 'secondary' : 'primary'}
						icon={busy || active ? 'stop' : 'play'}
						label={busy ? '開始をキャンセル' : active ? '音声通知を停止' : '音声通知を開始'}
						onPress={toggle}
						accessibilityLabel={busy ? '音声通知の開始をキャンセル' : active ? '音声通知を停止' : '音声通知を開始'}
					/>
					<Text style={styles.footnote}>開始しない限り、iPhoneでは音声を再生しません。</Text>
				</ScrollView>
			</BottomSheet>
		</>
	);
}

const styles = StyleSheet.create({
	headerButton: { width: 34, height: 34, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
	headerButtonActive: { backgroundColor: colors.accentWash },
	headerButtonPressed: { backgroundColor: colors.borderStrong },
	liveBadge: { position: 'absolute', top: 0, right: 0, width: 9, height: 9, borderRadius: radius.pill, ...squircle, backgroundColor: colors.green, borderWidth: 2, borderColor: colors.bg },
	content: { paddingHorizontal: 20, paddingBottom: 28, gap: 16 },
	hero: { alignItems: 'center', paddingTop: 8, paddingBottom: 4 },
	heroIcon: { width: 68, height: 68, borderRadius: radius.pill, ...squircle, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border },
	heroIconActive: { backgroundColor: colors.accentWash, borderColor: tint(colors.accent, alpha.line) },
	status: { marginTop: 14, color: colors.text, fontSize: type.large, fontWeight: '800' },
	description: { marginTop: 8, maxWidth: 330, color: colors.textDim, fontSize: type.body, lineHeight: 21, textAlign: 'center' },
	// シートの地（panel）から浮かせるため、SettingsCard 既定の surface ではなく一段明るい面にする。
	infoCard: { backgroundColor: colors.surface2 },
	connectionDot: { width: 8, height: 8, borderRadius: radius.pill, ...squircle, backgroundColor: colors.textDim },
	connectionDotOnline: { backgroundColor: colors.green },
	errorText: { color: colors.red, fontSize: type.meta, lineHeight: 18, textAlign: 'center' },
	platformNote: { color: colors.yellow, fontSize: type.caption, lineHeight: 17, textAlign: 'center' },
	footnote: { color: colors.textDim, fontSize: type.badge, textAlign: 'center' },
});
