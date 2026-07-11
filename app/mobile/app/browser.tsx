// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../src/appState.js';
import { ConnectionGate } from '../src/components/connectionGate.js';
import { BrowserPanel } from '../src/components/browserPanel.js';
import { GlassSurface } from '../src/components/glassSurface.js';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { colors } from '../src/theme.js';
import { hapticSelection } from '../src/haptics.js';

/**
 * ブラウザ画面（スタック）。旧下部タブの「ブラウザ」を廃止し、エージェント詳細ヘッダーの
 * ブラウザボタンから開く形に変更した（ブラウザの用途は「エージェントの作業結果を見る」が
 * 実態のため、エージェント文脈に従属させる）。実体は BrowserPanel をそのまま使う。
 *
 * パラメータ `token`: 遷移元エージェントのペイントークン。共有中のページの自動選択
 * （BrowserPanel の preferredToken）とヘッダーの「〜と共有中」表示に使う。
 */
export default function BrowserScreen() {
	const router = useRouter();
	const isFocused = useIsFocused();
	const insets = useStableInsets();
	const { token } = useLocalSearchParams<{ token?: string }>();
	const preferredToken = typeof token === 'string' && token.length > 0 ? token : undefined;
	const { workspace } = useAppStore(useShallow(s => ({ workspace: s.workspace })));
	const sourceTerminal = preferredToken !== undefined
		? workspace?.terminals.find(t => t.agentToken === preferredToken)
		: undefined;

	return (
		<ConnectionGate>
		<View style={styles.screen}>
			<View style={[styles.header, { paddingTop: insets.top + 4 }]}>
				<Pressable onPress={() => { hapticSelection(); router.back(); }} accessibilityLabel="戻る">
					<GlassSurface style={styles.backBtn} interactive>
						<Ionicons name="chevron-back" size={20} color={colors.text} />
					</GlassSurface>
				</Pressable>
				<View style={styles.headerBody}>
					<Text style={styles.headerTitle}>ブラウザ</Text>
					<Text style={styles.headerSub} numberOfLines={1}>
						{sourceTerminal !== undefined ? `${sourceTerminal.title} から` : 'PC側の para-browser を共有表示'}
					</Text>
				</View>
			</View>
			<BrowserPanel active={isFocused} preferredToken={preferredToken} />
		</View>
		</ConnectionGate>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingBottom: 8 },
	backBtn: { width: 36, height: 36, borderRadius: 18, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
	headerBody: { flex: 1, minWidth: 0 },
	headerTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
	headerSub: { color: colors.textDim, fontSize: 11, marginTop: 1, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
});
