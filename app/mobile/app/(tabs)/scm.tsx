// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Linking, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { ConnectionGate } from '../../src/components/connectionGate.js';
import { DiffView } from '../../src/components/diffView.js';
import { WsHeader, useEffectiveWs } from '../../src/components/wsDrawer.js';
import { useTabBarSpacer } from '../../src/hooks/useTabBarSpacer.js';
import { colors } from '../../src/theme.js';
import { formatRelativeTime, useNow } from '../../src/time.js';
import { hapticImpact, hapticSelection } from '../../src/haptics.js';
import type { ScmLogResult, ScmStatusResult } from '../../src/store.js';

/**
 * ソース管理画面（モックアップ準拠）。リポジトリ/ブランチ表示、コミット入力、
 * 変更一覧（タップでフルスクリーンのDiffビューア）、最近のコミット
 * （タップで外部ブラウザのコミットページを開く）。
 */
export default function ScmScreen() {
	const ws = useEffectiveWs();
	const { scmStatus, scmCommit, scmLog, scmCommitFiles, connection } = useAppStore(useShallow(s => ({
		scmStatus: s.scmStatus, scmCommit: s.scmCommit, scmLog: s.scmLog, scmCommitFiles: s.scmCommitFiles, connection: s.connection,
	})));

	const tabBarSpacer = useTabBarSpacer();
	// 相対時刻表示（最近のコミットの「〇分前」）を画面を開いたままでも追従させる
	const now = useNow();
	const [status, setStatus] = useState<ScmStatusResult | undefined>();
	const [log, setLog] = useState<ScmLogResult | undefined>();
	const [logError, setLogError] = useState<string | undefined>();
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [loading, setLoading] = useState(false);
	const [diffTarget, setDiffTarget] = useState<{ path: string; staged: boolean } | undefined>();
	const [message, setMessage] = useState('');
	// コミット行タップで展開する「そのコミットの変更ファイル一覧」。hash単位でキャッシュする
	const [expandedHash, setExpandedHash] = useState<string | undefined>();
	const [commitFiles, setCommitFiles] = useState<Record<string, { files?: { status: string; path: string }[]; error?: string }>>({});
	const [committing, setCommitting] = useState(false);
	const [commitResult, setCommitResult] = useState<string | undefined>();

	const wsId = ws?.id;

	const refresh = useCallback(async () => {
		if (!wsId || connection !== 'online') {
			return;
		}
		setError(undefined);
		setLogError(undefined);
		setLoading(true);
		try {
			// 履歴取得の失敗はstatus表示を巻き添えにせず、履歴セクション側にエラーを出す
			const [st, lg] = await Promise.all([
				scmStatus(wsId),
				scmLog(wsId, { limit: 10 }).catch((e: unknown) => {
					setLogError(String(e instanceof Error ? e.message : e));
					return undefined;
				}),
			]);
			setStatus(st);
			setLog(lg);
		} catch (e) {
			setError(String(e instanceof Error ? e.message : e));
		} finally {
			setLoading(false);
		}
	}, [scmStatus, scmLog, wsId, connection]);

	useEffect(() => {
		setStatus(undefined);
		setLog(undefined);
		setDiffTarget(undefined);
		setExpandedHash(undefined);
		setCommitFiles({});
		void refresh();
	}, [refresh]);

	const loadMore = async () => {
		if (!wsId || !log || loadingMore) {
			return;
		}
		setLoadingMore(true);
		try {
			const more = await scmLog(wsId, { limit: 10, skip: log.commits.length });
			// ページ読み込みの合間に新規コミットが積まれるとウィンドウがずれて同じhashが再来しうるため去重する
			const seen = new Set(log.commits.map(c => c.hash));
			setLog({ ...log, commits: [...log.commits, ...more.commits.filter(c => !seen.has(c.hash))], hasMore: more.hasMore });
		} catch (e) {
			setLogError(String(e instanceof Error ? e.message : e));
		} finally {
			setLoadingMore(false);
		}
	};

	const openCommit = (hash: string) => {
		if (log?.webUrl) {
			void Linking.openURL(`${log.webUrl}/commit/${hash}`);
		}
	};

	/**
	 * 変更ファイルを外部ブラウザ（GitHub形式のURL）で開く。openCommitと同様の制約を継承する。
	 * branchはパス区切り(/)を含みうる（例: feature/foo）ためencodeせず、pathはセグメントごとに
	 * encodeする（空白・日本語・#等を含むパスがURLとして壊れるのを防ぐ）。
	 */
	const openFileExternally = (path: string) => {
		if (log?.webUrl) {
			const branch = status?.branch ?? 'HEAD';
			const encodedPath = path.split('/').map(encodeURIComponent).join('/');
			void Linking.openURL(`${log.webUrl}/blob/${branch}/${encodedPath}`);
		}
	};

	/** コミット行のタップ: 変更ファイル一覧を展開/折りたたみ（初回のみ取得）。 */
	const toggleCommit = (hash: string) => {
		if (expandedHash === hash) {
			setExpandedHash(undefined);
			return;
		}
		setExpandedHash(hash);
		if (!commitFiles[hash] && wsId) {
			scmCommitFiles(wsId, hash)
				.then(r => setCommitFiles(prev => ({ ...prev, [hash]: { files: r.files } })))
				.catch((e: unknown) => setCommitFiles(prev => ({ ...prev, [hash]: { error: String(e instanceof Error ? e.message : e) } })));
		}
	};

	const commit = async () => {
		if (!wsId || !message.trim() || committing) {
			return;
		}
		setCommitting(true);
		setCommitResult(undefined);
		setError(undefined);
		try {
			const result = await scmCommit(wsId, message.trim(), true);
			setCommitResult(result.output);
			setMessage('');
			await refresh();
		} catch (e) {
			setError(String(e instanceof Error ? e.message : e));
		} finally {
			setCommitting(false);
		}
	};

	return (
		<ConnectionGate>
		<KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
			<WsHeader title="ソース管理" />
			<ScrollView
				style={styles.list}
				refreshControl={<RefreshControl refreshing={loading} onRefresh={() => { void refresh(); }} tintColor={colors.textDim} />}
			>
				{/* リポジトリ名とブランチ名は長いと1行内で潰し合うため2行に分ける */}
				<View style={styles.repoCard}>
					<View style={styles.repoRow}>
						<Ionicons name="cube-outline" size={15} color={colors.textDim} />
						<Text style={styles.repoName} numberOfLines={1}>{ws?.name ?? '—'}</Text>
					</View>
					<View style={styles.repoRow}>
						<Ionicons name="git-branch-outline" size={13} color={colors.accent} />
						<Text style={styles.repoBranch} numberOfLines={1}>{status?.branch ?? ws?.branch ?? '…'}</Text>
					</View>
				</View>

				<TextInput
					style={styles.commitInput}
					value={message}
					onChangeText={setMessage}
					placeholder="コミットメッセージ"
					placeholderTextColor={colors.textDim}
					autoCapitalize="none"
					onFocus={() => hapticSelection()}
					editable={!committing}
					multiline
				/>
				<Pressable
					style={[styles.commitBtn, (!wsId || !message.trim() || committing) && styles.commitBtnDisabled]}
					onPress={() => { hapticImpact('medium'); void commit(); }}
					disabled={!wsId || !message.trim() || committing}
				>
					<Text style={styles.commitBtnText}>{committing ? 'コミット中…' : 'コミット'}</Text>
				</Pressable>
				{commitResult ? <Text style={styles.commitResult}>{commitResult}</Text> : null}
				{error ? <Text style={styles.error}>{error}</Text> : null}

				<View style={styles.sectionRow}>
					<Text style={styles.sectionTitle}>変更</Text>
					<Text style={styles.sectionCount}>{status?.files.length ?? 0}</Text>
				</View>
				{loading && !status ? <ActivityIndicator style={styles.spinner} /> : null}
				{status && status.files.length === 0 ? <Text style={styles.dim}>変更はありません</Text> : null}
				{(status?.files ?? []).map(f => {
					const staged = f.x !== ' ' && f.x !== '?';
					const letter = (f.x !== ' ' && f.x !== '?' ? f.x : f.y) || '?';
					return (
						<View key={`${f.x}${f.y}${f.path}`} style={styles.fileRowWrap}>
							<Pressable style={styles.fileRow} onPress={() => { hapticSelection(); setDiffTarget({ path: f.path, staged: staged && f.y === ' ' }); }}>
								<Ionicons name="document-text-outline" size={14} color={colors.textDim} />
								<Text style={styles.filePath} numberOfLines={1}>{f.path}</Text>
								<Text style={[styles.fileLetter, letter === 'M' ? styles.mod : letter === 'A' || letter === '?' ? styles.add : letter === 'D' ? styles.del : undefined]}>{letter === '?' ? 'A' : letter}</Text>
							</Pressable>
							{log?.webUrl ? (
								<Pressable style={styles.fileExtBtn} onPress={() => { hapticImpact('light'); openFileExternally(f.path); }} hitSlop={8} accessibilityLabel="外部で開く">
									<Ionicons name="open-outline" size={13} color={colors.textDim} />
								</Pressable>
							) : null}
						</View>
					);
				})}

				{log !== undefined || logError !== undefined ? (
					<Text style={[styles.sectionTitle, { marginTop: 18 }]}>最近のコミット</Text>
				) : null}
				{logError ? <Text style={styles.error}>{logError}</Text> : null}
				{log && log.commits.length === 0 ? <Text style={styles.dim}>コミットはありません</Text> : null}
				{(log?.commits ?? []).map(c => {
					const expanded = expandedHash === c.hash;
					const detail = commitFiles[c.hash];
					return (
						<View key={c.hash}>
							<Pressable style={styles.commitRow} onPress={() => { hapticSelection(); toggleCommit(c.hash); }}>
								<Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={11} color={colors.textDim} />
								<Text style={styles.commitSubject} numberOfLines={1}>{c.subject}</Text>
								{/* atが無いのは旧バージョンのPC（whenはPC側整形の英語文字列） */}
								<Text style={styles.commitWhen}>{c.at !== undefined ? formatRelativeTime(c.at, now) : c.when}</Text>
								{log?.webUrl ? (
									<Pressable onPress={() => { hapticImpact('light'); openCommit(c.hash); }} hitSlop={8} accessibilityLabel="ブラウザでコミットを開く">
										<Ionicons name="open-outline" size={13} color={colors.textDim} />
									</Pressable>
								) : null}
							</Pressable>
							{expanded ? (
								<View style={styles.commitDetail}>
									{!detail ? <ActivityIndicator size="small" color={colors.textDim} /> : null}
									{detail?.error ? <Text style={styles.error}>{detail.error}</Text> : null}
									{detail?.files && detail.files.length === 0 ? <Text style={styles.dim}>変更ファイルはありません</Text> : null}
									{(detail?.files ?? []).map(f => (
										<View key={`${f.status}${f.path}`} style={styles.commitFileRow}>
											<Text style={[styles.fileLetter, f.status === 'M' ? styles.mod : f.status === 'A' ? styles.add : f.status === 'D' ? styles.del : undefined]}>{f.status}</Text>
											<Text style={styles.commitFilePath} numberOfLines={1}>{f.path}</Text>
										</View>
									))}
								</View>
							) : null}
						</View>
					);
				})}
				{log?.hasMore ? (
					<Pressable style={styles.loadMoreBtn} onPress={() => { hapticImpact('light'); void loadMore(); }} disabled={loadingMore}>
						<Text style={styles.loadMoreText}>{loadingMore ? '読み込み中…' : 'さらに読み込む'}</Text>
					</Pressable>
				) : null}
				<View style={{ height: tabBarSpacer }} />
			</ScrollView>
			{diffTarget !== undefined && wsId ? (
				<DiffView ws={wsId} path={diffTarget.path} staged={diffTarget.staged} onClose={() => setDiffTarget(undefined)} />
			) : null}
		</KeyboardAvoidingView>
		</ConnectionGate>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	list: { flex: 1, paddingHorizontal: 16 },
	repoCard: { gap: 6, backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 12, marginBottom: 10 },
	repoRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	repoName: { color: colors.text, fontSize: 14, fontWeight: '600', flexShrink: 1 },
	repoBranch: { color: colors.accent, fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', flexShrink: 1 },
	commitInput: { backgroundColor: colors.panel, borderRadius: 10, borderWidth: 1, borderColor: colors.border, color: colors.text, fontSize: 13, paddingHorizontal: 12, paddingVertical: 10, minHeight: 56, textAlignVertical: 'top', marginBottom: 8 },
	commitBtn: { backgroundColor: colors.accent2, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
	commitBtnDisabled: { opacity: 0.45 },
	commitBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
	commitResult: { color: colors.green, fontSize: 11, marginTop: 8, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	error: { color: colors.red, fontSize: 12, marginTop: 8 },
	sectionRow: { flexDirection: 'row', alignItems: 'center', marginTop: 18, marginBottom: 6 },
	sectionTitle: { color: colors.textDim, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, flex: 1 },
	sectionCount: { color: colors.textDim, fontSize: 12 },
	spinner: { marginTop: 16 },
	dim: { color: colors.textDim, fontSize: 12, marginTop: 8 },
	fileRowWrap: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#21262d' },
	fileRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10 },
	fileExtBtn: { paddingHorizontal: 10, paddingVertical: 10 },
	filePath: { flex: 1, color: colors.text, fontSize: 13 },
	fileLetter: { width: 18, textAlign: 'center', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12, fontWeight: '700', color: colors.textDim },
	mod: { color: colors.mod },
	add: { color: colors.add },
	del: { color: colors.del },
	commitRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
	commitDetail: { paddingLeft: 20, paddingBottom: 6, gap: 3 },
	commitFileRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
	commitFilePath: { flex: 1, color: colors.textDim, fontSize: 12 },
	loadMoreBtn: { alignItems: 'center', paddingVertical: 10, marginTop: 4, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
	loadMoreText: { color: colors.textDim, fontSize: 12, fontWeight: '600' },
	commitSubject: { flex: 1, color: colors.text, fontSize: 13 },
	commitWhen: { color: colors.textDim, fontSize: 11 },
});
