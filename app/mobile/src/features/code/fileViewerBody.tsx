// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { paraAlert } from '../../paraAlert.js';
import { WebView } from 'react-native-webview';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { CircleAlert, FileQuestion } from 'lucide-react-native';
import { createMobileOfficeNonce, guardMobileOfficeNavigation, MOBILE_OFFICE_ORIGIN_WHITELIST, secureMobileOfficeHtml } from '../../components/officeCapability.js';
import { guardWebViewNavigation } from '../../components/webViewLinkGuard.js';
import { isFileViewerJavaScriptEnabled, isSearchableFileViewerJavaScriptEnabled } from '../../components/webViewScriptPolicy.js';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import { haptic } from '../../haptics.js';
import { colors, radius, space, type } from '../../theme.js';
import { Button, EmptyState, useThemeColors } from '../../ui/index.js';
import { beginParadisOfficeRecovery, createParadisOfficeRecoveryState, reduceParadisOfficeRecovery, type IParadisOfficeRecoverySnapshot, type ParadisOfficeRecoveryEffect } from '../../../../../src/vs/paradis/contrib/fileViewers/common/paradisOfficeRecovery.js';
import { CenterSpinner } from './codeParts.js';
import { buildFindScript, findTargetOf } from './fileFind.js';
import { HTML_IMAGES_LOADER_SCRIPT, HtmlImageQueue, buildHtmlImageDeliverScript } from './htmlImages.js';
import { CODE_LINE_WINDOW, buildCodeHtml, buildMarkdownHtml, codeLineTotal, codePageStartOf, type ViewerKind, type ViewerMode } from './fileViewerModel.js';
import type { FileContent } from './useFileContent.js';
import type { FileFindBinding } from './useFileFind.js';
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
	/** 中の WebView（作り直したら新しいもの。ファイル内の検索の流し込みに使う）。 */
	readonly onWebViewRef?: (view: WebView | null) => void;
	/** 復旧の確認以外のメッセージ（ファイル内の検索の結果）。 */
	readonly onExtraMessage?: (data: string) => void;
}

/** Applies the shared bounded recovery reducer to the isolated mobile Office WebView. */
export function MobileOfficeWebView({ path, kind, html, javaScriptEnabled, viewState, onShouldStartLoadWithRequest, onLoadStart, onLoadEnd, onWebViewRef, onExtraMessage }: MobileOfficeWebViewProps) {
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
		void Linking.openURL(uri).catch(() => paraAlert.alert('ファイルを開けませんでした', path));
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
			ref={view => {
				webviewRef.current = view;
				onWebViewRef?.(view);
			}}
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
						return;
					}
				} catch {
					// Ignore messages that are not recovery observations.
				}
				onExtraMessage?.(event.nativeEvent.data);
			}}
		/>
	);
}


