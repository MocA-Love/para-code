// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { CircleAlert } from 'lucide-react-native';
import { createMobileOfficeNonce, guardMobileOfficeNavigation, MOBILE_OFFICE_ORIGIN_WHITELIST, secureMobileOfficeHtml } from '../../components/officeCapability.js';
import { guardWebViewNavigation } from '../../components/webViewLinkGuard.js';
import { isFileViewerJavaScriptEnabled } from '../../components/webViewScriptPolicy.js';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import { hapticSelection } from '../../haptics.js';
import { colors, radius, space, type } from '../../theme.js';
import { Button, EmptyState, useThemeColors } from '../../ui/index.js';
import { beginParadisOfficeRecovery, createParadisOfficeRecoveryState, reduceParadisOfficeRecovery, type IParadisOfficeRecoverySnapshot, type ParadisOfficeRecoveryEffect } from '../../../../../src/vs/paradis/contrib/fileViewers/common/paradisOfficeRecovery.js';
import { CenterSpinner } from './codeParts.js';
import { buildCodeHtml, buildMarkdownHtml, type ViewerKind, type ViewerMode } from './fileViewerModel.js';
import type { FileContent } from './useFileContent.js';
import { measureBuild, type FileViewerLoadTrace } from './fileViewerTiming.js';
import { buildDocxHtml, buildImageHtml, fileExt } from './viewerHtml.js';

/**
 * ファイルビューアの本文（Orca の MobileFilePreviewBody）。種類ごとの表示は旧ビューア
 * （`src/components/fileViewer.tsx`）と同じ:
 *  - コード: PC のテーマでトークン化された HTML に行番号を付けて WebView に出す
 *  - Markdown / HTML: プレビューとソースを切り替える
 *  - 表計算: PC が描いた1シート分の HTML（シートが2枚以上なら上にシートのチップ）
 *  - Word: WebView の中で docx-preview が描く
 *  - PDF・動画・音声: キャッシュへ書き出して WKWebView のネイティブ表示
 *  - 画像: data URI
 * `NativeFileView` と `MobileOfficeWebView` は旧ビューアから中身を変えずに移した。
 */

/**
 * PDF・動画・音声の表示。base64 のバイナリをキャッシュファイルへ書き出し、WKWebView に
 * file:// URI で読ませてネイティブレンダリング（PDF: ズーム・ページング・テキスト選択、
 * 動画/音声: 標準プレーヤー）を使う。
 * 書き込みは legacy API の Base64 エンコーディング指定で行う（デコードがネイティブ側で走るため、
 * 数十MBのファイルでもJSスレッドをブロックしない）。
 */
export function NativeFileView({ data, ext, trace }: { data: string; ext: string; trace?: FileViewerLoadTrace }) {
	const [uri, setUri] = useState<string | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	useEffect(() => {
		let cancelled = false;
		let written: string | undefined;
		(async () => {
			try {
				const dir = LegacyFileSystem.cacheDirectory;
				if (!dir) {
					throw new Error('cache directory unavailable');
				}
				const target = `${dir}pm-file-view-${Date.now()}.${ext}`;
				const writeStartedAt = Date.now();
				await LegacyFileSystem.writeAsStringAsync(target, data, { encoding: LegacyFileSystem.EncodingType.Base64 });
				trace?.fileWritten(Date.now() - writeStartedAt);
				written = target;
				if (!cancelled) {
					setUri(target);
				} else {
					// 書き込み完了前にアンマウント済み。cleanup は written 未設定のまま走り終えているのでここで消す。
					void LegacyFileSystem.deleteAsync(target, { idempotent: true }).catch(() => { });
				}
			} catch (e) {
				if (!cancelled) {
					setError(String(e instanceof Error ? e.message : e));
				}
			}
		})();
		return () => {
			cancelled = true;
			if (written !== undefined) {
				// 一時ファイルの削除失敗は無視（cacheディレクトリはOSが回収する）
				void LegacyFileSystem.deleteAsync(written, { idempotent: true }).catch(() => { });
			}
		};
	}, [data, ext, trace]);
	if (error !== undefined) {
		return <EmptyState icon={CircleAlert} title="ファイルを表示できませんでした" body={error} />;
	}
	if (uri === undefined) {
		return (
			<CenterSpinner label="読み込み中…" />
		);
	}
	return (
		<WebView
			style={styles.web}
			source={{ uri }}
			originWhitelist={['file://']}
			allowingReadAccessToURL={uri}
			javaScriptEnabled={false}
			onShouldStartLoadWithRequest={guardWebViewNavigation}
			onLoadStart={trace?.loadStarted}
			onLoadEnd={trace?.loadEnded}
		/>
	);
}

