// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 変更ファイルのフルスクリーンビューア。
 * - テキスト: GitHub モバイルアプリ風の unified diff（行番号つき・緑/赤背景）
 * - .md / .html: 「Diff / レンダー」を切り替えられる（レンダーは現在の作業ツリーの内容）
 * - .xlsx / .xlsm: PC側でレンダリングされたExcel差分HTML（HEAD vs 作業ツリー、セル色分け）を
 *   表示し、「レンダー」で現在のブックそのものも見られる。どちらもピンチ拡大縮小可
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { buildMarkdownHtml } from './fileViewer.js';
import { colors } from '../theme.js';
import { hapticImpact, hapticSelection } from '../haptics.js';
import { isDiffViewerJavaScriptEnabled } from './webViewScriptPolicy.js';
import { guardWebViewNavigation } from './webViewLinkGuard.js';
import { parseUnifiedDiff } from './diffParser.js';
import { useIsRegularWidth } from '../hooks/useSizeClass.js';

interface DiffViewProps {
	ws: string;
	path: string;
	staged: boolean;
	/**
	 * gitの状態文字（'M' | 'A' | 'D' | '?' 等）。
	 * 削除されたファイルは作業ツリーに中身が無く、レンダーのしようがないので既定をDiffにする。
	 */
	statusLetter?: string;
	onClose: () => void;
}

function currentRendererTarget(ws: string): string | undefined {
	const state = useAppStore.getState();
	if (state.connection !== 'online' || !state.pcOnline || !state.sessionProtocolReady) {
		return undefined;
	}
	const selectedWorkspace = state.workspace?.workspaces.find(candidate => candidate.id === ws);
	const renderer = selectedWorkspace !== undefined ? state.workspace?.renderers.find(candidate => candidate.windowId === selectedWorkspace.windowId) : undefined;
	return renderer?.ready === true && state.workspace !== undefined
		? `${state.workspace.desktopEpoch}:${renderer.windowId}:${renderer.rendererGeneration}`
		: undefined;
}

type ViewMode = 'diff' | 'render';

