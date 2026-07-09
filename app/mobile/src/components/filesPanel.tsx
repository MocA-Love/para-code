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
	const { fsList, fsRead, fsXlsx, fsPdf, fsDocx, fsMedia, fsFind, fsGrep, connection } = useAppStore(useShallow(s => ({ fsList: s.fsList, fsRead: s.fsRead, fsXlsx: s.fsXlsx, fsPdf: s.fsPdf, fsDocx: s.fsDocx, fsMedia: s.fsMedia, fsFind: s.fsFind, fsGrep: s.fsGrep, connection: s.connection })));

	const tabBarSpacer = useTabBarSpacer();
	const [path, setPath] = useState('');
	const [listing, setListing] = useState<FsListResult | undefined>();
	const [filter, setFilter] = useState('');
	const [searchMode, setSearchMode] = useState<'name' | 'text'>('name');
	const [findResult, setFindResult] = useState<FsFindResult | undefined>();
	const [grepResult, setGrepResult] = useState<FsGrepResult | undefined>();
	const [searching, setSearching] = useState(false);
	// 入力デバウンスと応答順序の入れ替わり対策（最後に発行したクエリのみ反映する）
	const searchGenRef = useRef(0);
	const [error, setError] = useState<string | undefined>();
	const [loading, setLoading] = useState(false);
	const [viewerPath, setViewerPath] = useState<string | undefined>();
	const [viewerResult, setViewerResult] = useState<FsReadResult | undefined>();
	const [viewerXlsx, setViewerXlsx] = useState<{ html?: string; sheets?: string[]; sheet?: number } | undefined>();
	const [viewerPdf, setViewerPdf] = useState<string | undefined>();
	const [viewerDocx, setViewerDocx] = useState<string | undefined>();
	const [viewerMedia, setViewerMedia] = useState<string | undefined>();
	const [viewerLine, setViewerLine] = useState<number | undefined>();
	// 開く→閉じる→別ファイルを開く、の間に前のfetchが解決して上書きするのを防ぐ世代ガード
	const viewerPathRef = useRef<string | undefined>(undefined);
	// 同一ファイル内でシートを素早く切り替えた際、古いシート応答が新しい選択を上書きするのを防ぐ世代ガード
	const sheetGenRef = useRef(0);

	const wsId = ws?.id;

	const load = useCallback(async (p: string) => {
		if (!wsId || connection !== 'online') {
			return;
		}
		setError(undefined);
		setLoading(true);
		try {
			setListing(await fsList(wsId, p));
			setPath(p);
			setFilter('');
		} catch (e) {
			setError(String(e instanceof Error ? e.message : e));
		} finally {
			setLoading(false);
		}
	}, [fsList, wsId, connection]);

	useEffect(() => {
		setListing(undefined);
		setViewerPath(undefined);
		setViewerResult(undefined);
		setFindResult(undefined);
		setGrepResult(undefined);
		void load('');
	}, [load]);

	// 検索（300msデバウンス）。クエリが空になったら結果をクリアしてツリー表示へ戻る。
	useEffect(() => {
		const query = filter.trim();
		const gen = ++searchGenRef.current;
		if (!wsId || connection !== 'online' || query.length === 0) {
			setFindResult(undefined);
			setGrepResult(undefined);
			setSearching(false);
			return;
		}
		setSearching(true);
		const timer = setTimeout(async () => {
			try {
				if (searchMode === 'name') {
					const result = await fsFind(wsId, query);
					if (searchGenRef.current === gen) {
						setFindResult(result);
						setGrepResult(undefined);
					}
				} else {
					const result = await fsGrep(wsId, query);
					if (searchGenRef.current === gen) {
						setGrepResult(result);
						setFindResult(undefined);
					}
				}
			} catch {
				// 接続断・タイムアウト等。結果は更新しない（次の入力で再試行）。
			} finally {
				if (searchGenRef.current === gen) {
					setSearching(false);
				}
			}
		}, 300);
		return () => clearTimeout(timer);
	}, [filter, searchMode, wsId, connection, fsFind, fsGrep]);

	const openViewer = async (p: string, line?: number) => {
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
				if (viewerPathRef.current === p) {
					setViewerXlsx({ html: result.html, sheets: result.sheets, sheet: result.sheet });
				}
			} else if (/\.pdf$/i.test(p)) {
				// PDF はバイナリを base64 で受け取り、キャッシュへ書き出して WKWebView でネイティブ表示する
				const result = await fsPdf(wsId, p);
				if (viewerPathRef.current === p) {
					setViewerPdf(result.data);
				}
			} else if (/\.docx$/i.test(p)) {
				// Word はバイナリを base64 で受け取り、WebView 内の docx-preview（PC版と同じ
				// vendored ライブラリ）でレンダリングする
				const result = await fsDocx(wsId, p);
				if (viewerPathRef.current === p) {
					setViewerDocx(result.data);
				}
			} else if (MEDIA_FILE_PATTERN.test(p)) {
				// 画像・動画・音声はバイナリを base64 で受け取る（画像は data URI、
				// 動画/音声はキャッシュファイル経由の WKWebView ネイティブ再生で表示する）
				const result = await fsMedia(wsId, p);
				if (viewerPathRef.current === p) {
					setViewerMedia(result.data);
				}
			} else {
				// highlight=true でPCの現行テーマそのままのハイライトHTMLを受け取る
				const result = await fsRead(wsId, p, true);
				if (viewerPathRef.current === p) {
					setViewerResult(result);
				}
			}
		} catch (e) {
			if (viewerPathRef.current === p) {
				setViewerResult({ content: `エラー: ${String(e instanceof Error ? e.message : e)}`, truncated: false, size: 0 });
			}
		}
	};

	const selectSheet = async (index: number) => {
		const p = viewerPath;
		if (!wsId || p === undefined) {
			return;
		}
		// 表示中のHTMLは残したままシートだけ差し替える（タブ位置は即時反映）
		setViewerXlsx(prev => prev ? { ...prev, sheet: index, html: undefined } : prev);
		const gen = ++sheetGenRef.current;
		try {
			const result = await fsXlsx(wsId, p, index);
			if (viewerPathRef.current === p && sheetGenRef.current === gen) {
				setViewerXlsx({ html: result.html, sheets: result.sheets, sheet: result.sheet });
			}
		} catch (e) {
			if (viewerPathRef.current === p && sheetGenRef.current === gen) {
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
					placeholder={searchMode === 'name' ? 'ファイル名で検索（全階層）…' : 'テキストで検索（全文）…'}
					placeholderTextColor={colors.textDim}
					autoCapitalize="none"
					autoCorrect={false}
					onFocus={() => hapticSelection()}
				/>
				{searching ? <ActivityIndicator size="small" color={colors.textDim} /> : null}
				<Pressable
					style={[styles.modeChip, searchMode === 'name' && styles.modeChipActive]}
					onPress={() => { hapticSelection(); setSearchMode('name'); }}
				>
					<Text style={[styles.modeText, searchMode === 'name' && styles.modeTextActive]}>名前</Text>
				</Pressable>
				<Pressable
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
							<Text style={styles.dimNote}>検索中…</Text>
						)}
					</>
				) : (
					<>
						{loading && !listing ? <ActivityIndicator style={styles.spinner} /> : null}
						{path !== '' ? (
							<Pressable style={styles.row} onPress={() => { hapticSelection(); void load(parent); }}>
								<Ionicons name="folder-outline" size={16} color={colors.textDim} />
								<Text style={styles.rowName}>..</Text>
							</Pressable>
						) : null}
						{entries.map(entry => {
							const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
							return (
								<Pressable
									key={entry.name}
									style={styles.row}
									onPress={() => { hapticSelection(); entry.dir ? void load(childPath) : void openViewer(childPath); }}
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
					onClose={() => { viewerPathRef.current = undefined; setViewerPath(undefined); setViewerResult(undefined); setViewerXlsx(undefined); setViewerPdf(undefined); setViewerDocx(undefined); setViewerMedia(undefined); setViewerLine(undefined); }}
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
