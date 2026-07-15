// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { FileViewer, MEDIA_FILE_PATTERN } from './fileViewer.js';
import { useEffectiveWs } from './wsDrawer.js';
import { useTabBarSpacer } from '../hooks/useTabBarSpacer.js';
import { colors } from '../theme.js';
import { hapticSelection } from '../haptics.js';
import type { FsFindResult, FsGrepResult, FsListResult, FsReadResult } from '../store.js';

function currentRendererTarget(wsId: string | undefined): string | undefined {
	const state = useAppStore.getState();
	if (wsId === undefined || state.connection !== 'online' || !state.pcOnline || !state.sessionProtocolReady) {
		return undefined;
	}
	const selectedWorkspace = state.workspace?.workspaces.find(candidate => candidate.id === wsId);
	const renderer = selectedWorkspace !== undefined ? state.workspace?.renderers.find(candidate => candidate.windowId === selectedWorkspace.windowId) : undefined;
	return renderer?.ready === true && state.workspace !== undefined
		? `${state.workspace.desktopEpoch}:${renderer.windowId}:${renderer.rendererGeneration}`
		: undefined;
}

/**
 * ファイルパネル（モックアップ mock-2.html 準拠、「その他」タブのセグメント）。
 * ワークスペースのファイルツリーを閲覧し、タップでのフルスクリーンビューア表示に対応（読み取り専用）。
 * ビューアはPC版と同じテーマのシンタックスハイライトで表示し、.md/.htmlは
 * レンダー/Raw を切り替えられる。
 *
 * 検索はPC側ripgrep（VS Code本体と同じエンジン）によるワークスペース全体検索:
 *  - ファイル名: 全階層の相対パスに対する部分一致（.gitignore尊重、ランク順）
 *  - テキスト: 全文検索（スマートケース・リテラル一致、行プレビュー付き）
 */
