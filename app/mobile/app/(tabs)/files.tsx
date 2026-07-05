// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { ConnectionGate } from '../../src/components/connectionGate.js';
import { FileViewer } from '../../src/components/fileViewer.js';
import { WsBar, useEffectiveWs } from '../../src/components/wsBar.js';
import { colors } from '../../src/theme.js';
import type { FsListResult, FsReadResult } from '../../src/store.js';

/**
 * ファイル画面（モックアップ準拠）。ワークスペースのファイルツリーを閲覧し、
 * ファイル名フィルタとタップでのフルスクリーンビューア表示に対応（読み取り専用）。
 * ビューアはPC版と同じテーマのシンタックスハイライトで表示し、.md/.htmlは
 * レンダー/Raw を切り替えられる。
 */
export default function FilesScreen() {
	const ws = useEffectiveWs();
	const { fsList, fsRead, fsXlsx, connection } = useAppStore(useShallow(s => ({ fsList: s.fsList, fsRead: s.fsRead, fsXlsx: s.fsXlsx, connection: s.connection })));

	const [path, setPath] = useState('');
	const [listing, setListing] = useState<FsListResult | undefined>();
	const [filter, setFilter] = useState('');
	const [error, setError] = useState<string | undefined>();
	const [loading, setLoading] = useState(false);
	const [viewerPath, setViewerPath] = useState<string | undefined>();
	const [viewerResult, setViewerResult] = useState<FsReadResult | undefined>();
	const [viewerXlsxHtml, setViewerXlsxHtml] = useState<string | undefined>();
	// 開く→閉じる→別ファイルを開く、の間に前のfetchが解決して上書きするのを防ぐ世代ガード
	const viewerPathRef = useRef<string | undefined>(undefined);

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
		void load('');
	}, [load]);

	const openViewer = async (p: string) => {
		viewerPathRef.current = p;
		setViewerPath(p);
		setViewerResult(undefined);
		setViewerXlsxHtml(undefined);
		if (!wsId) {
			return;
		}
		try {
			if (/\.(?:xlsx|xlsm)$/i.test(p)) {
				// Excel は PC 側でレンダリングされた静的HTMLを受け取る（PC版ビューアと同じ見た目）
				const html = (await fsXlsx(wsId, p)).html;
				if (viewerPathRef.current === p) {
					setViewerXlsxHtml(html);
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

	const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
	const entries = (listing?.entries ?? []).filter(e => !filter || e.name.toLowerCase().includes(filter.toLowerCase()));
	const crumbs = [ws?.name ?? '', ...path.split('/').filter(Boolean)];

	return (
		<ConnectionGate>
		<View style={styles.screen}>
			<WsBar />
			<View style={styles.searchBox}>
				<Ionicons name="search-outline" size={14} color={colors.textDim} />
				<TextInput
					style={styles.searchInput}
					value={filter}
					onChangeText={setFilter}
					placeholder="ファイル名で検索…"
					placeholderTextColor={colors.textDim}
					autoCapitalize="none"
					autoCorrect={false}
				/>
			</View>
			<Text style={styles.breadcrumb} numberOfLines={1}>{crumbs.join(' › ')}</Text>
			<ScrollView
				style={styles.list}
				refreshControl={<RefreshControl refreshing={loading} onRefresh={() => { void load(path); }} tintColor={colors.textDim} />}
			>
				{error ? <Text style={styles.error}>{error}</Text> : null}
				{loading && !listing ? <ActivityIndicator style={styles.spinner} /> : null}
				{path !== '' ? (
					<Pressable style={styles.row} onPress={() => { void load(parent); }}>
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
							onPress={() => { entry.dir ? void load(childPath) : void openViewer(childPath); }}
						>
							<Ionicons name={entry.dir ? 'folder-outline' : 'document-text-outline'} size={16} color={entry.dir ? colors.accent : colors.textDim} />
							<Text style={styles.rowName} numberOfLines={1}>{entry.name}</Text>
							{!entry.dir && entry.size !== undefined ? <Text style={styles.size}>{formatSize(entry.size)}</Text> : null}
						</Pressable>
					);
				})}
			</ScrollView>
			{viewerPath !== undefined ? (
				<FileViewer path={viewerPath} result={viewerResult} spreadsheetHtml={viewerXlsxHtml} onClose={() => { viewerPathRef.current = undefined; setViewerPath(undefined); setViewerResult(undefined); setViewerXlsxHtml(undefined); }} />
			) : null}
		</View>
		</ConnectionGate>
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
});