export function DiffView({ ws, path, staged, statusLetter, onClose }: DiffViewProps) {
	// UIKitは提示後の modalPresentationStyle 変更を無視するため、開いた瞬間の値で凍結する。
	// ヘッダーの上余白も同じ値から決めること。片方だけ追従すると、開いたまま画面幅が
	// 変わったときに「fullScreenなのに上余白14pt」＝ヘッダーがステータスバーに潜る。
	const [presentedAsSheet] = useState(useIsRegularWidth());
	// iPad(pageSheet)限定の「全画面に拡大」トグル。UIKitはpresentationStyleの後変更を
	// 無視するため、Modalごと `key` で作り直して見た目を切り替える。同一コミットで
	// `key` だけ差し替えると旧Modalのdismiss完了前に新Modalのpresentが走ることがあるため、
	// `onDismiss`（iOSのみ、dismissアニメーション完了時に発火）で順序を保証する
	// （fileViewer.tsx の FileViewer と同じ実装）。
	const [expanded, setExpanded] = useState(false);
	const [modalOpen, setModalOpen] = useState(true);
	const pendingExpandedRef = useRef<boolean | undefined>(undefined);
	const effectiveSheet = presentedAsSheet && !expanded;
	const headerTop = effectiveSheet ? 14 : 58;

	const requestToggleExpanded = () => {
		hapticImpact('light');
		pendingExpandedRef.current = !expanded;
		setModalOpen(false);
	};
	const handleDismiss = () => {
		if (pendingExpandedRef.current !== undefined) {
			setExpanded(pendingExpandedRef.current);
			pendingExpandedRef.current = undefined;
			setModalOpen(true);
			return;
		}
		onClose();
	};
	const { scmDiff, scmXlsxDiff, fsRead, fsXlsx, connection, pcOnline, sessionProtocolReady, workspace } = useAppStore(useShallow(s => ({
		scmDiff: s.scmDiff, scmXlsxDiff: s.scmXlsxDiff, fsRead: s.fsRead, fsXlsx: s.fsXlsx,
		connection: s.connection, pcOnline: s.pcOnline, sessionProtocolReady: s.sessionProtocolReady, workspace: s.workspace,
	})));
	const selectedWorkspace = workspace?.workspaces.find(candidate => candidate.id === ws);
	const selectedRenderer = selectedWorkspace !== undefined ? workspace?.renderers.find(candidate => candidate.windowId === selectedWorkspace.windowId) : undefined;
	const rendererTarget = selectedRenderer?.ready === true && workspace !== undefined
		? `${workspace.desktopEpoch}:${selectedRenderer.windowId}:${selectedRenderer.rendererGeneration}`
		: undefined;
	const live = connection === 'online' && pcOnline && sessionProtocolReady && rendererTarget !== undefined;
	const name = path.split('/').pop() ?? path;
	const kind = /\.(?:md|markdown)$/i.test(name) ? 'markdown'
		: /\.(?:html?|xhtml)$/i.test(name) ? 'html'
			: /\.(?:xlsx|xlsm)$/i.test(name) ? 'spreadsheet' : 'other';

	// 文書として読めるものは、開いた瞬間から読める形で出す（ファイルビューアも同じ既定）。
	// 表計算はPC側が作る「セルの色分け差分」の方が情報量が多いのでDiffのまま。
	// 削除されたファイルは作業ツリーに中身が無いのでレンダーできない。
	const canRenderByDefault = (kind === 'markdown' || kind === 'html') && statusLetter !== 'D';
	const [mode, setMode] = useState<ViewMode>(canRenderByDefault ? 'render' : 'diff');
	const [diffText, setDiffText] = useState<string | undefined>();
	const [diffHtml, setDiffHtml] = useState<string | undefined>();
	const [renderHtml, setRenderHtml] = useState<string | undefined>();
	// レンダー表示中の内容がPC側の読み取り上限（fsRead、現在20MB）で切り詰められているか。
	// .html はそのままWebViewへ渡す唯一の経路なので、切り詰められると表示が途中で壊れる
	// （fileViewer.tsx の FileViewer と同じ注意喚起をここでも出す）。
	const [renderTruncated, setRenderTruncated] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const contentIdentity = `${ws}\0${path}\0${staged}`;
	const contentIdentityRef = useRef(contentIdentity);

	// Diff モードのデータ取得（初回のみ）
	useEffect(() => {
		let cancelled = false;
		if (contentIdentityRef.current !== contentIdentity) {
			contentIdentityRef.current = contentIdentity;
			setDiffText(undefined);
			setDiffHtml(undefined);
			setRenderHtml(undefined);
			setRenderTruncated(false);
			setError(undefined);
		}
		if (!live) {
			return;
		}
		const requestTarget = rendererTarget;
		setError(undefined);
		if (kind === 'spreadsheet') {
			scmXlsxDiff(ws, path)
				.then(r => { if (!cancelled && currentRendererTarget(ws) === requestTarget) { setDiffHtml(r.html); } })
				.catch(e => { if (!cancelled && currentRendererTarget(ws) === requestTarget) { setError(String(e instanceof Error ? e.message : e)); } });
		} else {
			scmDiff(ws, path, staged)
				.then(r => { if (!cancelled && currentRendererTarget(ws) === requestTarget) { setDiffText(r.diff); } })
				.catch(e => { if (!cancelled && currentRendererTarget(ws) === requestTarget) { setError(String(e instanceof Error ? e.message : e)); } });
		}
		return () => { cancelled = true; };
	}, [ws, path, staged, kind, contentIdentity, live, rendererTarget, scmDiff, scmXlsxDiff]);

	// レンダーモードのデータ取得（初めて切り替えたときに一度だけ）
	useEffect(() => {
		if (mode !== 'render' || !live) {
			return;
		}
		let cancelled = false;
		const requestTarget = rendererTarget;
		setError(undefined);
		const load = async () => {
			try {
				if (kind === 'spreadsheet') {
					const r = await fsXlsx(ws, path);
					if (!cancelled && currentRendererTarget(ws) === requestTarget) {
						setRenderHtml(r.html);
					}
				} else {
					const r = await fsRead(ws, path);
					if (!cancelled && currentRendererTarget(ws) === requestTarget) {
						setRenderHtml(kind === 'markdown' ? buildMarkdownHtml(r) : r.content);
						setRenderTruncated(r.truncated);
					}
				}
			} catch (e) {
				if (!cancelled && currentRendererTarget(ws) === requestTarget) {
					setError(String(e instanceof Error ? e.message : e));
				}
			}
		};
		void load();
		return () => { cancelled = true; };
	}, [mode, kind, ws, path, live, rendererTarget, fsRead, fsXlsx]);

	const rows = useMemo(() => (diffText === undefined ? [] : parseUnifiedDiff(diffText)), [diffText]);
	const stats = useMemo(() => ({
		add: rows.filter(r => r.kind === 'add').length,
		del: rows.filter(r => r.kind === 'del').length,
	}), [rows]);

	const showWebView = mode === 'render' ? renderHtml : kind === 'spreadsheet' ? diffHtml : undefined;
	const loading = mode === 'render' ? renderHtml === undefined : kind === 'spreadsheet' ? diffHtml === undefined : diffText === undefined;

	// iPad幅では pageSheet にして、常設サイドバーを覆い隠さないようにする
	// （fullScreenだとファイルを1つ開くたびに2カラムが消える）。ヘッダーの拡大ボタンで
	// ユーザーが明示的に選んだときだけ全画面へ切り替える。
	return (
		<Modal
			key={effectiveSheet ? 'sheet' : 'full'}
			visible={modalOpen}
			animationType="slide"
			presentationStyle={effectiveSheet ? 'pageSheet' : 'fullScreen'}
			onDismiss={handleDismiss}
			onRequestClose={onClose}
		>
			<View style={styles.screen}>
				<View style={[styles.header, { paddingTop: headerTop }]}>
					<Ionicons name="git-compare-outline" size={16} color={colors.textDim} />
					<Text style={styles.title} numberOfLines={1}>{path}</Text>
					{/* レンダーを既定にすると「どれだけ変わったか」の手がかりが消えるので、
					    増減行数はモードによらず出す（差分そのものはDiffに切り替えれば見られる）。 */}
					{kind !== 'spreadsheet' && diffText !== undefined ? (
						<>
							<Text style={styles.statAdd}>+{stats.add}</Text>
							<Text style={styles.statDel}>-{stats.del}</Text>
						</>
					) : null}
					{kind !== 'other' ? (
						// 並びはファイルビューアと揃える（左がレンダー）。
						<View style={styles.segment}>
							<Pressable style={[styles.segmentBtn, mode === 'render' && styles.segmentBtnActive]} onPress={() => { hapticSelection(); setMode('render'); }}>
								<Text style={[styles.segmentText, mode === 'render' && styles.segmentTextActive]}>レンダー</Text>
							</Pressable>
							<Pressable style={[styles.segmentBtn, mode === 'diff' && styles.segmentBtnActive]} onPress={() => { hapticSelection(); setMode('diff'); }}>
								<Text style={[styles.segmentText, mode === 'diff' && styles.segmentTextActive]}>Diff</Text>
							</Pressable>
						</View>
					) : null}
					{presentedAsSheet ? (
						<Pressable
							onPress={requestToggleExpanded}
							hitSlop={14}
							accessibilityRole="button"
							accessibilityLabel={expanded ? 'シート表示に戻す' : '全画面表示にする'}
						>
							<Ionicons name={expanded ? 'contract' : 'expand'} size={19} color={colors.textDim} />
						</Pressable>
					) : null}
					<Pressable onPress={() => { hapticImpact('light'); onClose(); }} hitSlop={8} accessibilityLabel="閉じる">
						<Ionicons name="close" size={22} color={colors.text} />
					</Pressable>
				</View>
				{error ? <Text style={styles.error}>{error}</Text> : null}
				{mode === 'render' && renderTruncated ? (
					<Text style={styles.truncated}>サイズ上限のため先頭のみ表示しています</Text>
				) : null}
				{showWebView !== undefined ? (
					// ペアリング済みワークスペースのHTMLはPC版と同様にスクリプト実行を許可する。
					// xlsxは自前生成HTMLのシート切替スクリプトを実行する。
					<WebView
						style={styles.web}
						source={{ html: showWebView }}
						originWhitelist={['*']}
						javaScriptEnabled={isDiffViewerJavaScriptEnabled(kind)}
						onShouldStartLoadWithRequest={guardWebViewNavigation}
					/>
				) : loading && !error ? (
					<Text style={styles.dim}>読み込み中…</Text>
				) : (
					<ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
						{rows.length === 0 && diffText !== undefined ? <Text style={styles.dim}>{diffText.trim() || '差分はありません'}</Text> : null}
						{rows.map((row, i) => {
							if (row.kind === 'hunk') {
								return (
									<View key={i} style={[styles.row, styles.hunkRow]}>
										<Text style={styles.hunkText} numberOfLines={1}>{row.text}</Text>
									</View>
								);
							}
							const rowStyle = row.kind === 'add' ? styles.addRow : row.kind === 'del' ? styles.delRow : undefined;
							const numStyle = row.kind === 'add' ? styles.addNum : row.kind === 'del' ? styles.delNum : undefined;
							const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ';
							const signStyle = row.kind === 'add' ? styles.signAdd : row.kind === 'del' ? styles.signDel : styles.signCtx;
							return (
								<View key={i} style={[styles.row, rowStyle]}>
									<Text style={[styles.lineNo, numStyle]}>{row.oldNo ?? ''}</Text>
									<Text style={[styles.lineNo, numStyle]}>{row.newNo ?? ''}</Text>
									<Text style={[styles.sign, signStyle]}>{sign}</Text>
									<Text style={styles.code}>{row.text || ' '}</Text>
								</View>
							);
						})}
						<View style={{ height: 32 }} />
					</ScrollView>
				)}
			</View>
		</Modal>
	);
}

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: '#0d1117' },
	header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surface },
	title: { flex: 1, color: colors.text, fontSize: 13, fontFamily: MONO },
	statAdd: { color: '#3fb950', fontSize: 12, fontFamily: MONO, fontWeight: '700' },
	statDel: { color: '#f85149', fontSize: 12, fontFamily: MONO, fontWeight: '700' },
	segment: { flexDirection: 'row', backgroundColor: colors.panel, borderRadius: 8, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
	segmentBtn: { paddingHorizontal: 10, paddingVertical: 5 },
	segmentBtnActive: { backgroundColor: 'rgba(9,175,217,.25)' },
	segmentText: { color: colors.textDim, fontSize: 12 },
	segmentTextActive: { color: colors.text, fontWeight: '600' },
	// WKWebView は初回ペイント前の既定背景が不透明白のため、開いた瞬間に白フラッシュする。
	// fileViewer と同じく alpha 1.0 の backgroundColor を指定して初回ペイント前も暗く保つ
	// （screen の地色 #0d1117 に揃える）。
	web: { flex: 1, backgroundColor: '#0d1117' },
	error: { color: colors.red, fontSize: 12, paddingHorizontal: 16, paddingVertical: 8 },
	truncated: { color: colors.yellow, fontSize: 10, paddingHorizontal: 16, paddingVertical: 4 },
	body: { flex: 1 },
	bodyContent: { paddingVertical: 8 },
	dim: { color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 24 },
	row: { flexDirection: 'row', alignItems: 'flex-start', minHeight: 20 },
	hunkRow: { backgroundColor: 'rgba(56,139,253,0.12)', paddingHorizontal: 10, paddingVertical: 4, marginVertical: 4 },
	hunkText: { color: '#58a6ff', fontSize: 11, fontFamily: MONO },
	addRow: { backgroundColor: 'rgba(46,160,67,0.16)' },
	delRow: { backgroundColor: 'rgba(248,81,73,0.14)' },
	lineNo: { width: 34, textAlign: 'right', color: '#8b949e', fontSize: 10, fontFamily: MONO, paddingTop: 3, paddingRight: 4 },
	addNum: { color: '#7ee2a8' },
	delNum: { color: '#ffa198' },
	sign: { width: 14, textAlign: 'center', fontSize: 11, fontFamily: MONO, paddingTop: 2 },
	signAdd: { color: '#3fb950', fontWeight: '700' },
	signDel: { color: '#f85149', fontWeight: '700' },
	signCtx: { color: '#8b949e' },
	code: { flex: 1, color: '#e6edf3', fontSize: 11, lineHeight: 17, fontFamily: MONO, paddingRight: 10, paddingTop: 2 },
});
