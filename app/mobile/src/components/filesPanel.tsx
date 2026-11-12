// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { EmptyState } from './emptyState.js';
import { FilesBreadcrumbs as Breadcrumbs } from './filesBreadcrumbs.js';
import { LoadingState, UnavailableNote } from './listStates.js';
import { breadcrumbItems } from '../filesBreadcrumb.js';
import { fileViewerHref } from '../features/code/codeRoutes.js';
import { useWorkspaceUnavailableReason } from '../hooks/useWorkspaceUnavailableReason.js';
import { useEffectiveWs } from './wsDrawer.js';
import { useTabBarSpacer } from '../hooks/useTabBarSpacer.js';
import { matchRanges, useFilesSearch } from '../filesSearch.js';
import { useFilesLive } from '../filesLive.js';
import { monoFamily } from '../monoFont.js';
import { HIT_SIZE, colors, radius, squircle, type } from '../theme.js';
import { hapticImpact, hapticSelection } from '../haptics.js';
import type { FsFindResult, FsGrepResult, FsListResult, StoreState } from '../store.js';

/**
 * rendererTarget（どのrendererへ出した要求かの照合キー）の導出。セレクタ内からは
 * `currentRendererTargetOf(store状態)` で、命令的に取りたいときは
 * `currentRendererTarget()` を使う。ロジックを2箇所に書くと静かにずれるため共通化。
 */
function currentRendererTargetOf(state: StoreState, wsId: string | undefined): string | undefined {
	if (wsId === undefined || state.connection !== 'online' || !state.pcOnline || !state.sessionProtocolReady) {
		return undefined;
	}
	const selectedWorkspace = state.workspace?.workspaces.find(candidate => candidate.id === wsId);
	const renderer = selectedWorkspace !== undefined ? state.workspace?.renderers.find(candidate => candidate.windowId === selectedWorkspace.windowId) : undefined;
	return renderer?.ready === true && state.workspace !== undefined
		? `${state.workspace.desktopEpoch}:${renderer.windowId}:${renderer.rendererGeneration}`
		: undefined;
}

function currentRendererTarget(wsId: string | undefined): string | undefined {
	return currentRendererTargetOf(useAppStore.getState(), wsId);
}

