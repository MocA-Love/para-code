// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import { MOBILE_OFFICE_ORIGIN_WHITELIST } from '../../components/officeCapability.js';
import { guardWebViewNavigation } from '../../components/webViewLinkGuard.js';
import { isDiffViewerJavaScriptEnabled } from '../../components/webViewScriptPolicy.js';
import { hapticSelection } from '../../haptics.js';
import { colors, radius, space, type } from '../../theme.js';
import { REVIEW_VIEW_LABELS, type ReviewViewMode } from './reviewViewModes.js';
import { buildImageHtml, fileExt } from './viewerHtml.js';

/**
 * 差分の画面の見方の部品（モックの項目 6 の案A）。ファイルの帯の下の切り替え、画像の比較、PC が描いた Office の差分。
 */

/** 切り替えの高さ（pt。ファイルの画面の検索欄の `.sfield` と同じ）。 */
const SWITCH_HEIGHT = 36;

/** ファイルの帯の下の「表示・差分・Raw」。見方が 1 つしか無いファイルでは出さない（呼び出し側が決める）。 */
export function ReviewViewSwitch({ modes, mode, onChange }: { modes: readonly ReviewViewMode[]; mode: ReviewViewMode; onChange: (mode: ReviewViewMode) => void }) {
	return (
		<View style={styles.bar}>
			<View style={styles.segments} accessibilityRole="radiogroup">
				{modes.map(item => {
					const on = item === mode;
					return (
						<Pressable
							key={item}
							onPress={() => { if (!on) { hapticSelection(); onChange(item); } }}
							hitSlop={hitSlopToMinimum(SWITCH_HEIGHT - space.xs * 2)}
							style={[styles.segment, on ? styles.segmentOn : undefined]}
							accessibilityRole="radio"
							accessibilityState={{ selected: on }}
							accessibilityLabel={`${REVIEW_VIEW_LABELS[item]}で見る`}
						>
							<Text style={[styles.segmentText, on ? styles.segmentTextOn : undefined]}>{REVIEW_VIEW_LABELS[item]}</Text>
						</Pressable>
					);
				})}
			</View>
		</View>
	);
}

/**
 * 画像の変更前と変更後を並べる。広い幅（iPad の 2 列）は左右、狭い幅は上下。木の形は変えず、並べる向きだけを変える。
 */
export function ReviewImageCompare({ path, before, after, sideBySide }: { path: string; before: string | undefined; after: string | undefined; sideBySide: boolean }) {
	const ext = fileExt(path.split('/').pop() ?? path);
	return (
		<View style={[styles.compare, { flexDirection: sideBySide ? 'row' : 'column' }]}>
			<ImagePane label="変更前" data={before} ext={ext} />
			<View style={sideBySide ? styles.dividerVertical : styles.dividerHorizontal} />
			<ImagePane label="変更後" data={after} ext={ext} />
		</View>
	);
}

function ImagePane({ label, data, ext }: { label: string; data: string | undefined; ext: string }) {
	const html = useMemo(() => (data !== undefined ? buildImageHtml(data, ext) : undefined), [data, ext]);
	return (
		<View style={styles.pane}>
			<Text style={styles.paneLabel}>{label}</Text>
			{html !== undefined ? (
				<WebView
					style={styles.web}
					source={{ html }}
					originWhitelist={[...MOBILE_OFFICE_ORIGIN_WHITELIST]}
					javaScriptEnabled={false}
					onShouldStartLoadWithRequest={guardWebViewNavigation}
				/>
			) : (
				<View style={styles.empty}>
					<Text style={styles.emptyText}>{label === '変更前' ? '変更前のファイルはありません' : '変更後のファイルはありません'}</Text>
				</View>
			)}
		</View>
	);
}

/** PC が描いた Excel・Word の差分（HTML）。Excel はシートの切り替えに JS を使い、Word は使わない。 */
export function OfficeDiffWebView({ html, kind }: { html: string; kind: 'spreadsheet' | 'docx' }) {
	return (
		<WebView
			style={styles.web}
			source={{ html }}
			originWhitelist={kind === 'docx' ? [...MOBILE_OFFICE_ORIGIN_WHITELIST] : ['*']}
			javaScriptEnabled={isDiffViewerJavaScriptEnabled(kind)}
			onShouldStartLoadWithRequest={guardWebViewNavigation}
		/>
	);
}

const styles = StyleSheet.create({
	bar: {
		paddingHorizontal: space.lg,
		paddingVertical: space.sm,
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderBottomColor: colors.border,
	},
	segments: {
		flexDirection: 'row',
		height: SWITCH_HEIGHT,
		padding: space.xs - 1,
		borderRadius: radius.tile,
		backgroundColor: colors.raised,
	},
	segment: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		borderRadius: radius.button,
	},
	segmentOn: {
		backgroundColor: colors.borderStrong,
	},
	segmentText: {
		fontSize: type.label,
		fontWeight: '600',
		color: colors.textDim,
	},
	segmentTextOn: {
		color: colors.text,
	},
	compare: {
		flex: 1,
	},
	pane: {
		flex: 1,
		minWidth: 0,
		minHeight: 0,
	},
	paneLabel: {
		fontSize: type.caption,
		fontWeight: '600',
		color: colors.textMuted,
		paddingHorizontal: space.lg,
		paddingVertical: space.xs,
		backgroundColor: colors.panel,
	},
	dividerVertical: {
		width: StyleSheet.hairlineWidth,
		backgroundColor: colors.border,
	},
	dividerHorizontal: {
		height: StyleSheet.hairlineWidth,
		backgroundColor: colors.border,
	},
	web: {
		flex: 1,
		backgroundColor: colors.codeBg,
	},
	empty: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: colors.codeBg,
	},
	emptyText: {
		fontSize: type.meta,
		color: colors.textMuted,
	},
});
