// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, type StyleProp, type TextStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { FileViewer, MEDIA_FILE_PATTERN } from './fileViewer.js';
import { useEffectiveWs } from './wsDrawer.js';
import { useTabBarSpacer } from '../hooks/useTabBarSpacer.js';
import { matchRanges, useFilesSearch } from '../filesSearch.js';
import { colors, radius, squircle } from '../theme.js';
import { hapticSelection } from '../haptics.js';
import type { FsFindResult, FsGrepResult, FsListResult, FsReadResult } from '../store.js';

/**
 * ファイル操作が通るか（PCと繋がっていて、そのスペースを持つウィンドウのrendererが起きている）。
 *
 * **検索欄（ヘッダーの帯）と一覧で同じ判定を使うために公開している。** 粗い判定
 * （接続だけ見る）を欄側に置くと、rendererの準備待ちのあいだだけ欄が編集できてしまい、
 * 「古い結果に新しい条件が付いている」状態が作れる。
 */
export function useFilesLive(): boolean {
	const { connection, pcOnline, sessionProtocolReady, workspace } = useAppStore(useShallow(s => ({
		connection: s.connection, pcOnline: s.pcOnline, sessionProtocolReady: s.sessionProtocolReady, workspace: s.workspace,
	})));
	const ws = useEffectiveWs();
	const selectedWorkspace = workspace?.workspaces.find(candidate => candidate.id === ws?.id);
	const renderer = selectedWorkspace !== undefined ? workspace?.renderers.find(candidate => candidate.windowId === selectedWorkspace.windowId) : undefined;
	return connection === 'online' && pcOnline && sessionProtocolReady && renderer?.ready === true;
}

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
export function FilesPanel({ contentInsetTop = 0, searchOpen = false }: {
	/**
	 * 上に浮かぶヘッダー（開いているときは検索欄の帯も含む）の高さ。この画面は
	 * ScrollView の中身側でこのぶん上を空ける。
	 */
	contentInsetTop?: number;
	/**
	 * 検索欄が開いているか。**欄そのものはヘッダーの帯にある**（{@link FilesSearchField}）。
	 * ここでは「結果を出すかツリーを出すか」の判断にだけ使う。
	 */
	searchOpen?: boolean;
}) {
	const ws = useEffectiveWs();
	const { fsList, fsRead, fsXlsx, fsPdf, fsDocx, fsMedia, fsFind, fsGrep, workspace } = useAppStore(useShallow(s => ({ fsList: s.fsList, fsRead: s.fsRead, fsXlsx: s.fsXlsx, fsPdf: s.fsPdf, fsDocx: s.fsDocx, fsMedia: s.fsMedia, fsFind: s.fsFind, fsGrep: s.fsGrep, workspace: s.workspace })));
	const selectedWorkspace = workspace?.workspaces.find(candidate => candidate.id === ws?.id);
	const selectedRenderer = selectedWorkspace !== undefined ? workspace?.renderers.find(candidate => candidate.windowId === selectedWorkspace.windowId) : undefined;
	const rendererTarget = selectedRenderer?.ready === true && workspace !== undefined
		? `${workspace.desktopEpoch}:${selectedRenderer.windowId}:${selectedRenderer.rendererGeneration}`
		: undefined;
	// **判定は `useFilesLive()` に寄せる。** 検索欄（ヘッダーの帯）と同じ規則を2箇所に
	// 書いておくと、どちらか片方に条件が増えたときに静かにずれる（欄だけ編集できてしまう等）。
	// `rendererTarget` は「どのrendererへ出した要求か」の照合に使うので、こちらは残す。
	const live = useFilesLive();

	const tabBarSpacer = useTabBarSpacer();
	const [path, setPath] = useState('');
	const pathRef = useRef('');
	const scrollRef = useRef<ScrollView>(null);
	const [listing, setListing] = useState<FsListResult | undefined>();
	// 検索条件は欄（ヘッダーの帯）と共有するのでストアが持つ。
	const { filter, searchMode } = useFilesSearch(useShallow(s => ({ filter: s.query, searchMode: s.mode })));
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
				useFilesSearch.getState().clear();
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
			useFilesSearch.getState().clear();
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

	// 検索欄は本文の先頭にあるので、下まで読んでから開くと欄が画面の外に居る。
	// 開いた瞬間に先頭へ戻して、出てきたキーボードと欄が同じ画面に収まるようにする。
	useEffect(() => {
		if (searchOpen) {
			scrollRef.current?.scrollTo({ y: 0, animated: true });
		}
	}, [searchOpen]);

	const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
	const entries = listing?.entries ?? [];
	const crumbs = [ws?.name ?? '', ...path.split('/').filter(Boolean)];
	// 欄を畳んだら検索状態も畳む。文字を残したまま閉じられると、パンくずが消えたまま
	// 検索結果だけが出続け、何で絞られているかを見る手段も消す手段も無くなる。
	const searchActive = searchOpen && filter.trim().length > 0;

	return (
		<View style={styles.screen}>
			<ScrollView
				ref={scrollRef}
				style={styles.list}
				// ヘッダーは浮いているので、本文の余白はスクロールの中身側に入れる。
				// 外側の paddingTop にすると本文が下へ押し出されるだけで、島の下を通らない。
				contentContainerStyle={{ paddingTop: contentInsetTop, paddingBottom: tabBarSpacer }}
				keyboardShouldPersistTaps="handled"
				// **RefreshControl は出し入れしない。** RNのScrollViewはiOSでこれを子として差し込む
				// ので、ある／無しで子の並びが [refresh, content] → content に変わり、Reactが並びの
				// 1番目を突き合わせて**中身のツリーを丸ごと作り直す**。検索欄のTextInputがそこで
				// 外れてキーボードが閉じ、`autoFocus` が張り直してまた出る（＝「1文字打つとキーボードが
				// 一度消えて出直す」の正体。1文字目で searchActive が false→true になる瞬間だけ
				// 起きるのも一致していた）。常に置いて、検索中は引っぱっても何もしないだけにする。
				refreshControl={
					<RefreshControl
						refreshing={loading && !searchActive}
						onRefresh={() => { if (!searchActive) { void load(path); } }}
						tintColor={colors.textDim}
						progressViewOffset={contentInsetTop}
					/>
				}
			>
				{!searchActive ? <Text style={styles.breadcrumb} numberOfLines={1}>{crumbs.join(' › ')}</Text> : null}
				{error && !searchActive ? <Text style={styles.error}>{error}</Text> : null}
				{searchActive ? (
					<>
						{findResult !== undefined ? (
							<>
								{/* 行はカードに収める（SCMと同じ作法）。素の下線リストだと4タブでここだけ言語が違って見える。 */}
								{findResult.files.length > 0 ? <View style={styles.card}>
									{findResult.files.map((p, i) => (
										<Pressable key={p} style={[styles.row, i === findResult.files.length - 1 && styles.rowLast]} onPress={() => { hapticSelection(); void openViewer(p); }}>
											<Ionicons name="document-text-outline" size={16} color={colors.textDim} />
											<View style={styles.resultCol}>
												<Highlighted text={p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p} query={filter} smartCase={false} lines={1} style={styles.rowName} />
												{p.includes('/') ? <Highlighted text={p.slice(0, p.lastIndexOf('/'))} query={filter} smartCase={false} lines={1} style={styles.resultPath} /> : null}
											</View>
										</Pressable>
									))}
								</View> : null}
								{findResult.files.length === 0 && !searching ? <Text style={styles.dimNote}>一致するファイルがありません</Text> : null}
								{findResult.truncated ? <Text style={styles.dimNote}>（結果が多いため一部のみ表示しています）</Text> : null}
							</>
						) : grepResult !== undefined ? (
							<>
								{grepResult.matches.length > 0 ? <View style={styles.card}>
									{grepResult.matches.map((m, i) => (
										<Pressable key={`${m.path}:${m.line}:${i}`} style={[styles.row, i === grepResult.matches.length - 1 && styles.rowLast]} onPress={() => { hapticSelection(); void openViewer(m.path, m.line); }}>
											<View style={styles.resultCol}>
												<Text style={styles.resultPath} numberOfLines={1}>{m.path}:{m.line}</Text>
												<Highlighted text={m.text} query={filter} smartCase lines={2} style={styles.resultPreview} />
											</View>
										</Pressable>
									))}
								</View> : null}
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
						{/* 行はカードに収める（SCMと同じ作法）。「..」も同じカードの先頭行として扱う。
						    出す行が1つも無いとき（ルートで空・読み込み中）は枠だけの空箱を出さない。 */}
						{(path !== '' || entries.length > 0) ? <View style={styles.card}>
							{path !== '' ? (
								<Pressable disabled={!live} style={[styles.row, entries.length === 0 && styles.rowLast]} onPress={() => { hapticSelection(); void load(parent, true); }}>
									<Ionicons name="folder-outline" size={16} color={colors.textDim} />
									<Text style={styles.rowName}>..</Text>
								</Pressable>
							) : null}
							{entries.map((entry, i) => {
								const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
								return (
									<Pressable
										key={entry.name}
										disabled={!live}
										style={[styles.row, i === entries.length - 1 && styles.rowLast]}
										onPress={() => { hapticSelection(); entry.dir ? void load(childPath, true) : void openViewer(childPath); }}
									>
										<Ionicons name={entry.dir ? 'folder-outline' : 'document-text-outline'} size={16} color={entry.dir ? colors.accent : colors.textDim} />
										<Text style={styles.rowName} numberOfLines={1}>{entry.name}</Text>
										{!entry.dir && entry.size !== undefined ? <Text style={styles.size}>{formatSize(entry.size)}</Text> : null}
									</Pressable>
								);
							})}
						</View> : null}
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

/**
 * 一致した箇所を primary の色＋太字で示す。
 *
 * 色を増やさないため、地は敷かない（モノスペースの行に地色が入ると行がうるさくなる）。
 * 分割の規則は `matchRanges`（PC側 ripgrep と同じスマートケース・リテラル一致）。
 */
function Highlighted({ text, query, smartCase, lines, style }: {
	text: string;
	query: string;
	/** 全文検索のときだけ true（PC側の規則に合わせる。`matchRanges` の説明を参照）。 */
	smartCase: boolean;
	lines: number;
	style: StyleProp<TextStyle>;
}) {
	const ranges = matchRanges(text, query, smartCase);
	if (ranges.length === 0) {
		return <Text style={style} numberOfLines={lines}>{text}</Text>;
	}
	const parts: ReactNode[] = [];
	let at = 0;
	for (const [index, range] of ranges.entries()) {
		if (range.start > at) {
			parts.push(text.slice(at, range.start));
		}
		parts.push(<Text key={index} style={styles.hit}>{text.slice(range.start, range.end)}</Text>);
		at = range.end;
	}
	if (at < text.length) {
		parts.push(text.slice(at));
	}
	return <Text style={style} numberOfLines={lines}>{parts}</Text>;
}

/**
 * 検索欄。**ヘッダーの帯**（常設のヘッダー層）に置く（`app/(tabs)/files.tsx`）。
 *
 * 以前は本文の先頭に `searchOpen ? <View> : null` で出していたので、ぱっと現れるうえ、
 * 下まで読むと欄が画面の外に居た。帯に移すと島の下から滑り出し、スクロールしても消えない。
 *
 * 入力は uncontrolled（`value` を渡さない）。ストアへは `onChangeText` で流すだけにして、
 * 再レンダーで未確定のIME文字列へ書き戻さない（space-note.tsx / glassComposer.tsx と同じ流儀）。
 */
export function FilesSearchField({ onClose, live }: {
	onClose: () => void;
	/** PCと繋がっているか。切断中は編集させない（古い結果に新しい条件が付いて見えるため）。 */
	live: boolean;
}) {
	// **`query` は購読しない。** ここは uncontrolled（`defaultValue`）で、購読すると打鍵ごとに
	// `defaultValue` が変わって実質 controlled になり、IMEの未確定文字列へ書き戻す経路が開く。
	const { mode, focusRequested, clearedAt, setQuery, setMode, consumeFocus } = useFilesSearch(useShallow(s => ({
		mode: s.mode, focusRequested: s.focusRequested, clearedAt: s.clearedAt,
		setQuery: s.setQuery, setMode: s.setMode, consumeFocus: s.consumeFocus,
	})));
	const inputRef = useRef<TextInput>(null);
	// 初期値はマウント時に1回だけ読む（タブを行き来して作り直されたときに前の入力が戻る）。
	const initialQuery = useRef(useFilesSearch.getState().query).current;

	// **`autoFocus` は使わない。** 帯はタブを移るだけでもアンマウントされるので、
	// `autoFocus` だと戻ってきた瞬間に勝手にキーボードが立ち上がる。
	// 「ユーザーが開いた」ときだけ当てる（要求は一度で消費する）。
	useEffect(() => {
		if (!focusRequested) {
			return;
		}
		// **消費するのはタイマーの中で。** 先頭で `consumeFocus()` を呼ぶと `focusRequested` が
		// false になり、それを購読しているこの欄が再レンダー → 依存が変わって**この effect の
		// cleanup が 40ms を待たずにタイマーを消す**（＝フォーカスが一度も当たらない）。
		// 発火後の cleanup は既に走ったタイマーへの `clearTimeout` なので無害。
		const timer = setTimeout(() => {
			inputRef.current?.focus();
			consumeFocus();
		}, 40);
		return () => clearTimeout(timer);
	}, [focusRequested, consumeFocus]);

	// 外から条件を捨てられたとき（ワークスペース切り替え等）は、表示中の文字も消す。
	// uncontrolled なので、ストアを空にしただけでは欄に残る。
	const firstClear = useRef(clearedAt);
	useEffect(() => {
		if (clearedAt !== firstClear.current) {
			inputRef.current?.clear();
		}
	}, [clearedAt]);

	return (
		<View style={styles.searchBox}>
			<Ionicons name="search-outline" size={14} color={colors.textDim} />
			<TextInput
				ref={inputRef}
				style={styles.searchInput}
				defaultValue={initialQuery}
				onChangeText={setQuery}
				editable={live}
				placeholder={mode === 'name' ? 'ファイル名で検索（全階層）…' : 'テキストで検索（全文）…'}
				placeholderTextColor={colors.textDim}
				autoCapitalize="none"
				autoCorrect={false}
				returnKeyType="search"
				accessibilityLabel="検索条件"
			/>
			{(['name', 'text'] as const).map(candidate => (
				<Pressable
					key={candidate}
					disabled={!live}
					style={[styles.modeChip, mode === candidate && styles.modeChipActive]}
					onPress={() => { hapticSelection(); setMode(candidate); }}
					accessibilityRole="button"
					accessibilityState={{ selected: mode === candidate }}
					accessibilityLabel={candidate === 'name' ? 'ファイル名で検索' : '内容で検索'}
				>
					<Text style={[styles.modeText, mode === candidate && styles.modeTextActive]}>{candidate === 'name' ? '名前' : '内容'}</Text>
				</Pressable>
			))}
			<Pressable
				style={styles.searchClose}
				onPress={() => { hapticSelection(); onClose(); }}
				hitSlop={8}
				accessibilityRole="button"
				accessibilityLabel="検索を閉じる"
			>
				<Ionicons name="close" size={15} color={colors.textDim} />
			</Pressable>
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
	searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.panel, borderRadius: radius.control, ...squircle, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12 },
	searchInput: { flex: 1, color: colors.text, fontSize: 13, paddingVertical: 9 },
	searchClose: { padding: 2 },
	breadcrumb: { color: colors.textDim, fontSize: 12, paddingVertical: 8 },
	list: { flex: 1, paddingHorizontal: 16 },
	spinner: { marginTop: 16 },
	error: { color: colors.red, fontSize: 12, marginVertical: 8 },
	// 行を収める札。SCMのカードと同じ面（surface + 枠線 + 角丸14）。
	card: { backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.card, ...squircle, paddingHorizontal: 14, marginBottom: 8 },
	row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
	// カードの最終行。締めの下線はカードの縁が担うので消す。
	rowLast: { borderBottomWidth: 0 },
	rowName: { flex: 1, color: colors.text, fontSize: 14 },
	size: { color: colors.textDim, fontSize: 11 },
	modeChip: { borderRadius: radius.pill, ...squircle, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 9, paddingVertical: 4 },
	modeChipActive: { borderColor: colors.accent2, backgroundColor: 'rgba(9,175,217,.16)' },
	modeText: { color: colors.textDim, fontSize: 11 },
	modeTextActive: { color: colors.text, fontWeight: '600' },
	resultCol: { flex: 1, gap: 2 },
	resultPath: { color: colors.textDim, fontSize: 11 },
	resultPreview: { color: colors.text, fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	dimNote: { color: colors.textDim, fontSize: 12, paddingVertical: 12, textAlign: 'center' },
	// 一致箇所。色だけで示し、地は敷かない（モノスペースの行を壊さない）。
	hit: { color: colors.accent, fontWeight: '700' },
});
