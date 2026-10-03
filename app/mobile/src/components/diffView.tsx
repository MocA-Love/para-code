// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 変更ファイルのフルスクリーンビューア。
 * - テキスト: GitHub モバイルアプリ風の unified diff（行番号つき・緑/赤背景）
 * - .md / .html: 「プレビュー / 差分」を切り替えられる（プレビューは現在の作業ツリーの内容）
 * - .xlsx / .xlsm: PC側でレンダリングされたExcel差分HTML（HEAD vs 作業ツリー、セル色分け）を
 *   表示し、「プレビュー」で現在のブックそのものも見られる。どちらもピンチ拡大縮小可
 * - 削除以外は、ヘッダーのボタンで実ファイルをファイルビューアで開ける（差分の上に重ねる）
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, View } from 'react-native';

import { WebView } from 'react-native-webview';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { buildMarkdownHtml } from './fileViewer.js';
import { monoFamily } from '../monoFont.js';
import { alpha, colors, tint, type } from '../theme.js';
import { hapticImpact } from '../haptics.js';
import { EmptyState } from './emptyState.js';
import { ViewerHeader } from './viewerHeader.js';
import { WorkspaceFileViewer } from './workspaceFileViewer.js';
import { useWorkspaceUnavailableReason } from '../hooks/useWorkspaceUnavailableReason.js';
import { isDiffViewerJavaScriptEnabled } from './webViewScriptPolicy.js';
import { guardWebViewNavigation } from './webViewLinkGuard.js';
import { parseUnifiedDiff } from './diffParser.js';
import { useIsRegularWidth } from '../hooks/useSizeClass.js';
import { useCloseOnAppLock } from '../appLock.js';
import { lockedModalVisible } from '../appLockPolicy.js';
import { classifyMobileFileKind } from './officeCapability.js';

const OFFICE_DIFF_UNAVAILABLE = 'このOffice形式のDiffは利用できません';

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

