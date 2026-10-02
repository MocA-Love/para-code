// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { CircleAlert, CloudOff, FolderOpen, Search, SearchX, X } from 'lucide-react-native';
import { haptic } from '../../haptics.js';
import type { FilesSearchMode } from '../../filesSearch.js';
import { useStableInsets } from '../../hooks/useStableInsets.js';
import { colors, space, type } from '../../theme.js';
import { EmptyState, HeaderButton, Screen, ScreenHeader } from '../../ui/index.js';
import { useCodeCache } from './codeCache.js';
import { CenterSpinner, OfflineBanner, SpaceGateBody, useReadableColumn } from './codeParts.js';
import { fileViewerHref } from './codeRoutes.js';
import { FilesSearchBar, FindResultRow, GrepResultRow, TreeRowView } from './filesParts.js';
import { buildFileDecorationIndex, fileDecorationOf } from './fileDecorations.js';
import type { TreeRow } from './fileTree.js';
import { saveTreeScroll, treeScroll } from './fileTreeStore.js';
import type { PanelDock } from './panelDock.js';
import type { CodeSpace } from './useCodeSpace.js';
import { useFileSearch, type FileSearchState } from './useFileSearch.js';
import { useFileTree } from './useFileTree.js';
import { useScmStatus } from './useScmData.js';

/**
 * ファイルのツリー（Orca の MobileFileExplorerPanel）。見出しの右の虫めがねで検索欄を出し、
 * 名前（全階層のパス）か内容（全文）で探す。ファイルを押すとビューアへ進む。
 *
 * iPad のセッションの右のドック（`dock`）でも使う。そのときは見出しの左が閉じる（X）になり、ファイルを
 * 押すとドックを閉じて詳細の列でビューアへ進む。開いていたフォルダ・位置・検索・最後に開いたファイルは
 * `fileTreeStore.ts` に退避してあるので、戻ってドックを開き直すとそのまま戻る。
 *
 * 名前は PC のエクスプローラーと同じ Git の色にする（`fileDecorations.ts`。状態は scm の `status` を流用し、
 * 前面に来たとき・引っぱって読み直したとき・つながり直したときに読み直す）。
 */
