// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { CircleAlert, CloudOff, FolderOpen, Search, SearchX, X } from 'lucide-react-native';
import type { FilesSearchMode } from '../../filesSearch.js';
import { useStableInsets } from '../../hooks/useStableInsets.js';
import { colors, space, type } from '../../theme.js';
import { EmptyState, HeaderButton, Screen, ScreenHeader } from '../../ui/index.js';
import { codeCacheKey, useCodeCache } from './codeCache.js';
import { CenterSpinner, OfflineBanner, SpaceGateBody, useReadableColumn } from './codeParts.js';
import { fileViewerHref } from './codeRoutes.js';
import { FilesSearchBar, FindResultRow, GrepResultRow, TreeRowView } from './filesParts.js';
import type { TreeRow } from './fileTree.js';
import type { CodeSpace } from './useCodeSpace.js';
import { useFileSearch, type FileSearchState } from './useFileSearch.js';
import { useFileTree } from './useFileTree.js';

/**
 * ファイルのツリー（Orca の MobileFileExplorerPanel）。見出しの右の虫めがねで検索欄を出し、
 * 名前（全階層のパス）か内容（全文）で探す。ファイルを押すとビューアへ進む。
 */
export function FileTreePanel({ codeSpace, reveal }: { codeSpace: CodeSpace; reveal: string | undefined }) {
	const router = useRouter();
	const tree = useFileTree(codeSpace, reveal);
	const [searchOpen, setSearchOpen] = useState(false);
	const [query, setQuery] = useState('');
	const [mode, setMode] = useState<FilesSearchMode>('name');
	const search = useFileSearch(codeSpace, searchOpen ? query : '', mode);
	const insets = useStableInsets();
	const column = useReadableColumn();
	const listRef = useRef<FlatList<TreeRow>>(null);
	const key = codeCacheKey(codeSpace.pcId, codeSpace.spaceId);
	const subtitle = [codeSpace.name, codeSpace.branch].filter(part => part !== undefined && part.length > 0).join(' · ');
	const { reveal: revealInTree } = tree;

	// ビューアのパンくずから戻ってきたら、そのフォルダまで開いて目印を付ける。
	useFocusEffect(useCallback(() => {
		const pending = useCodeCache.getState().takeReveal(key);
		if (pending !== undefined) {
			setSearchOpen(false);
			setQuery('');
			revealInTree(pending);
		}
	}, [key, revealInTree]));

	// 目印を付けたフォルダが画面の外なら、見える位置まで送る。
	const highlightIndex = tree.highlighted !== undefined ? tree.rows.findIndex(row => row.path === tree.highlighted && row.kind === 'dir') : -1;
	const scrolledTo = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (highlightIndex < 0 || tree.highlighted === undefined || scrolledTo.current === tree.highlighted) {
			return;
		}
		scrolledTo.current = tree.highlighted;
		listRef.current?.scrollToIndex({ index: highlightIndex, viewPosition: 0.3, animated: true });
	}, [highlightIndex, tree.highlighted]);

	const openFile = (path: string, line?: number) => {
		if (codeSpace.pcId !== undefined && codeSpace.spaceId !== undefined) {
			router.push(fileViewerHref(codeSpace.pcId, codeSpace.spaceId, path, line));
		}
	};

	const toggleSearch = () => {
		setSearchOpen(open => !open);
		setQuery('');
	};

	const searching = searchOpen && query.trim().length > 0;
	return (
		<Screen>
			<ScreenHeader
				title="ファイル"
				subtitle={subtitle.length > 0 ? subtitle : undefined}
				surface="panel"
				right={<HeaderButton icon={searchOpen ? X : Search} label={searchOpen ? '検索を閉じる' : 'ファイルを検索'} onPress={toggleSearch} active={searchOpen} />}
			>
				{searchOpen ? <FilesSearchBar mode={mode} onChangeMode={setMode} onChangeQuery={setQuery} editable={codeSpace.live} /> : null}
			</ScreenHeader>
			<SpaceGateBody gate={codeSpace.gate}>
				<View style={styles.body}>
					<OfflineBanner reason={codeSpace.unavailable} />
					{searching ? (
						<SearchResults search={search} query={query} mode={mode} unavailable={codeSpace.unavailable} bottomInset={insets.bottom} onOpen={openFile} />
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
							keyboardShouldPersistTaps="handled"
							refreshControl={<RefreshControl refreshing={tree.refreshing} onRefresh={tree.refresh} tintColor={colors.textDim} />}
							onScrollToIndexFailed={info => {
								listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true });
							}}
							renderItem={({ item }) => (
								<TreeRowView
									row={item}
									expanded={tree.expanded.has(item.path)}
									highlighted={item.path === tree.highlighted}
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
function SearchResults({ search, query, mode, unavailable, bottomInset, onOpen }: {
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
				renderItem={({ item }) => <FindResultRow path={item} query={query} onOpen={path => onOpen(path)} />}
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
