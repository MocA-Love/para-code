// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../src/appState.js';
import { ConnectionGate, useConnectionGateBlocked } from '../src/components/connectionGate.js';
import { BrowserPanel } from '../src/components/browserPanel.js';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { useParaHeader, useParaHeaderHeight, PARA_HEADER_HIDDEN, type ParaHeaderSpec } from '../src/paraHeader.js';
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

	// ヘッダーは常設のヘッダー層が描く。エージェント詳細（［‹］［タイトル］［🌐］）からの
	// push では枠が変わらないので、中身だけが差し替わる——以前は詳細側44pt／ここ36ptで
	// 押した瞬間に戻るボタンが縮んでいた。層に寄せたことで寸法も1箇所になった。
	const headerSpec = useMemo<ParaHeaderSpec>(() => ({
		left: { kind: 'back', label: '戻る', onPress: () => { hapticSelection(); router.back(); } },
		title: {
			text: 'ブラウザ',
			sub: sourceTerminal !== undefined ? `${sourceTerminal.title} から` : 'PC側の para-browser を共有表示',
		},
	}), [router, sourceTerminal]);
	const gated = useConnectionGateBlocked();
	// ゲートが塞いでいる間は伏せる（ゲート自身の「戻る」と層の丸が二重に出る）。
	useParaHeader(gated ? PARA_HEADER_HIDDEN : headerSpec);
	const headerHeight = useParaHeaderHeight();

	return (
		<ConnectionGate>
		<View style={[styles.screen, { paddingTop: headerHeight }]}>
			<BrowserPanel active={isFocused} preferredToken={preferredToken} />
		</View>
		</ConnectionGate>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
});
