// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAgentLaunchToast } from '../agentLaunch.js';
import { GlassSurface } from './glassSurface.js';
import { useTabBarSpacer } from '../hooks/useTabBarSpacer.js';
import { colors } from '../theme.js';

/**
 * 起動トースト（タブバーの上のLiquid Glass）。起動フォームを閉じた後の進行表示なので、
 * フォーム側ではなく一覧（ホーム）に置く。状態は agentLaunch.ts が持つ。
 */
export function AgentLaunchToastView() {
	const toast = useAgentLaunchToast(state => state.toast);
	const tabBarSpacer = useTabBarSpacer();
	if (toast === undefined) {
		return null;
	}
	return (
		<View style={[styles.toast, { bottom: tabBarSpacer + 10 }]} pointerEvents="none">
			<GlassSurface style={styles.toastGlass} />
			{toast.phase === 'progress'
				? <ActivityIndicator size="small" color={colors.accent} />
				: <Ionicons name="checkmark-circle" size={18} color={colors.green} />}
			<View style={styles.toastBody}>
				<Text style={styles.toastText} numberOfLines={1}>{toast.text}</Text>
				{toast.sub.length > 0 ? <Text style={styles.toastSub} numberOfLines={1}>{toast.sub}</Text> : null}
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	toast: {
		position: 'absolute', left: 16, right: 16,
		flexDirection: 'row', alignItems: 'center', gap: 10,
		borderRadius: 16, paddingVertical: 11, paddingHorizontal: 14,
	},
	toastGlass: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 16, overflow: 'hidden' },
	toastBody: { flex: 1, minWidth: 0 },
	toastText: { color: colors.text, fontSize: 12.5, fontWeight: '700' },
	toastSub: { color: colors.textDim, fontSize: 10.5, marginTop: 1 },
});