interface MobileOfficeWebViewProps {
	readonly path: string;
	readonly kind: 'spreadsheet' | 'docx';
	readonly html: string;
	readonly javaScriptEnabled: boolean;
	readonly viewState: Readonly<Record<string, string | number>>;
	readonly onShouldStartLoadWithRequest: (request: { readonly url: string; readonly isTopFrame?: boolean }) => boolean;
	/** 計測用。WebView の onLoadStart / onLoadEnd をそのまま渡す。 */
	readonly onLoadStart?: () => void;
	readonly onLoadEnd?: () => void;
}

/** Applies the shared bounded recovery reducer to the isolated mobile Office WebView. */
export function MobileOfficeWebView({ path, kind, html, javaScriptEnabled, viewState, onShouldStartLoadWithRequest, onLoadStart, onLoadEnd }: MobileOfficeWebViewProps) {
	const snapshot = useMemo<IParadisOfficeRecoverySnapshot>(() => ({
		source: { mode: 'document', source: { kind: 'file', uri: path, displayName: path.split('/').pop() ?? path } },
		viewState,
	}), [path, viewState]);
	const initial = useRef(beginParadisOfficeRecovery(createParadisOfficeRecoveryState(), snapshot));
	const recoveryState = useRef(initial.current.state);
	const webviewRef = useRef<WebView>(null);
	const lastInput = useRef({ html, snapshot });
	const [generation, setGeneration] = useState(initial.current.state.generation);
	const [webviewEpoch, setWebviewEpoch] = useState(0);
	const [reloadEpoch, setReloadEpoch] = useState(0);
	const [finalError, setFinalError] = useState(false);

	const applyEffects = useCallback((effects: readonly ParadisOfficeRecoveryEffect[]) => {
		for (const effect of effects) {
			switch (effect.type) {
				case 'load':
					setFinalError(false);
					setGeneration(effect.generation);
					break;
				case 'remount':
				case 'restore':
					setFinalError(false);
					setGeneration(effect.generation);
					setReloadEpoch(value => value + 1);
					break;
				case 'recreate':
					setFinalError(false);
					setGeneration(effect.generation);
					setWebviewEpoch(value => value + 1);
					break;
				case 'showError':
					setFinalError(true);
					break;
			}
		}
	}, []);

	useEffect(() => {
		if (lastInput.current.html === html && lastInput.current.snapshot === snapshot) {
			return;
		}
		lastInput.current = { html, snapshot };
		const transition = beginParadisOfficeRecovery(recoveryState.current, snapshot);
		recoveryState.current = transition.state;
		applyEffects(transition.effects);
	}, [applyEffects, html, snapshot]);

	useEffect(() => {
		if (reloadEpoch > 0) {
			webviewRef.current?.reload();
		}
	}, [reloadEpoch]);

	const completeRender = (hasExpectedRoot: boolean) => {
		const transition = reduceParadisOfficeRecovery(recoveryState.current, { type: 'rendered', generation, hasExpectedRoot });
		recoveryState.current = transition.state;
		applyEffects(transition.effects);
	};

	const retry = () => {
		const transition = reduceParadisOfficeRecovery(recoveryState.current, { type: 'retry' });
		recoveryState.current = transition.state;
		applyEffects(transition.effects);
	};

	const openExternally = () => {
		const uri = /^[a-z][a-z\d+.-]*:/i.test(path) ? path : `file://${path}`;
		void Linking.openURL(uri).catch(() => Alert.alert('ファイルを開けませんでした', path));
	};

	if (finalError) {
		return (
			<View style={styles.recoveryBox}>
				<Text style={styles.dim}>Office ファイルの表示結果が空でした。</Text>
				<View style={styles.recoveryActions}>
					<Button variant="secondary" size="sm" label="再試行" onPress={retry} />
					<Button variant="secondary" size="sm" label="既定のアプリで開く" onPress={openExternally} />
				</View>
			</View>
		);
	}

	const expectedSelector = kind === 'docx'
		? '.docx-wrapper > section.docx'
		: 'table, [role="grid"], .paradis-spreadsheet-virtual-host';
	const probe = `(function () {
		var sent = false;
		var finish = function (present) {
			if (sent) { return; }
			sent = true;
			observer.disconnect();
			window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'paradisOfficeRecovery', generation: ${generation}, hasExpectedRoot: present }));
		};
		var check = function () { if (document.querySelector(${JSON.stringify(expectedSelector)})) { finish(true); } };
		var observer = new MutationObserver(check);
		observer.observe(document.documentElement, { childList: true, subtree: true });
		check();
		setTimeout(function () { finish(!!document.querySelector(${JSON.stringify(expectedSelector)})); }, 2000);
		true;
	})();`;

	return (
		<WebView
			ref={webviewRef}
			key={`${kind}:${webviewEpoch}`}
			style={styles.web}
			source={{ html }}
			originWhitelist={[...MOBILE_OFFICE_ORIGIN_WHITELIST]}
			javaScriptEnabled={javaScriptEnabled}
			onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
			onLoadStart={onLoadStart}
			onLoadEnd={onLoadEnd}
			injectedJavaScript={probe}
			onMessage={event => {
				try {
					const message = JSON.parse(event.nativeEvent.data) as { readonly type?: string; readonly generation?: number; readonly hasExpectedRoot?: boolean };
					if (message.type === 'paradisOfficeRecovery' && message.generation === generation && typeof message.hasExpectedRoot === 'boolean') {
						completeRender(message.hasExpectedRoot);
					}
				} catch {
					// Ignore messages that are not recovery observations.
				}
			}}
		/>
	);
}


