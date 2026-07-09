// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StyleSheet, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { ConnectionGate } from '../../src/components/connectionGate.js';
import { WsHeader } from '../../src/components/wsDrawer.js';
import { BrowserPanel } from '../../src/components/browserPanel.js';
import { colors } from '../../src/theme.js';

/**
 * ブラウザタブ。エージェントタブのホーム統合で下部タブに空きができたため、
 * 旧「その他」タブのセグメント（ファイル/ブラウザ）をそれぞれ独立タブに昇格した。
 * 実体は旧browser.tsx由来の browserPanel.tsx をそのまま使う。
 * activeはタブフォーカスに追随し、離れるとscreencastが自然に止まる（旧セグメント同様）。
 */
export default function BrowserScreen() {
	const isFocused = useIsFocused();
	return (
		<ConnectionGate>
		<View style={styles.screen}>
			<WsHeader title="ブラウザ" />
			<BrowserPanel active={isFocused} />
		</View>
		</ConnectionGate>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
});
