// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../src/appState.js';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { colors } from '../src/theme.js';
import { hapticImpact, hapticSelection } from '../src/haptics.js';

/**
 * 設定画面。ワークスペースドロワーの設定アイコンから開く。
 * 現状は通知設定のみ（エージェントの完了通知・質問通知のON/OFF）。
 * OFFにするとOS通知（バナー）を抑制する。アプリ内の通知一覧には引き続き残る。
 */
export default function SettingsScreen() {
	const router = useRouter();
	const insets = useStableInsets();
	const { notifyPrefs, setNotifyPref } = useAppStore(useShallow(s => ({
		notifyPrefs: s.notifyPrefs, setNotifyPref: s.setNotifyPref,
	})));

	const toggle = (key: 'agentDone' | 'agentQuestion' | 'suppressWhenPcFocused') => (value: boolean) => {
		hapticSelection();
		setNotifyPref(key, value);
	};

	return (
		<View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
			<View style={styles.header}>
				<Text style={styles.title}>設定</Text>
				<Pressable style={styles.closeBtn} onPress={() => { hapticImpact('light'); router.back(); }} accessibilityLabel="閉じる">
					<Ionicons name="close" size={16} color={colors.textDim} />
				</Pressable>
			</View>
			<ScrollView style={styles.scroll} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
				<Text style={styles.sectionTitle}>使用量</Text>
				<View style={styles.card}>
					<Pressable style={styles.row} onPress={() => { hapticSelection(); router.push('/ccusage'); }}>
						<Ionicons name="stats-chart-outline" size={18} color={colors.accent} />
						<View style={styles.rowBody}>
							<Text style={styles.rowTitle}>Ccusage</Text>
							<Text style={styles.rowDesc}>コーディングエージェントのトークン使用量・コストを確認します</Text>
						</View>
						<Ionicons name="chevron-forward" size={16} color={colors.textDim} />
					</Pressable>
					<View style={styles.separator} />
					<Pressable style={styles.row} onPress={() => { hapticSelection(); router.push('/ratelimit'); }}>
						<Ionicons name="speedometer-outline" size={18} color={colors.accent} />
						<View style={styles.rowBody}>
							<Text style={styles.rowTitle}>Rate Limit</Text>
							<Text style={styles.rowDesc}>Claude Code / Codex のレート制限と残量をアカウントごとに確認します</Text>
						</View>
						<Ionicons name="chevron-forward" size={16} color={colors.textDim} />
					</Pressable>
				</View>

				<Text style={styles.sectionTitle}>通知</Text>
				<View style={styles.card}>
					<View style={styles.row}>
						<View style={styles.rowBody}>
							<Text style={styles.rowTitle}>作業完了を通知</Text>
							<Text style={styles.rowDesc}>エージェントの作業が終わったときに通知します</Text>
						</View>
						<Switch
							value={notifyPrefs.agentDone}
							onValueChange={toggle('agentDone')}
							trackColor={{ true: colors.accent2 }}
						/>
					</View>
					<View style={styles.separator} />
					<View style={styles.row}>
						<View style={styles.rowBody}>
							<Text style={styles.rowTitle}>質問を通知</Text>
							<Text style={styles.rowDesc}>エージェントから質問・承認要求があったときに通知します</Text>
						</View>
						<Switch
							value={notifyPrefs.agentQuestion}
							onValueChange={toggle('agentQuestion')}
							trackColor={{ true: colors.accent2 }}
						/>
					</View>
					<View style={styles.separator} />
					<View style={styles.row}>
						<View style={styles.rowBody}>
							<Text style={styles.rowTitle}>PC作業中は通知しない</Text>
							<Text style={styles.rowDesc}>PCの画面を見ている間はこのアプリへ通知を送りません</Text>
						</View>
						<Switch
							value={notifyPrefs.suppressWhenPcFocused}
							onValueChange={toggle('suppressWhenPcFocused')}
							trackColor={{ true: colors.accent2 }}
						/>
					</View>
				</View>
				<Text style={styles.note}>
					OFFにするとバナー通知が止まります（アプリ内の通知一覧には残ります）。「PC作業中は通知しない」がONの間は、PCの画面を見ている間に発生した通知はこのアプリに一切届きません。
				</Text>
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 10 },
	title: { color: colors.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.3, flex: 1 },
	closeBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
	scroll: { flex: 1, paddingHorizontal: 16 },
	sectionTitle: { color: colors.textDim, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8, marginBottom: 8 },
	card: { backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14 },
	row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
	rowBody: { flex: 1, minWidth: 0 },
	rowTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
	rowDesc: { color: colors.textDim, fontSize: 11.5, marginTop: 2, lineHeight: 15 },
	separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
	note: { color: colors.textDim, fontSize: 11.5, lineHeight: 17, marginTop: 10, paddingHorizontal: 4 },
});