export function FileViewerBody({ path, kind, mode, content, focusLine, onSelectSheet }: {
	path: string;
	kind: ViewerKind;
	mode: ViewerMode;
	content: FileContent | undefined;
	focusLine: number | undefined;
	onSelectSheet: (index: number) => void;
}) {
	const name = path.split('/').pop() ?? path;
	const officeKind = kind === 'spreadsheet' || kind === 'docx';
	const text = content?.text;
	const spreadsheetHtml = content?.xlsx?.html;
	const binary = content?.binary;
	const trace = content?.trace;
	const officeNonce = useMemo(() => (officeKind ? createMobileOfficeNonce() : undefined), [officeKind, spreadsheetHtml, binary]);
	const guardOfficeNavigation = useCallback((request: { readonly url: string; readonly isTopFrame?: boolean }) => guardMobileOfficeNavigation(request, url => {
		Alert.alert('外部リンクを開きますか？', url, [
			{ text: 'キャンセル', style: 'cancel' },
			{ text: '開く', onPress: () => { void Linking.openURL(url).catch(() => undefined); } },
		]);
	}), []);
	// Markdown のリンクと、開いた行の地は設定 → 色の「選択の印・リンク」。
	const theme = useThemeColors();
	const built = useMemo(() => measureBuild(() => {
		if (kind === 'spreadsheet') {
			return spreadsheetHtml !== undefined && officeNonce !== undefined ? secureMobileOfficeHtml(spreadsheetHtml, officeNonce) : undefined;
		}
		if (kind === 'docx') {
			return binary !== undefined && officeNonce !== undefined ? secureMobileOfficeHtml(buildDocxHtml(binary), officeNonce) : undefined;
		}
		if (kind === 'image') {
			return binary !== undefined ? buildImageHtml(binary, fileExt(name)) : undefined;
		}
		if (text === undefined) {
			return undefined;
		}
		if (mode === 'render' && kind === 'html') {
			return text.content;
		}
		if (mode === 'render' && kind === 'markdown') {
			return buildMarkdownHtml(text, theme);
		}
		return buildCodeHtml(text, focusLine, theme);
	}), [kind, mode, text, spreadsheetHtml, binary, officeNonce, focusLine, name, theme]);
	const html = built.value;
	useEffect(() => {
		trace?.viewing(kind, mode);
		if (html !== undefined) {
			trace?.htmlBuilt(built.ms, html.length);
		}
	}, [trace, built, html, kind, mode]);
	const officeViewState = useMemo(() => ({
		mode,
		...(kind === 'spreadsheet' && content?.xlsx?.sheet !== undefined ? { activeSheetIndex: content.xlsx.sheet } : {}),
	}), [kind, mode, content?.xlsx?.sheet]);

	if (content?.error !== undefined) {
		return <EmptyState icon={CircleAlert} title="ファイルを開けませんでした" body={content.error} />;
	}
	const sheets = content?.xlsx?.sheets;
	const sheetIndex = content?.xlsx?.sheet;
	const allowJs = isFileViewerJavaScriptEnabled(kind, mode, focusLine);
	let view;
	if ((kind === 'pdf' || kind === 'av') && binary !== undefined) {
		view = <NativeFileView data={binary} ext={kind === 'pdf' ? 'pdf' : fileExt(name)} trace={trace} />;
	} else if (html !== undefined && officeKind) {
		view = (
			<MobileOfficeWebView
				path={path}
				kind={kind}
				html={html}
				javaScriptEnabled={allowJs}
				viewState={officeViewState}
				onShouldStartLoadWithRequest={guardOfficeNavigation}
				onLoadStart={trace?.loadStarted}
				onLoadEnd={trace?.loadEnded}
			/>
		);
	} else if (html !== undefined) {
		view = (
			<WebView
				style={styles.web}
				source={{ html }}
				originWhitelist={[...MOBILE_OFFICE_ORIGIN_WHITELIST]}
				javaScriptEnabled={allowJs}
				onShouldStartLoadWithRequest={guardWebViewNavigation}
				onLoadStart={trace?.loadStarted}
				onLoadEnd={trace?.loadEnded}
			/>
		);
	} else {
		view = <CenterSpinner label="読み込み中…" />;
	}
	return (
		<View style={styles.body}>
			{kind === 'spreadsheet' && sheets !== undefined && sheets.length > 1 ? (
				<ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.sheetBar} contentContainerStyle={styles.sheetBarContent}>
					{sheets.map((sheetName, index) => {
						const on = index === sheetIndex;
						return (
							<Pressable
								key={`${index}:${sheetName}`}
								onPress={() => { if (!on) { hapticSelection(); onSelectSheet(index); } }}
								hitSlop={hitSlopToMinimum(SHEET_CHIP_HEIGHT)}
								style={[styles.sheetChip, on ? styles.sheetChipOn : undefined]}
								accessibilityRole="button"
								accessibilityState={{ selected: on }}
								accessibilityLabel={`シート ${sheetName}`}
							>
								<Text style={[styles.sheetText, on ? styles.sheetTextOn : undefined]} numberOfLines={1}>{sheetName}</Text>
							</Pressable>
						);
					})}
				</ScrollView>
			) : null}
			{text?.truncated === true || text?.highlightTruncated === true ? (
				<Text style={styles.truncated}>サイズの上限のため先頭だけを表示しています</Text>
			) : null}
			{view}
		</View>
	);
}

