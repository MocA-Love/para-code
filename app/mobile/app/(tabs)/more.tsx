// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { ConnectionGate } from '../../src/components/connectionGate.js';
import { WsBar } from '../../src/components/wsBar.js';
import { ScreenTitle } from '../../src/components/screenTitle.js';
import { SegmentedControl } from '../../src/components/segmentedControl.js';
import { FilesPanel } from '../../src/components/filesPanel.js';
import { BrowserPanel } from '../../src/components/browserPanel.js';
import { colors } from '../../src/theme.js';

type Segment = 'files' | 'browser';

/**
 * 「その他」タブ（モックアップ mock-2.html 準拠）。ファイル/ブラウザをセグメント
 * コントロールで切り替える（下部タブバーを5個に収めるため統合。旧files.tsx/browser.tsx
 * の機能はそれぞれ filesPanel.tsx / browserPanel.tsx にそのまま移植した）。
 * 条件付きマウントで切り替えるため、離れたセグメントのstateは保持しない
 * （BrowserPanelはアンマウント時のクリーンアップでscreencastが自然に止まる）。
 */
export default function MoreScreen() {
	const [segment, setSegment] = useState<Segment>('files');
	const isFocused = useIsFocused();

	return (
		<ConnectionGate>
		<View style={styles.screen}>
			<ScreenTitle title="その他" />
			<WsBar />
			<SegmentedControl
				value={segment}
				onChange={setSegment}
				options={[{ value: 'files', label: 'ファイル' }, { value: 'browser', label: 'ブラウザ' }]}
			/>
			{segment === 'files' ? <FilesPanel /> : <BrowserPanel active={isFocused && segment === 'browser'} />}
		</View>
		</ConnectionGate>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
});