export function FilesPanel() {
	const ws = useEffectiveWs();
	const { fsList, fsRead, fsXlsx, fsPdf, fsDocx, fsMedia, fsFind, fsGrep, connection, pcOnline, sessionProtocolReady, workspace } = useAppStore(useShallow(s => ({ fsList: s.fsList, fsRead: s.fsRead, fsXlsx: s.fsXlsx, fsPdf: s.fsPdf, fsDocx: s.fsDocx, fsMedia: s.fsMedia, fsFind: s.fsFind, fsGrep: s.fsGrep, connection: s.connection, pcOnline: s.pcOnline, sessionProtocolReady: s.sessionProtocolReady, workspace: s.workspace })));
	const selectedWorkspace = workspace?.workspaces.find(candidate => candidate.id === ws?.id);
	const selectedRenderer = selectedWorkspace !== undefined ? workspace?.renderers.find(candidate => candidate.windowId === selectedWorkspace.windowId) : undefined;
	const rendererTarget = selectedRenderer?.ready === true && workspace !== undefined
		? `${workspace.desktopEpoch}:${selectedRenderer.windowId}:${selectedRenderer.rendererGeneration}`
		: undefined;
	const live = connection === 'online' && pcOnline && sessionProtocolReady && rendererTarget !== undefined;

	const tabBarSpacer = useTabBarSpacer();
	const [path, setPath] = useState('');
	const pathRef = useRef('');
	const [listing, setListing] = useState<FsListResult | undefined>();
	const [filter, setFilter] = useState('');
	const [searchMode, setSearchMode] = useState<'name' | 'text'>('name');
	const [findResult, setFindResult] = useState<FsFindResult | undefined>();
	const [grepResult, setGrepResult] = useState<FsGrepResult | undefined>();
	const [searching, setSearching] = useState(false);
	// 入力デバウンスと応答順序の入れ替わり対策（最後に発行したクエリのみ反映する）
	const searchGenRef = useRef(0);
	const lastSearchKeyRef = useRef<string | undefined>(undefined);
	const loadContextRef = useRef<{ wsId: string | undefined; live: boolean; rendererTarget: string | undefined }>({ wsId: undefined, live: false, rendererTarget: undefined });
	const [error, setError] = useState<string | undefined>();
	const [loading, setLoading] = useState(false);
	const loadGenRef = useRef(0);
	const [viewerPath, setViewerPath] = useState<string | undefined>();
	const [viewerResult, setViewerResult] = useState<FsReadResult | undefined>();
	const [viewerXlsx, setViewerXlsx] = useState<{ html?: string; sheets?: string[]; sheet?: number } | undefined>();
	const [viewerPdf, setViewerPdf] = useState<string | undefined>();
	const [viewerDocx, setViewerDocx] = useState<string | undefined>();
	const [viewerMedia, setViewerMedia] = useState<string | undefined>();
	const [viewerLine, setViewerLine] = useState<number | undefined>();
	// 同じpathを閉じて開き直す場合やworkspaceを跨ぐ場合も、前のfetchが
	// 新しいビューアを上書きしないようpathとは別に世代を持つ。
	const viewerPathRef = useRef<string | undefined>(undefined);
	const viewerGenRef = useRef(0);
	const reloadViewerRef = useRef<() => void>(() => { });
	// 同一ファイル内でシートを素早く切り替えた際、古いシート応答が新しい選択を上書きするのを防ぐ世代ガード
	const sheetGenRef = useRef(0);

	const wsId = ws?.id;

	const load = useCallback(async (p: string, clearSearch = false) => {
		if (!wsId || !live) {
			return;
		}
		setError(undefined);
		setLoading(true);
		const gen = ++loadGenRef.current;
		const requestTarget = rendererTarget;
		try {
			const result = await fsList(wsId, p);
			if (loadGenRef.current !== gen || currentRendererTarget(wsId) !== requestTarget) {
				return;
			}
			setListing(result);
			pathRef.current = p;
			setPath(p);
			if (clearSearch) {
				setFilter('');
				setFindResult(undefined);
				setGrepResult(undefined);
			}
		} catch (e) {
			if (loadGenRef.current === gen && currentRendererTarget(wsId) === requestTarget) {
				setError(String(e instanceof Error ? e.message : e));
			}
		} finally {
			if (loadGenRef.current === gen && currentRendererTarget(wsId) === requestTarget) {
				setLoading(false);
			}
		}
	}, [fsList, wsId, live, rendererTarget]);

	useEffect(() => {
		const previous = loadContextRef.current;
		loadContextRef.current = { wsId, live, rendererTarget };
		if (previous.wsId !== wsId) {
			loadGenRef.current++;
			searchGenRef.current++;
			viewerGenRef.current++;
			sheetGenRef.current++;
			pathRef.current = '';
			setPath('');
			setFilter('');
			setListing(undefined);
			setViewerPath(undefined);
			viewerPathRef.current = undefined;
			setViewerResult(undefined);
			setViewerXlsx(undefined);
			setViewerPdf(undefined);
			setViewerDocx(undefined);
			setViewerMedia(undefined);
			setViewerLine(undefined);
			setFindResult(undefined);
			setGrepResult(undefined);
			lastSearchKeyRef.current = undefined;
			if (live) {
				void load('');
			}
			return;
		}
		const rendererChanged = previous.rendererTarget !== rendererTarget;
		if ((!live && previous.live) || rendererChanged) {
			loadGenRef.current++;
			searchGenRef.current++;
			viewerGenRef.current++;
			sheetGenRef.current++;
			setLoading(false);
			setSearching(false);
			if (!live) {
				return;
			}
		}
		// 同じworkspaceへの再接続では閲覧中ディレクトリを維持し、検索結果は自動再実行せず
		// キャッシュをそのまま見せる。通常ツリーだけ現在のpathで静かに更新する。
		if (live && (!previous.live || rendererChanged)) {
			if (filter.trim().length === 0) {
				void load(pathRef.current);
			}
			reloadViewerRef.current();
		}
	}, [wsId, live, rendererTarget, load, filter]);

	// 検索（300msデバウンス）。クエリが空になったら結果をクリアしてツリー表示へ戻る。
	useEffect(() => {
		const query = filter.trim();
		const gen = ++searchGenRef.current;
		if (query.length === 0) {
			lastSearchKeyRef.current = undefined;
			setFindResult(undefined);
			setGrepResult(undefined);
			setSearching(false);
			return;
		}
		if (!wsId || !live) {
			setSearching(false);
			return;
		}
		const searchKey = `${wsId}\0${searchMode}\0${query}`;
		const requestTarget = rendererTarget;
		if (lastSearchKeyRef.current === searchKey) {
			return;
		}
		lastSearchKeyRef.current = searchKey;
		setFindResult(undefined);
		setGrepResult(undefined);
		setSearching(true);
		const timer = setTimeout(async () => {
			try {
				if (searchMode === 'name') {
					const result = await fsFind(wsId, query);
					if (searchGenRef.current === gen && currentRendererTarget(wsId) === requestTarget) {
						setFindResult(result);
						setGrepResult(undefined);
					}
				} else {
					const result = await fsGrep(wsId, query);
					if (searchGenRef.current === gen && currentRendererTarget(wsId) === requestTarget) {
						setGrepResult(result);
						setFindResult(undefined);
					}
				}
			} catch {
				// 接続断・タイムアウト等。結果は更新しない（次の入力で再試行）。
			} finally {
				if (searchGenRef.current === gen && currentRendererTarget(wsId) === requestTarget) {
					setSearching(false);
				}
			}
		}, 300);
		return () => clearTimeout(timer);
	}, [filter, searchMode, wsId, live, rendererTarget, fsFind, fsGrep]);

	const openViewer = async (p: string, line?: number) => {
		if (!live) {
			return;
		}
		const viewerGen = ++viewerGenRef.current;
		const requestTarget = rendererTarget;
		sheetGenRef.current++;
		viewerPathRef.current = p;
		setViewerPath(p);
		setViewerResult(undefined);
		setViewerXlsx(undefined);
		setViewerPdf(undefined);
		setViewerDocx(undefined);
		setViewerMedia(undefined);
		setViewerLine(line);
		if (!wsId) {
			return;
		}
		try {
			if (/\.(?:xlsx|xlsm)$/i.test(p)) {
				// Excel は PC 側でレンダリングされた静的HTML（1シート分）を受け取る。
				// シート一覧はビューアのネイティブタブになり、切替時に個別要求する
				const result = await fsXlsx(wsId, p);
				if (viewerGenRef.current === viewerGen && viewerPathRef.current === p && currentRendererTarget(wsId) === requestTarget) {
					setViewerXlsx({ html: result.html, sheets: result.sheets, sheet: result.sheet });
				}
			} else if (/\.pdf$/i.test(p)) {
				// PDF はバイナリを base64 で受け取り、キャッシュへ書き出して WKWebView でネイティブ表示する
				const result = await fsPdf(wsId, p);
				if (viewerGenRef.current === viewerGen && viewerPathRef.current === p && currentRendererTarget(wsId) === requestTarget) {
					setViewerPdf(result.data);
				}
			} else if (/\.docx$/i.test(p)) {
				// Word はバイナリを base64 で受け取り、WebView 内の docx-preview（PC版と同じ
				// vendored ライブラリ）でレンダリングする
				const result = await fsDocx(wsId, p);
				if (viewerGenRef.current === viewerGen && viewerPathRef.current === p && currentRendererTarget(wsId) === requestTarget) {
					setViewerDocx(result.data);
				}
			} else if (MEDIA_FILE_PATTERN.test(p)) {
				// 画像・動画・音声はバイナリを base64 で受け取る（画像は data URI、
				// 動画/音声はキャッシュファイル経由の WKWebView ネイティブ再生で表示する）
				const result = await fsMedia(wsId, p);
				if (viewerGenRef.current === viewerGen && viewerPathRef.current === p && currentRendererTarget(wsId) === requestTarget) {
					setViewerMedia(result.data);
				}
			} else {
				// highlight=true でPCの現行テーマそのままのハイライトHTMLを受け取る
				const result = await fsRead(wsId, p, true);
				if (viewerGenRef.current === viewerGen && viewerPathRef.current === p && currentRendererTarget(wsId) === requestTarget) {
					setViewerResult(result);
				}
			}
		} catch (e) {
			if (viewerGenRef.current === viewerGen && viewerPathRef.current === p && currentRendererTarget(wsId) === requestTarget) {
				setViewerResult({ content: `エラー: ${String(e instanceof Error ? e.message : e)}`, truncated: false, size: 0 });
			}
		}
	};
	reloadViewerRef.current = () => {
		const currentPath = viewerPathRef.current;
		if (currentPath !== undefined) {
			void openViewer(currentPath, viewerLine);
		}
	};

	const selectSheet = async (index: number) => {
		const p = viewerPath;
		if (!live || !wsId || p === undefined) {
			return;
		}
		// 表示中のHTMLは残したままシートだけ差し替える（タブ位置は即時反映）
		setViewerXlsx(prev => prev ? { ...prev, sheet: index, html: undefined } : prev);
		const viewerGen = viewerGenRef.current;
		const gen = ++sheetGenRef.current;
		const requestTarget = rendererTarget;
		try {
			const result = await fsXlsx(wsId, p, index);
			if (viewerGenRef.current === viewerGen && viewerPathRef.current === p && sheetGenRef.current === gen && currentRendererTarget(wsId) === requestTarget) {
				setViewerXlsx({ html: result.html, sheets: result.sheets, sheet: result.sheet });
			}
		} catch (e) {
			if (viewerGenRef.current === viewerGen && viewerPathRef.current === p && sheetGenRef.current === gen && currentRendererTarget(wsId) === requestTarget) {
				setViewerResult({ content: `エラー: ${String(e instanceof Error ? e.message : e)}`, truncated: false, size: 0 });
			}
		}
	};

	const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
	const entries = listing?.entries ?? [];
	const crumbs = [ws?.name ?? '', ...path.split('/').filter(Boolean)];
	const searchActive = filter.trim().length > 0;

	return (
		<View style={styles.screen}>
			<View style={styles.searchBox}>
				<Ionicons name="search-outline" size={14} color={colors.textDim} />
				<TextInput
					style={styles.searchInput}
					value={filter}
					onChangeText={setFilter}
					editable={live}
					placeholder={searchMode === 'name' ? 'ファイル名で検索（全階層）…' : 'テキストで検索（全文）…'}
					placeholderTextColor={colors.textDim}
					autoCapitalize="none"
					autoCorrect={false}
					onFocus={() => hapticSelection()}
				/>
				{searching ? <ActivityIndicator size="small" color={colors.textDim} /> : null}
				<Pressable
					disabled={!live}
					style={[styles.modeChip, searchMode === 'name' && styles.modeChipActive]}
					onPress={() => { hapticSelection(); setSearchMode('name'); }}
				>
					<Text style={[styles.modeText, searchMode === 'name' && styles.modeTextActive]}>名前</Text>
				</Pressable>
				<Pressable
					disabled={!live}
					style={[styles.modeChip, searchMode === 'text' && styles.modeChipActive]}
					onPress={() => { hapticSelection(); setSearchMode('text'); }}
				>
					<Text style={[styles.modeText, searchMode === 'text' && styles.modeTextActive]}>内容</Text>
				</Pressable>
			</View>
			{!searchActive ? <Text style={styles.breadcrumb} numberOfLines={1}>{crumbs.join(' › ')}</Text> : null}
			<ScrollView
				style={styles.list}
				contentContainerStyle={{ paddingBottom: tabBarSpacer }}
				keyboardShouldPersistTaps="handled"
				refreshControl={!searchActive ? <RefreshControl refreshing={loading} onRefresh={() => { void load(path); }} tintColor={colors.textDim} /> : undefined}
			>
				{error && !searchActive ? <Text style={styles.error}>{error}</Text> : null}
				{searchActive ? (
					<>
						{findResult !== undefined ? (
							<>
								{findResult.files.map(p => (
									<Pressable key={p} style={styles.row} onPress={() => { hapticSelection(); void openViewer(p); }}>
										<Ionicons name="document-text-outline" size={16} color={colors.textDim} />
										<View style={styles.resultCol}>
											<Text style={styles.rowName} numberOfLines={1}>{p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p}</Text>
											{p.includes('/') ? <Text style={styles.resultPath} numberOfLines={1}>{p.slice(0, p.lastIndexOf('/'))}</Text> : null}
										</View>
									</Pressable>
								))}
								{findResult.files.length === 0 && !searching ? <Text style={styles.dimNote}>一致するファイルがありません</Text> : null}
								{findResult.truncated ? <Text style={styles.dimNote}>（結果が多いため一部のみ表示しています）</Text> : null}
							</>
						) : grepResult !== undefined ? (
							<>
								{grepResult.matches.map((m, i) => (
									<Pressable key={`${m.path}:${m.line}:${i}`} style={styles.row} onPress={() => { hapticSelection(); void openViewer(m.path, m.line); }}>
										<View style={styles.resultCol}>
											<Text style={styles.resultPath} numberOfLines={1}>{m.path}:{m.line}</Text>
											<Text style={styles.resultPreview} numberOfLines={2}>{m.text}</Text>
										</View>
									</Pressable>
								))}
								{grepResult.matches.length === 0 && !searching ? <Text style={styles.dimNote}>一致する箇所がありません</Text> : null}
								{grepResult.truncated ? <Text style={styles.dimNote}>（結果が多いため一部のみ表示しています）</Text> : null}
							</>
						) : (
							<Text style={styles.dimNote}>{searching ? '検索中…' : '接続後に検索条件を編集すると再検索できます'}</Text>
						)}
					</>
				) : (
					<>
						{loading && !listing ? <ActivityIndicator style={styles.spinner} /> : null}
						{path !== '' ? (
							<Pressable disabled={!live} style={styles.row} onPress={() => { hapticSelection(); void load(parent, true); }}>
								<Ionicons name="folder-outline" size={16} color={colors.textDim} />
								<Text style={styles.rowName}>..</Text>
							</Pressable>
						) : null}
						{entries.map(entry => {
							const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
							return (
								<Pressable
									key={entry.name}
									disabled={!live}
									style={styles.row}
									onPress={() => { hapticSelection(); entry.dir ? void load(childPath, true) : void openViewer(childPath); }}
								>
									<Ionicons name={entry.dir ? 'folder-outline' : 'document-text-outline'} size={16} color={entry.dir ? colors.accent : colors.textDim} />
									<Text style={styles.rowName} numberOfLines={1}>{entry.name}</Text>
									{!entry.dir && entry.size !== undefined ? <Text style={styles.size}>{formatSize(entry.size)}</Text> : null}
								</Pressable>
							);
						})}
					</>
				)}
			</ScrollView>
			{viewerPath !== undefined ? (
				<FileViewer
					path={viewerPath}
					result={viewerResult}
					spreadsheetHtml={viewerXlsx?.html}
					sheets={viewerXlsx?.sheets}
					sheetIndex={viewerXlsx?.sheet}
					onSelectSheet={i => { void selectSheet(i); }}
					focusLine={viewerLine}
					pdfData={viewerPdf}
					docxData={viewerDocx}
					mediaData={viewerMedia}
					onClose={() => { viewerGenRef.current++; sheetGenRef.current++; viewerPathRef.current = undefined; setViewerPath(undefined); setViewerResult(undefined); setViewerXlsx(undefined); setViewerPdf(undefined); setViewerDocx(undefined); setViewerMedia(undefined); setViewerLine(undefined); }}
				/>
			) : null}
		</View>
	);
}

