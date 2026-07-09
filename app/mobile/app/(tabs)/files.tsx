// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StyleSheet, View } from 'react-native';
import { ConnectionGate } from '../../src/components/connectionGate.js';
import { WsHeader } from '../../src/components/wsDrawer.js';
import { FilesPanel } from '../../src/components/filesPanel.js';
import { colors } from '../../src/theme.js';

/**
 * ファイルタブ。エージェントタブのホーム統合で下部タブに空きができたため、
 * 旧「その他」タブのセグメント（ファイル/ブラウザ）をそれぞれ独立タブに昇格した。
 * 実体は旧files.tsx由来の filesPanel.tsx をそのまま使う。
 */
export default function FilesScreen() {
	return (
		<ConnectionGate>
		<View style={styles.screen}>
			<WsHeader title="ファイル" />
			<FilesPanel />
		</View>
		</ConnectionGate>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
});
