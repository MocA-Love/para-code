// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useMemo } from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { X } from 'lucide-react-native';
import { useCloseOnAppLock } from '../../appLock.js';
import { lockedModalVisible } from '../../appLockPolicy.js';
import { MOBILE_OFFICE_ORIGIN_WHITELIST } from '../../components/officeCapability.js';
import { guardWebViewNavigation } from '../../components/webViewLinkGuard.js';
import { alpha, colors, withAlpha } from '../../theme.js';
import { ScreenHeader, useThemeColors } from '../../ui/index.js';
import { buildMarkdownHtml } from '../code/fileViewerModel.js';

/**
 * 「選択して読む」（Q548 案 A の「範囲を選んでコピー…」の行き先。資料の案 B の画面）。
 *
 * RN の Text は iOS で「長押しで全文をコピー」しかできず、範囲を選べない。発言を HTML にして WebView で出し、
 * OS のつまみ・選択の色・「コピー」「すべて選択」「共有」をそのまま使う。HTML はファイルのビューアの Markdown の
 * プレビューと同じ作り（`buildMarkdownHtml`）で、スクリプトは動かさない。選択の色は「選択の印・リンク」の色。
 */
export function SelectableTextSheet({ text, title, onClose }: {
	/** 発言の元の Markdown。 */
	text: string;
	/** 見出しの下に出す、誰の発言か（「Claude の発言」など）。 */
	title: string;
	onClose: () => void;
}) {
	const theme = useThemeColors();
	const locked = useCloseOnAppLock(true, onClose);
	const html = useMemo(() => {
		const page = buildMarkdownHtml({ content: text, bg: colors.bg, fg: colors.text }, theme);
		const selection = `<style>body { -webkit-user-select: text; user-select: text; } ::selection { background: ${withAlpha(theme.accent, alpha.line) ?? theme.accent}; }</style>`;
		return page.replace('</head>', `${selection}</head>`);
	}, [text, theme]);
	return (
		<Modal visible={lockedModalVisible(true, locked)} animationType={locked ? 'none' : 'slide'} presentationStyle="pageSheet" onRequestClose={onClose}>
			<View style={styles.screen}>
				<ScreenHeader title="選択して読む" subtitle={title} safeTop={false} onBack={onClose} backLabel="閉じる" backIcon={X} />
				<WebView
					style={styles.web}
					source={{ html }}
					originWhitelist={[...MOBILE_OFFICE_ORIGIN_WHITELIST]}
					javaScriptEnabled={false}
					onShouldStartLoadWithRequest={guardWebViewNavigation}
				/>
			</View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	web: { flex: 1, backgroundColor: colors.bg },
});