/** シートのチップの高さ（pt。モックの `.chip`）。当たり判定は 44 に広げる。 */
const SHEET_CHIP_HEIGHT = 32;
/** シートの名前の最大幅（pt。長いシート名で1枚が画面を埋めないように）。 */
const SHEET_CHIP_MAX_WIDTH = 180;

const styles = StyleSheet.create({
	body: {
		flex: 1,
		backgroundColor: colors.codeBg,
	},
	// WKWebView は初回の描画の前の地が白なので、開いた瞬間に白く光る。不透明の地を当てて暗いままにする。
	web: {
		flex: 1,
		backgroundColor: colors.codeBg,
	},
	dim: {
		fontSize: type.body,
		color: colors.textDim,
		textAlign: 'center',
	},
	recoveryBox: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		gap: space.lg,
		padding: space.xl,
	},
	recoveryActions: {
		flexDirection: 'row',
		gap: space.md,
	},
	truncated: {
		fontSize: type.caption,
		color: colors.amber,
		paddingHorizontal: space.lg,
		paddingVertical: space.xs,
		backgroundColor: colors.panel,
	},
	sheetBar: {
		flexGrow: 0,
		flexShrink: 0,
		backgroundColor: colors.panel,
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderBottomColor: colors.border,
	},
	sheetBarContent: {
		paddingHorizontal: space.md,
		paddingVertical: space.sm,
		gap: space.sm,
	},
	sheetChip: {
		minHeight: SHEET_CHIP_HEIGHT,
		maxWidth: SHEET_CHIP_MAX_WIDTH,
		borderRadius: radius.button,
		paddingHorizontal: space.md,
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: colors.bg,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
	},
	sheetChipOn: {
		backgroundColor: colors.text,
		borderColor: colors.text,
	},
	sheetText: {
		fontSize: type.meta,
		fontWeight: '600',
		color: colors.textDim,
	},
	sheetTextOn: {
		color: colors.bg,
	},
});