/**
 * ファイルパネル（モックアップ mock-2.html 準拠、「その他」タブのセグメント）。
 * ワークスペースのファイルツリーを閲覧し、ファイルをタップするとファイルツリーと同じビューアの画面へ進む（読み取り専用）。
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
	const { fsList, fsFind, fsGrep, activePcId } = useAppStore(useShallow(s => ({ fsList: s.fsList, fsFind: s.fsFind, fsGrep: s.fsGrep, activePcId: s.activePcId })));
	const router = useRouter();
	// **`s.workspace` 本体を購読しない。** 必要なのは rendererTarget という文字列1つだけ。
	// 本体を買うと10Hz再送のたびに画面全体が再描画していた。セレクタの中で文字列まで
	// 導出すれば、中身が変わらない再送では同値判定が止まる（markdownText と同じ流儀）。
	const rendererTarget = useAppStore(s => currentRendererTargetOf(s, ws?.id));
	// **判定は `useFilesLive()` に寄せる。** 検索欄（ヘッダーの帯）と同じ規則を2箇所に
	// 書いておくと、どちらか片方に条件が増えたときに静かにずれる（欄だけ編集できてしまう等）。
	// `rendererTarget` は「どのrendererへ出した要求か」の照合に使うので、こちらは残す。
	const live = useFilesLive();
	// 押せないときの理由（一覧・検索の空状態に書く）。
	const unavailable = useWorkspaceUnavailableReason(ws?.id);

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
	// 検索の失敗（接続断・タイムアウト・PC側のエラー）。以前は握りつぶしていて、
	// 「一致なし」とも「検索中」とも区別が付かなかった。
	const [searchError, setSearchError] = useState<string | undefined>();
	// 「再検索」を押した回数。同じ条件でも検索し直すための合図（下の effect の依存に入れる）。
	const [searchRetry, setSearchRetry] = useState(0);
	// 入力デバウンスと応答順序の入れ替わり対策（最後に発行したクエリのみ反映する）
	const searchGenRef = useRef(0);
	const lastSearchKeyRef = useRef<string | undefined>(undefined);
	const loadContextRef = useRef<{ wsId: string | undefined; live: boolean; rendererTarget: string | undefined }>({ wsId: undefined, live: false, rendererTarget: undefined });
	const [error, setError] = useState<string | undefined>();
	const [loading, setLoading] = useState(false);
	const loadGenRef = useRef(0);
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
			pathRef.current = '';
			setPath('');
			useFilesSearch.getState().clear();
			setListing(undefined);
			setFindResult(undefined);
			setGrepResult(undefined);
			setSearchError(undefined);
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
			setSearchError(undefined);
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
		setSearchError(undefined);
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
			} catch (e) {
				// 接続断・タイムアウト等。理由を出し、「再検索」か次の入力で検索し直せるようにする。
				if (searchGenRef.current === gen && currentRendererTarget(wsId) === requestTarget) {
					setSearchError(String(e instanceof Error ? e.message : e));
				}
			} finally {
				if (searchGenRef.current === gen && currentRendererTarget(wsId) === requestTarget) {
					setSearching(false);
				}
			}
		}, 300);
		return () => clearTimeout(timer);
	}, [filter, searchMode, wsId, live, rendererTarget, fsFind, fsGrep, searchRetry]);

	const retrySearch = () => {
		hapticImpact('light');
		lastSearchKeyRef.current = undefined;
		setSearchRetry(count => count + 1);
	};

	// ファイルツリーと同じビューアの画面へ進む（iPad では詳細の列に積まれる）。
	const openViewer = (p: string, line?: number) => {
		if (!live || wsId === undefined || activePcId === undefined) {
			return;
		}
		router.push(fileViewerHref(activePcId, wsId, p, line));
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
	const crumbs = breadcrumbItems(ws?.name, path);
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
				{!searchActive ? (
					<Breadcrumbs crumbs={crumbs} disabled={!live} onSelect={target => { hapticSelection(); void load(target, true); }} />
				) : null}
				{searchActive ? (
					searchError !== undefined ? (
						<EmptyState icon="alert-circle-outline" title="検索に失敗しました" message={searchError} action={live ? { label: '再検索', onPress: retrySearch } : undefined} />
					) : findResult !== undefined ? (
						<>
							{/* 行はカードに収める（SCMと同じ作法）。素の下線リストだと4タブでここだけ言語が違って見える。 */}
							{findResult.files.length > 0 ? <View style={styles.card}>
								{findResult.files.map((p, i) => (
									<Pressable key={p} style={[styles.row, i === findResult.files.length - 1 && styles.rowLast]} onPress={() => { hapticSelection(); openViewer(p); }}>
										<Ionicons name="document-text-outline" size={16} color={colors.textDim} />
										<View style={styles.resultCol}>
											<Highlighted text={p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p} query={filter} smartCase={false} lines={1} style={styles.rowName} />
											{p.includes('/') ? <Highlighted text={p.slice(0, p.lastIndexOf('/'))} query={filter} smartCase={false} lines={1} style={styles.resultPath} /> : null}
										</View>
									</Pressable>
								))}
							</View> : null}
							{findResult.files.length === 0 && !searching ? <EmptyState icon="search-outline" title="一致するファイルがありません" message="ファイル名（全階層のパス）に検索語を含むものがありません" /> : null}
							{findResult.truncated ? <Text style={styles.dimNote}>結果が多いため一部のみ表示しています</Text> : null}
						</>
					) : grepResult !== undefined ? (
						<>
							{grepResult.matches.length > 0 ? <View style={styles.card}>
								{grepResult.matches.map((m, i) => (
									<Pressable key={`${m.path}:${m.line}:${i}`} style={[styles.row, i === grepResult.matches.length - 1 && styles.rowLast]} onPress={() => { hapticSelection(); openViewer(m.path, m.line); }}>
										<View style={styles.resultCol}>
											<Text style={styles.resultPath} numberOfLines={1}>{m.path}:{m.line}</Text>
											<Highlighted text={m.text} query={filter} smartCase lines={2} style={styles.resultPreview} />
										</View>
									</Pressable>
								))}
							</View> : null}
							{grepResult.matches.length === 0 && !searching ? <EmptyState icon="search-outline" title="一致する箇所がありません" message="ファイルの内容に検索語を含む行がありません" /> : null}
							{grepResult.truncated ? <Text style={styles.dimNote}>結果が多いため一部のみ表示しています</Text> : null}
						</>
					) : searching ? (
						<LoadingState label="検索中…" />
					) : (
						// 接続が切れて検索が走らなかった／途中で切れた。条件はそのまま残っているので、戻れば再検索できる。
						<EmptyState
							icon="cloud-offline-outline"
							title="検索できません"
							message={unavailable !== undefined ? `${unavailable}。接続が戻ったら再検索できます` : undefined}
							action={live ? { label: '再検索', onPress: retrySearch } : undefined}
						/>
					)
				) : (
					<>
						{error !== undefined && listing !== undefined ? <Text style={styles.error}>読み込みに失敗しました: {error}</Text> : null}
						{/* 接続が切れて一覧が押せないときは、薄くするだけでなく理由を書く。 */}
						{unavailable !== undefined && listing !== undefined ? <UnavailableNote reason={unavailable} /> : null}
						{listing === undefined ? (
							error !== undefined ? (
								<EmptyState icon="alert-circle-outline" title="フォルダを読み込めませんでした" message={error} action={live ? { label: '再読み込み', onPress: () => { hapticImpact('light'); void load(path); } } : undefined} />
							) : unavailable !== undefined ? (
								<EmptyState icon="cloud-offline-outline" title="ファイルを読み込めません" message={`${unavailable}。接続が戻ると読み込みます`} />
							) : <LoadingState />
						) : null}
						{/* 行はカードに収める（SCMと同じ作法）。「..」も同じカードの先頭行として扱う。
						    出す行が1つも無いとき（ルートで空・読み込み中）は枠だけの空箱を出さない。 */}
						{(path !== '' || entries.length > 0) ? <View style={styles.card}>
							{path !== '' ? (
								<Pressable disabled={!live} style={[styles.row, entries.length === 0 && styles.rowLast]} onPress={() => { hapticSelection(); void load(parent, true); }} accessibilityLabel="ひとつ上のフォルダへ">
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
										onPress={() => { hapticSelection(); entry.dir ? void load(childPath, true) : openViewer(childPath); }}
									>
										<Ionicons name={entry.dir ? 'folder-outline' : 'document-text-outline'} size={16} color={entry.dir ? colors.accent : colors.textDim} />
										<Text style={styles.rowName} numberOfLines={1}>{entry.name}</Text>
										{!entry.dir && entry.size !== undefined ? <Text style={styles.size}>{formatSize(entry.size)}</Text> : null}
									</Pressable>
								);
							})}
						</View> : null}
						{listing !== undefined && entries.length === 0 ? (
							<EmptyState icon="folder-open-outline" title="このフォルダは空です" message={path === '' ? 'このスペースのフォルダにはファイルがありません' : undefined} />
						) : null}
					</>
				)}
			</ScrollView>
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
	list: { flex: 1, paddingHorizontal: 16 },
	error: { color: colors.red, fontSize: type.meta, marginVertical: 8 },
	// 行を収める札。SCMのカードと同じ面（surface + 枠線 + 角丸14）。
	card: { backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.card, ...squircle, paddingHorizontal: 14, marginBottom: 8 },
	row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, minHeight: HIT_SIZE, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
	// カードの最終行。締めの下線はカードの縁が担うので消す。
	rowLast: { borderBottomWidth: 0 },
	rowName: { flex: 1, color: colors.text, fontSize: type.body },
	size: { color: colors.textDim, fontSize: type.caption },
	resultCol: { flex: 1, gap: 2 },
	resultPath: { color: colors.textDim, fontSize: type.caption },
	resultPreview: { color: colors.text, fontSize: type.meta, fontFamily: monoFamily },
	dimNote: { color: colors.textDim, fontSize: type.meta, paddingVertical: 12, textAlign: 'center' },
	// 一致箇所。色だけで示し、地は敷かない（モノスペースの行を壊さない）。
	hit: { color: colors.accent, fontWeight: '700' },
});