/** 表示の切り替え。語はファイルビューア（`fileViewer.tsx`）とそろえる（左は同じ「プレビュー」）。 */
const MODE_OPTIONS = [
	{ value: 'render', label: 'プレビュー' },
	{ value: 'diff', label: '差分' },
] as const satisfies readonly { value: ViewMode; label: string }[];

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
	// ロックされたら閉じる。Modal はロック画面より上に出るので、親が閉じるのを待たずに隠す（`appLock.ts`）。
	// 拡大の切り替え途中（`modalOpen` が false）でも閉じる。
	const locked = useCloseOnAppLock(true, onClose);
	const lockedRef = useRef(locked);
	lockedRef.current = locked;
	const headerTop = effectiveSheet ? 14 : 58;

	const requestToggleExpanded = () => {
		hapticImpact('light');
		pendingExpandedRef.current = !expanded;
		setModalOpen(false);
	};
	const handleDismiss = () => {
		// ロックで隠したときの dismiss。閉じる処理は `useCloseOnAppLock` が済ませているので二重に呼ばない。
		if (lockedRef.current) {
			return;
		}
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
	const unavailable = useWorkspaceUnavailableReason(ws);
	const deleted = statusLetter === 'D';
	const name = path.split('/').pop() ?? path;
	const officeKind = classifyMobileFileKind(name);
	const kind = /\.(?:md|markdown)$/i.test(name) ? 'markdown'
		: /\.(?:html?|xhtml)$/i.test(name) ? 'html'
			: officeKind === 'spreadsheet' && /\.(?:xlsx|xlsm)$/i.test(name) ? 'spreadsheet'
				: officeKind !== undefined ? 'officeUnavailable' : 'other';

	// 文書として読めるものは、開いた瞬間から読める形で出す（ファイルビューアも同じ既定）。
	// 表計算はPC側が作る「セルの色分け差分」の方が情報量が多いのでDiffのまま。
	// 削除されたファイルは作業ツリーに中身が無いのでレンダーできない。
	const canRenderByDefault = (kind === 'markdown' || kind === 'html') && !deleted;
	const [mode, setMode] = useState<ViewMode>(canRenderByDefault ? 'render' : 'diff');
	const [diffText, setDiffText] = useState<string | undefined>();
	const [diffHtml, setDiffHtml] = useState<string | undefined>();
	const [renderHtml, setRenderHtml] = useState<string | undefined>();
	// レンダー表示中の内容がPC側の読み取り上限（fsRead、現在20MB）で切り詰められているか。
	// .html はそのままWebViewへ渡す唯一の経路なので、切り詰められると表示が途中で壊れる
	// （fileViewer.tsx の FileViewer と同じ注意喚起をここでも出す）。
	const [renderTruncated, setRenderTruncated] = useState(false);
	const [error, setError] = useState<string | undefined>();
	// 差分から開いた実ファイル（既存のファイルビューアを差分の上に重ねる）。
	const [fileOpen, setFileOpen] = useState(false);
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
		if (kind === 'officeUnavailable') {
			setError(OFFICE_DIFF_UNAVAILABLE);
		} else if (kind === 'spreadsheet') {
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
	const loading = kind === 'officeUnavailable' ? false : mode === 'render' ? renderHtml === undefined : kind === 'spreadsheet' ? diffHtml === undefined : diffText === undefined;

	// iPad幅では pageSheet にして、常設サイドバーを覆い隠さないようにする
	// （fullScreenだとファイルを1つ開くたびに2カラムが消える）。ヘッダーの拡大ボタンで
	// ユーザーが明示的に選んだときだけ全画面へ切り替える。
	return (
		<Modal
			key={effectiveSheet ? 'sheet' : 'full'}
			visible={lockedModalVisible(modalOpen, locked)}
			animationType={locked ? 'none' : 'slide'}
			presentationStyle={effectiveSheet ? 'pageSheet' : 'fullScreen'}
			onDismiss={handleDismiss}
			onRequestClose={onClose}
		>
			<View style={styles.screen}>
				<ViewerHeader
					icon="git-compare-outline"
					title={path}
					top={headerTop}
					onClose={onClose}
					// レンダーを既定にすると「どれだけ変わったか」の手がかりが消えるので、
					// 増減行数はモードによらず出す（差分そのものは「差分」に切り替えれば見られる）。
					accessory={kind !== 'spreadsheet' && diffText !== undefined ? (
						<>
							<Text style={styles.statAdd}>+{stats.add}</Text>
							<Text style={styles.statDel}>-{stats.del}</Text>
						</>
					) : undefined}
					// 並びと語はファイルビューアとそろえる（左がプレビュー）。
					segment={kind !== 'other' && kind !== 'officeUnavailable' ? { options: MODE_OPTIONS, value: mode, onChange: setMode } : undefined}
					// 削除されたファイルは作業ツリーに無いので開けない。
					actions={deleted ? undefined : [{ key: 'open', icon: 'document-text-outline', label: 'ファイルを開く', onPress: () => setFileOpen(true) }]}
					expandable={presentedAsSheet}
					expanded={expanded}
					onToggleExpanded={requestToggleExpanded}
				/>
				{mode === 'render' && renderTruncated ? (
					<Text style={styles.truncated}>サイズ上限のため先頭のみ表示しています</Text>
				) : null}
				{error !== undefined ? (
					<EmptyState icon="alert-circle-outline" title={mode === 'render' ? 'プレビューを表示できませんでした' : '差分を表示できませんでした'} message={error} />
				) : showWebView !== undefined ? (
					// ペアリング済みワークスペースのHTMLはPC版と同様にスクリプト実行を許可する。
					// xlsxは自前生成HTMLのシート切替スクリプトを実行する。
					<WebView
						style={styles.web}
						source={{ html: showWebView }}
						originWhitelist={['*']}
						javaScriptEnabled={isDiffViewerJavaScriptEnabled(kind === 'officeUnavailable' ? 'other' : kind)}
						onShouldStartLoadWithRequest={guardWebViewNavigation}
					/>
				) : loading && unavailable !== undefined ? (
					<EmptyState icon="cloud-offline-outline" title="読み込めません" message={`${unavailable}。接続が戻ると読み込みます`} />
				) : loading ? (
					<View style={styles.loadingBox}>
						<ActivityIndicator color={colors.textDim} />
						<Text style={styles.dim}>読み込み中…</Text>
					</View>
				) : rows.length === 0 && diffText !== undefined && diffText.trim() === '' ? (
					<EmptyState icon="checkmark-circle-outline" title="差分はありません" />
				) : (
					<ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
						{/* 解析できる行が無い差分（バイナリなど）は、git の出力をそのまま見せる。 */}
						{rows.length === 0 && diffText !== undefined ? <Text style={styles.raw}>{diffText.trim()}</Text> : null}
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
			{/* 差分の上に重ねて実ファイルを開く。閉じると差分へ戻るので「‹ 差分」を出す。 */}
			{fileOpen ? (
				<WorkspaceFileViewer ws={ws} path={path} backLabel="差分" onClose={() => setFileOpen(false)} />
			) : null}
		</Modal>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	// 増減の色は SCM の一覧と同じ add / del にそろえる。
	statAdd: { color: colors.add, fontSize: type.meta, fontFamily: monoFamily, fontWeight: '700' },
	statDel: { color: colors.del, fontSize: type.meta, fontFamily: monoFamily, fontWeight: '700' },
	// WKWebView は初回ペイント前の既定背景が不透明白のため、開いた瞬間に白フラッシュする。
	// fileViewer と同じく alpha 1.0 の backgroundColor を指定して初回ペイント前も暗く保つ
	// （screen の地色 colors.bg に揃える）。
	web: { flex: 1, backgroundColor: colors.bg },
	truncated: { color: colors.yellow, fontSize: type.badge, paddingHorizontal: 16, paddingVertical: 4 },
	body: { flex: 1 },
	bodyContent: { paddingVertical: 8 },
	dim: { color: colors.textDim, fontSize: type.body, textAlign: 'center' },
	loadingBox: { alignItems: 'center', gap: 8, marginTop: 24 },
	raw: { color: colors.textDim, fontSize: type.caption, fontFamily: monoFamily, paddingHorizontal: 16, paddingTop: 16 },
	row: { flexDirection: 'row', alignItems: 'flex-start', minHeight: 20 },
	hunkRow: { backgroundColor: tint(colors.accent, alpha.wash), paddingHorizontal: 10, paddingVertical: 4, marginVertical: 4 },
	hunkText: { color: colors.accent, fontSize: type.caption, fontFamily: monoFamily },
	addRow: { backgroundColor: tint(colors.add, alpha.wash) },
	delRow: { backgroundColor: tint(colors.del, alpha.wash) },
	lineNo: { width: 34, textAlign: 'right', color: colors.textDim, fontSize: type.badge, fontFamily: monoFamily, paddingTop: 3, paddingRight: 4 },
	addNum: { color: colors.add },
	delNum: { color: colors.del },
	sign: { width: 14, textAlign: 'center', fontSize: type.caption, fontFamily: monoFamily, paddingTop: 2 },
	signAdd: { color: colors.add, fontWeight: '700' },
	signDel: { color: colors.del, fontWeight: '700' },
	signCtx: { color: colors.textDim },
	code: { flex: 1, color: colors.text, fontSize: type.caption, lineHeight: 17, fontFamily: monoFamily, paddingRight: 10, paddingTop: 2 },
});