export function FileTreePanel({ codeSpace, reveal, dock }: { codeSpace: CodeSpace; reveal: string | undefined; dock?: PanelDock }) {
	const router = useRouter();
	const tree = useFileTree(codeSpace, reveal);
	const { open: searchOpen, query, mode } = tree.search;
	const { setSearch } = tree;
	const search = useFileSearch(codeSpace, searchOpen ? query : '', mode);
	const insets = useStableInsets();
	const column = useReadableColumn();
	const listRef = useRef<FlatList<TreeRow>>(null);
	const key = tree.key;
	const subtitle = [codeSpace.name, codeSpace.branch].filter(part => part !== undefined && part.length > 0).join(' · ');
	const { reveal: revealInTree } = tree;
	// 前回の位置から始める（ドックを開き直した・開き直したとき）。
	const [initialOffset] = useState(() => treeScroll(key));

	// Git の色。scm の status を流用する（前面に来たときに読む。ソース管理の画面と同じ写し）
	const scm = useScmStatus(codeSpace);
	const statusFiles = scm.status?.files;
	const pathsUnquoted = scm.status?.pathsUnquoted === true;
	const decorations = useMemo(() => buildFileDecorationIndex(statusFiles, pathsUnquoted), [statusFiles, pathsUnquoted]);
	const { refresh: refreshStatus } = scm;
	const { rendererTarget } = codeSpace;
	const sawTarget = useRef(rendererTarget);
	useEffect(() => {
		// つながり直したら読み直す（最初の 1 回は前面に来たときの読み込みに任せる）
		if (rendererTarget !== undefined && sawTarget.current !== rendererTarget && sawTarget.current !== undefined) {
			void refreshStatus();
		}
		sawTarget.current = rendererTarget ?? sawTarget.current;
	}, [rendererTarget, refreshStatus]);

	// ビューアのパンくずから戻ってきたら、そのフォルダまで開いて目印を付ける。
	useFocusEffect(useCallback(() => {
		const pending = useCodeCache.getState().takeReveal(key);
		if (pending !== undefined) {
			setSearch({ open: false, query: '' });
			revealInTree(pending);
		}
	}, [key, revealInTree, setSearch]));

	// 目印を付けたフォルダが画面の外なら、見える位置まで送る。前回の位置を戻したとき（ドックを開き直したなど）だけは、
	// 残っている目印へは送らない（初めて開いた・パンくずから開いたときは目印へ送る）。
	const highlightIndex = tree.highlighted !== undefined ? tree.rows.findIndex(row => row.path === tree.highlighted && row.kind === 'dir') : -1;
	const scrolledTo = useRef<string | undefined>(initialOffset > 0 ? tree.highlighted : undefined);
	useEffect(() => {
		if (highlightIndex < 0 || tree.highlighted === undefined || scrolledTo.current === tree.highlighted) {
			return;
		}
		scrolledTo.current = tree.highlighted;
		listRef.current?.scrollToIndex({ index: highlightIndex, viewPosition: 0.3, animated: true });
	}, [highlightIndex, tree.highlighted]);

	const openFile = (path: string, line?: number) => {
		if (codeSpace.pcId === undefined || codeSpace.spaceId === undefined) {
			return;
		}
		const href = fileViewerHref(codeSpace.pcId, codeSpace.spaceId, path, line);
		tree.markOpened(path);
		if (dock !== undefined) {
			dock.navigate(href);
			return;
		}
		router.push(href);
	};

	const toggleSearch = () => {
		setSearch({ open: !searchOpen, query: '' });
	};

	const refresh = () => {
		tree.refresh();
		void refreshStatus();
	};

	const searching = searchOpen && query.trim().length > 0;
	return (
		<Screen>
			<ScreenHeader
				title="ファイル"
				subtitle={subtitle.length > 0 ? subtitle : undefined}
				surface="panel"
				{...(dock !== undefined ? { safeTop: false, backIcon: X, backLabel: 'ファイルを閉じる', onBack: dock.close } : {})}
				right={<HeaderButton icon={searchOpen ? X : Search} label={searchOpen ? '検索を閉じる' : 'ファイルを検索'} onPress={toggleSearch} active={searchOpen} />}
			>
				{searchOpen ? <FilesSearchBar mode={mode} initialQuery={query} onChangeMode={next => setSearch({ mode: next })} onChangeQuery={next => setSearch({ query: next })} editable={codeSpace.live} /> : null}
			</ScreenHeader>
			<SpaceGateBody gate={codeSpace.gate}>
				<View style={styles.body}>
					<OfflineBanner reason={codeSpace.unavailable} />
					{searching ? (
						<SearchResults pcId={codeSpace.pcId} search={search} query={query} mode={mode} unavailable={codeSpace.unavailable} bottomInset={insets.bottom} onOpen={openFile} />
					) : !tree.root.loaded ? (
						tree.root.error !== undefined ? (
							<EmptyState icon={CircleAlert} title="ファイルを読み込めませんでした" body={tree.root.error} action={codeSpace.live ? { label: '再読み込み', onPress: () => tree.retry('') } : undefined} />
						) : codeSpace.unavailable !== undefined ? (
							<EmptyState icon={CloudOff} title="ファイルを読み込めません" body={`${codeSpace.unavailable}。つながると読み込みます。`} />
						) : <CenterSpinner label="読み込み中…" />
					) : tree.root.empty ? (
						<EmptyState icon={FolderOpen} title="ファイルはありません" body="このスペースのフォルダは空です。" />
					) : (
						<FlatList
							ref={listRef}
							data={tree.rows}
							keyExtractor={row => row.id}
							contentContainerStyle={[styles.list, { paddingBottom: space.xl + insets.bottom }, column]}
							contentOffset={initialOffset > 0 ? { x: 0, y: initialOffset } : undefined}
							onScroll={event => saveTreeScroll(key, event.nativeEvent.contentOffset.y)}
							scrollEventThrottle={100}
							keyboardShouldPersistTaps="handled"
							refreshControl={<RefreshControl refreshing={tree.refreshing} onRefresh={() => { haptic('edge'); refresh(); }} tintColor={colors.textDim} />}
							onScrollToIndexFailed={info => {
								listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true });
							}}
							renderItem={({ item }) => (
								<TreeRowView
									pcId={codeSpace.pcId}
									row={item}
									expanded={tree.expanded.has(item.path)}
									highlighted={item.path === tree.highlighted || (item.kind === 'file' && item.path === tree.opened)}
									decoration={item.kind === 'dir' || item.kind === 'file' ? fileDecorationOf(decorations, { path: item.path, dir: item.kind === 'dir', ignored: item.ignored }) : undefined}
									disabled={codeSpace.pcId === undefined}
									onToggle={tree.toggle}
									onOpen={path => openFile(path)}
									onRetry={tree.retry}
								/>
							)}
						/>
					)}
				</View>
			</SpaceGateBody>
		</Screen>
	);
}