function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.panel, borderRadius: 10, borderWidth: 1, borderColor: colors.border, marginHorizontal: 16, paddingHorizontal: 12 },
	searchInput: { flex: 1, color: colors.text, fontSize: 13, paddingVertical: 9 },
	breadcrumb: { color: colors.textDim, fontSize: 12, paddingHorizontal: 16, paddingVertical: 8 },
	list: { flex: 1, paddingHorizontal: 16 },
	spinner: { marginTop: 16 },
	error: { color: colors.red, fontSize: 12, marginVertical: 8 },
	row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#21262d' },
	rowName: { flex: 1, color: colors.text, fontSize: 14 },
	size: { color: colors.textDim, fontSize: 11 },
	modeChip: { borderRadius: 8, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 8, paddingVertical: 4 },
	modeChipActive: { borderColor: colors.accent2, backgroundColor: 'rgba(9,175,217,.16)' },
	modeText: { color: colors.textDim, fontSize: 11 },
	modeTextActive: { color: colors.text, fontWeight: '600' },
	resultCol: { flex: 1, gap: 2 },
	resultPath: { color: colors.textDim, fontSize: 11 },
	resultPreview: { color: colors.text, fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	dimNote: { color: colors.textDim, fontSize: 12, paddingVertical: 12, textAlign: 'center' },
});