export function FileViewerBody({ path, kind, mode, content, focusLine, onSelectSheet, find }: {
	path: string;
	kind: ViewerKind;
	mode: ViewerMode;
	content: FileContent | undefined;
	focusLine: number | undefined;
	onSelectSheet: (index: number) => void;
	/**
	 * ファイル内の検索（`useFileFind` の `binding`）。渡すと、画像・PDF・動画・音声のほかは WebView のスクリプトを
	 * 有効にし、コードと Markdown には自分のスクリプトだけを許す CSP を付ける。渡さなければ今までどおり。
	 */
	find?: FileFindBinding;
}) {
	const name = path.split('/').pop() ?? path;
	const officeKind = kind === 'spreadsheet' || kind === 'docx';
	const text = content?.text;
	const spreadsheetHtml = content?.xlsx?.html;
	const binary = content?.binary;
	const trace = content?.trace;
	const officeNonce = useMemo(() => (officeKind ? createMobileOfficeNonce() : undefined), [officeKind, spreadsheetHtml, binary]);
	const guardOfficeNavigation = useCallback((request: { readonly url: string; readonly isTopFrame?: boolean }) => guardMobileOfficeNavigation(request, url => {
		paraAlert.alert('外部リンクを開きますか？', url, [
			{ text: 'キャンセル', style: 'cancel' },
			{ text: '開く', onPress: () => { void Linking.openURL(url).catch(() => undefined); } },
		]);
	}), []);
	// Markdown のリンクと、開いた行の地は設定 → 色の「選択の印・リンク」。
	const theme = useThemeColors();
	const searchable = find !== undefined;
	// コードの表示は 1 万行ずつのページ（長いファイルは下の帯で前後へ移る）。検索の一致行から開いたらその行のページ。
	// 同じ画面のまま別のファイル・別の一致行へ移ったら（レビューの次のファイルなど）ページを選び直し、読み直して
	// 行数が減ったら最後のページに収める
	const codeView = text !== undefined && !(mode === 'render' && (kind === 'markdown' || kind === 'html'));
	const pageKey = `${path}\n${focusLine ?? ''}`;
	const [page, setPage] = useState(() => ({ key: pageKey, start: codePageStartOf(focusLine) }));
	if (page.key !== pageKey) {
		setPage({ key: pageKey, start: codePageStartOf(focusLine) });
	}
	const totalLines = useMemo(() => (codeView && text !== undefined ? codeLineTotal(text.content) : 0), [codeView, text]);
	const requestedStart = page.key === pageKey ? page.start : codePageStartOf(focusLine);
	const pageStart = totalLines > 0 ? Math.min(requestedStart, Math.floor((totalLines - 1) / CODE_LINE_WINDOW) * CODE_LINE_WINDOW) : requestedStart;
	// コードと Markdown の CSP の nonce（HTML を作り直すたびに新しくする）。
	const viewerNonce = useMemo(() => (searchable ? createMobileOfficeNonce() : undefined), [searchable, text, mode, pageStart]);
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
			return buildMarkdownHtml(text, theme, viewerNonce);
		}
		return buildCodeHtml(text, focusLine, theme, viewerNonce, pageStart);
	}), [kind, mode, text, spreadsheetHtml, binary, officeNonce, focusLine, name, theme, viewerNonce, pageStart]);
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

	// ファイル内の検索: 操作が変わるたびに、今の WebView へ検索のスクリプトを流す。範囲（種類と表示で決まる）が
	// 変わるときは本文を読み直すので、読み込み終わり（onViewLoaded）から送り直される。
	const webRef = useRef<WebView | null>(null);
	const findTarget = searchable ? findTargetOf(kind, mode) : undefined;
	const findTargetRef = useRef(findTarget);
	findTargetRef.current = findTarget;
	const findRequest = find?.request;
	const findToken = find?.token;
	useEffect(() => {
		const target = findTargetRef.current;
		if (findRequest === undefined || target === undefined || findToken === undefined) {
			return;
		}
		webRef.current?.injectJavaScript(buildFindScript(findRequest.command, { token: findToken, seq: findRequest.seq, target }));
	}, [findRequest, findToken]);
	const setWebRef = useCallback((view: WebView | null) => {
		webRef.current = view;
	}, []);
	const onViewLoadEnd = () => {
		trace?.loadEnded();
		find?.onViewLoaded();
	};
	// HTML から抜いた画像（fs.html-images.v1）。本文が替わる・閉じるたびにキューを作り直し、古いキューの結果は捨てる
	const htmlImages = mode === 'render' && kind === 'html' ? content?.htmlImages : undefined;
	const imageQueueRef = useRef<HtmlImageQueue | undefined>(undefined);
	useEffect(() => {
		if (htmlImages === undefined) {
			return undefined;
		}
		const queue = new HtmlImageQueue({
			count: htmlImages.count,
			fetch: index => htmlImages.fetch(index),
			deliver: (index, data) => webRef.current?.injectJavaScript(buildHtmlImageDeliverScript(index, data)),
			isStale: error => htmlImages.isStale(error),
			onStale: () => htmlImages.reload(),
		});
		imageQueueRef.current = queue;
		return () => {
			queue.dispose();
			if (imageQueueRef.current === queue) {
				imageQueueRef.current = undefined;
			}
		};
	}, [htmlImages]);
	const onViewMessage = (data: string) => {
		if (imageQueueRef.current?.handleMessage(data) === true) {
			return;
		}
		find?.onMessage(data);
	};

	if (content?.unsupported === true) {
		return <EmptyState icon={FileQuestion} title="この形式はまだ開けません" body="スマホではまだ表示できない形式です。PC で開いてください。" />;
	}
	if (content?.error !== undefined) {
		return <EmptyState icon={CircleAlert} title="ファイルを開けませんでした" body={content.error} />;
	}
	const sheets = content?.xlsx?.sheets;
	const sheetIndex = content?.xlsx?.sheet;
	const allowJs = searchable ? isSearchableFileViewerJavaScriptEnabled(kind) : isFileViewerJavaScriptEnabled(kind, mode, focusLine);
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
				onLoadEnd={onViewLoadEnd}
				onWebViewRef={setWebRef}
				{...(find !== undefined ? { onExtraMessage: onViewMessage } : {})}
			/>
		);
	} else if (html !== undefined) {
		// 画像を取り寄せる本文は、取り寄せのスクリプトを最初から入れた WebView で開く（後から足すと次の読み込みまで効かない）
		view = (
			<WebView
				key={htmlImages !== undefined ? 'html-images' : 'page'}
				ref={setWebRef}
				style={styles.web}
				source={{ html }}
				originWhitelist={[...MOBILE_OFFICE_ORIGIN_WHITELIST]}
				javaScriptEnabled={allowJs}
				onShouldStartLoadWithRequest={guardWebViewNavigation}
				onLoadStart={trace?.loadStarted}
				onLoadEnd={onViewLoadEnd}
				{...(htmlImages !== undefined ? { injectedJavaScriptBeforeContentLoaded: HTML_IMAGES_LOADER_SCRIPT } : {})}
				{...(find !== undefined || htmlImages !== undefined ? { onMessage: (event: { nativeEvent: { data: string } }) => onViewMessage(event.nativeEvent.data) } : {})}
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
								onPress={() => { if (!on) { haptic('tick'); onSelectSheet(index); } }}
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
			{text?.truncated === true ? (
				<Text style={styles.truncated}>サイズの上限のため先頭だけを表示しています</Text>
			) : null}
			{view}
			{codeView && totalLines > CODE_LINE_WINDOW ? (
				<View style={styles.pageBar}>
					<Button variant="secondary" size="sm" label="前へ" disabled={pageStart === 0} onPress={() => setPage({ key: pageKey, start: Math.max(0, pageStart - CODE_LINE_WINDOW) })} />
					<Text style={styles.pageText} numberOfLines={1}>{`${(pageStart + 1).toLocaleString()}〜${Math.min(pageStart + CODE_LINE_WINDOW, totalLines).toLocaleString()} 行目 / 全 ${totalLines.toLocaleString()} 行`}</Text>
					<Button variant="secondary" size="sm" label="続きを表示" disabled={pageStart + CODE_LINE_WINDOW >= totalLines} onPress={() => setPage({ key: pageKey, start: pageStart + CODE_LINE_WINDOW })} />
				</View>
			) : null}
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
	pageBar: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingHorizontal: space.md,
		paddingVertical: space.sm,
		backgroundColor: colors.panel,
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: colors.border,
	},
	pageText: {
		flex: 1,
		fontSize: type.caption,
		color: colors.textDim,
		textAlign: 'center',
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
