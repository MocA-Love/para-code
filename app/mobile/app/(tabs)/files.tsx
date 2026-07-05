// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { WsBar, useEffectiveWs } from '../../src/components/wsBar.js';
import { colors } from '../../src/theme.js';
import type { FsListResult } from '../../src/store.js';

/**
 * ファイル画面（モックアップ準拠）。ワークスペースのファイルツリーを閲覧し、
 * ファイル名フィルタとタップでの下部プレビュー表示に対応（読み取り専用）。
 */
export default function FilesScreen() {
	const ws = useEffectiveWs();
	const { fsList, fsRead, connection } = useAppStore(useShallow(s => ({ fsList: s.fsList, fsRead: s.fsRead, connection: s.connection })));

	const [path, setPath] = useState('');
	const [listing, setListing] = useState<FsListResult | undefined>();
	const [filter, setFilter] = useState('');
	const [error, setError] = useState<string | undefined>();
	const [loading, setLoading] = useState(false);
	const [previewPath, setPreviewPath] = useState<string | undefined>();
	const [previewContent, setPreviewContent] = useState<string | undefined>();
	const [truncated, setTruncated] = useState(false);

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
		setPreviewPath(undefined);
		setPreviewContent(undefined);
		void load('');
	}, [load]);

	const openPreview = async (p: string) => {
		setPreviewPath(p);
		setPreviewContent(undefined);
		setTruncated(false);
		if (!wsId) {
			return;
		}
		try {
			const result = await fsRead(wsId, p);
			setPreviewContent(result.content);
			setTruncated(result.truncated);
		} catch (e) {
			setPreviewContent(`エラー: ${String(e instanceof Error ? e.message : e)}`);
		}
	};

	const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
	const entries = (listing?.entries ?? []).filter(e => !filter || e.name.toLowerCase().includes(filter.toLowerCase()));
	const crumbs = [ws?.name ?? '', ...path.split('/').filter(Boolean)];

	return (
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
							onPress={() => { entry.dir ? void load(childPath) : void openPreview(childPath); }}
						>
							<Ionicons name={entry.dir ? 'folder-outline' : 'document-text-outline'} size={16} color={entry.dir ? colors.accent : colors.textDim} />
							<Text style={[styles.rowName, previewPath === childPath && styles.rowNameActive]} numberOfLines={1}>{entry.name}</Text>
							{!entry.dir && entry.size !== undefined ? <Text style={styles.size}>{formatSize(entry.size)}</Text> : null}
						</Pressable>
					);
				})}
			</ScrollView>
			{previewPath !== undefined ? (
				<View style={styles.preview}>
					<View style={styles.previewHeader}>
						<Text style={styles.previewTitle} numberOfLines={1}>プレビュー — {previewPath.split('/').pop()?.toUpperCase()}</Text>
						<Pressable onPress={() => setPreviewPath(undefined)}><Ionicons name="close" size={16} color={colors.textDim} /></Pressable>
					</View>
					{truncated ? <Text style={styles.truncated}>サイズ上限のため先頭のみ表示しています</Text> : null}
					<ScrollView style={styles.previewScroll}>
						<ScrollView horizontal showsHorizontalScrollIndicator={false}>
							<Text style={styles.previewText}>{previewContent ?? '読み込み中…'}</Text>
						</ScrollView>
					</ScrollView>
				</View>
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
	rowNameActive: { color: colors.accent },
	size: { color: colors.textDim, fontSize: 11 },
	preview: { maxHeight: 300, backgroundColor: colors.surface, borderTopLeftRadius: 14, borderTopRightRadius: 14, borderWidth: 1, borderColor: colors.border, marginHorizontal: 8 },
	previewHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6 },
	previewTitle: { flex: 1, color: colors.textDim, fontSize: 11, fontWeight: '600', letterSpacing: 0.5 },
	previewClose: { color: colors.textDim, fontSize: 14, paddingHorizontal: 4 },
	truncated: { color: colors.yellow, fontSize: 10, paddingHorizontal: 14, paddingBottom: 4 },
	previewScroll: { paddingHorizontal: 14, paddingBottom: 14 },
	previewText: { color: colors.text, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11, lineHeight: 16 },
});
