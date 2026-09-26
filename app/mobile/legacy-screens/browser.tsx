// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StyleSheet, View } from 'react-native';
import { useIsFocused, useLocalSearchParams } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../src/appState.js';
import { ConnectionGate, useConnectionGateBlocked } from '../src/components/connectionGate.js';
import { BrowserPanel } from '../src/components/browserPanel.js';
import { NativeScreenHeader } from '../src/components/nativeHeaderItems.js';
import { useParaHeader, PARA_HEADER_HIDDEN } from '../src/paraHeader.js';
import { colors } from '../src/theme.js';

/**
 * ブラウザ画面（スタック）。旧下部タブの「ブラウザ」を廃止し、エージェント詳細ヘッダーの
 * ブラウザボタンから開く形に変更した（ブラウザの用途は「エージェントの作業結果を見る」が
 * 実態のため、エージェント文脈に従属させる）。実体は BrowserPanel をそのまま使う。
 *
 * パラメータ `token`: 遷移元エージェントのペイントークン。共有中のページの自動選択
 * （BrowserPanel の preferredToken）とヘッダーの「〜と共有中」表示に使う。
 */
export default function BrowserScreen() {
	const isFocused = useIsFocused();
	const { token } = useLocalSearchParams<{ token?: string }>();
	const preferredToken = typeof token === 'string' && token.length > 0 ? token : undefined;
	const { workspace } = useAppStore(useShallow(s => ({ workspace: s.workspace })));
	const sourceTerminal = preferredToken !== undefined
		? workspace?.terminals.find(t => t.agentToken === preferredToken)
		: undefined;

	const gated = useConnectionGateBlocked();
	// 自前のヘッダー層は使わない（バーはOS標準に任せる）。伏せておかないと二重に描かれる。
	useParaHeader(PARA_HEADER_HIDDEN);

	return (
		<>
		{/* **ゲートの外に置く。** 中に入れるとゲートが閉じた瞬間にこれ自体が外れ、前の画面の
		    バーが残る。伏せたいときは `hidden` を渡す。
		    エージェント詳細の［タイトル］［🌐］から push すると、タイトルが「ブラウザ」へ、
		    🌐の丸が消えて——という具合にバー項目の集合が変わるので、その変化はOSが描く。 */}
		<NativeScreenHeader
			title="ブラウザ"
			sub={sourceTerminal !== undefined ? `${sourceTerminal.title} から` : 'PC側の para-browser を共有表示'}
			hidden={gated}
		/>
		<ConnectionGate>
		{/* 本文の上余白は要らない（OSがバーの下から本文を始める）。 */}
		<View style={styles.screen}>
			<BrowserPanel active={isFocused} preferredToken={preferredToken} />
		</View>
		</ConnectionGate>
		</>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
});