/** 検索の結果（検索中・切断・失敗・一致なし・結果）。 */
function SearchResults({ pcId, search, query, mode, unavailable, bottomInset, onOpen }: {
	pcId: string | undefined;
	search: FileSearchState;
	query: string;
	mode: FilesSearchMode;
	unavailable: string | undefined;
	bottomInset: number;
	onOpen: (path: string, line?: number) => void;
}) {
	const column = useReadableColumn();
	if (search.error !== undefined) {
		return <EmptyState icon={CircleAlert} title="検索に失敗しました" body={search.error} action={unavailable === undefined ? { label: '再検索', onPress: search.retry } : undefined} />;
	}
	const contentStyle = [styles.list, { paddingBottom: space.xl + bottomInset }, column];
	if (mode === 'name' && search.find !== undefined) {
		const found = search.find;
		if (found.files.length === 0) {
			return <EmptyState icon={SearchX} title="一致するファイルはありません" body={`「${query.trim()}」を名前やパスに含むファイルはありません。`} />;
		}
		return (
			<FlatList
				data={found.files}
				keyExtractor={path => path}
				contentContainerStyle={contentStyle}
				keyboardShouldPersistTaps="handled"
				keyboardDismissMode="on-drag"
				renderItem={({ item }) => <FindResultRow pcId={pcId} path={item} query={query} onOpen={path => onOpen(path)} />}
				ListFooterComponent={found.truncated ? <Text style={styles.note}>結果が多いため一部だけを出しています</Text> : null}
			/>
		);
	}
	if (mode === 'text' && search.grep !== undefined) {
		const found = search.grep;
		if (found.matches.length === 0) {
			return <EmptyState icon={SearchX} title="一致する箇所はありません" body={`「${query.trim()}」を含む行はありません。`} />;
		}
		return (
			<FlatList
				data={found.matches}
				keyExtractor={(match, index) => `${match.path}:${match.line}:${index}`}
				contentContainerStyle={contentStyle}
				keyboardShouldPersistTaps="handled"
				keyboardDismissMode="on-drag"
				renderItem={({ item }) => <GrepResultRow path={item.path} line={item.line} text={item.text} query={query} onOpen={onOpen} />}
				ListFooterComponent={found.truncated ? <Text style={styles.note}>結果が多いため一部だけを出しています</Text> : null}
			/>
		);
	}
	if (unavailable !== undefined && !search.searching) {
		return <EmptyState icon={CloudOff} title="検索できません" body={`${unavailable}。つながったら検索できます。`} />;
	}
	return <CenterSpinner label="検索中…" />;
}

const styles = StyleSheet.create({
	body: {
		flex: 1,
	},
	list: {
		paddingTop: space.sm,
	},
	note: {
		fontSize: type.meta,
		color: colors.textMuted,
		textAlign: 'center',
		paddingVertical: space.md,
	},
});
