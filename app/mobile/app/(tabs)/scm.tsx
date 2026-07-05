// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Linking, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { ConnectionGate } from '../../src/components/connectionGate.js';
import { DiffView } from '../../src/components/diffView.js';
import { WsBar, useEffectiveWs } from '../../src/components/wsBar.js';
import { colors } from '../../src/theme.js';
import type { ScmLogResult, ScmStatusResult } from '../../src/store.js';

/**
 * ソース管理画面（モックアップ準拠）。リポジトリ/ブランチ表示、コミット入力、
 * 変更一覧（タップでフルスクリーンのDiffビューア）、最近のコミット
 * （タップで外部ブラウザのコミットページを開く）。
 */
export default function ScmScreen() {
	const ws = useEffectiveWs();
	const { scmStatus, scmCommit, scmLog, connection } = useAppStore(useShallow(s => ({
		scmStatus: s.scmStatus, scmCommit: s.scmCommit, scmLog: s.scmLog, connection: s.connection,
	})));

	const [status, setStatus] = useState<ScmStatusResult | undefined>();
	const [log, setLog] = useState<ScmLogResult | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [loading, setLoading] = useState(false);
	const [diffTarget, setDiffTarget] = useState<{ path: string; staged: boolean } | undefined>();
	const [message, setMessage] = useState('');
	const [committing, setCommitting] = useState(false);
	const [commitResult, setCommitResult] = useState<string | undefined>();

	const wsId = ws?.id;

	const refresh = useCallback(async () => {
		if (!wsId || connection !== 'online') {
			return;
		}
		setError(undefined);
		setLoading(true);
		try {
			const [st, lg] = await Promise.all([scmStatus(wsId), scmLog(wsId).catch(() => undefined)]);
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
		void refresh();
	}, [refresh]);

	const openCommit = (hash: string) => {
		if (log?.webUrl) {
			void Linking.openURL(`${log.webUrl}/commit/${hash}`);
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
			<WsBar />
			<ScrollView
				style={styles.list}
				refreshControl={<RefreshControl refreshing={loading} onRefresh={() => { void refresh(); }} tintColor={colors.textDim} />}
			>
				<View style={styles.repoCard}>
					<Ionicons name="cube-outline" size={15} color={colors.textDim} />
					<Text style={styles.repoName}>{ws?.name ?? '—'}</Text>
					<Ionicons name="git-branch-outline" size={13} color={colors.accent} />
					<Text style={styles.repoBranch}>{status?.branch ?? ws?.branch ?? '…'}</Text>
				</View>

				<TextInput
					style={styles.commitInput}
					value={message}
					onChangeText={setMessage}
					placeholder="コミットメッセージ"
					placeholderTextColor={colors.textDim}
					autoCapitalize="none"
					editable={!committing}
					multiline
				/>
				<Pressable
					style={[styles.commitBtn, (!wsId || !message.trim() || committing) && styles.commitBtnDisabled]}
					onPress={() => { void commit(); }}
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
						<Pressable key={`${f.x}${f.y}${f.path}`} style={styles.fileRow} onPress={() => setDiffTarget({ path: f.path, staged: staged && f.y === ' ' })}>
							<Ionicons name="document-text-outline" size={14} color={colors.textDim} />
							<Text style={styles.filePath} numberOfLines={1}>{f.path}</Text>
							<Text style={[styles.fileLetter, letter === 'M' ? styles.mod : letter === 'A' || letter === '?' ? styles.add : letter === 'D' ? styles.del : undefined]}>{letter === '?' ? 'A' : letter}</Text>
						</Pressable>
					);
				})}

				{log && log.commits.length > 0 ? (
					<>
						<Text style={[styles.sectionTitle, { marginTop: 18 }]}>最近のコミット</Text>
						{log.commits.map(c => (
							<Pressable key={c.hash} style={styles.commitRow} onPress={() => openCommit(c.hash)} disabled={!log.webUrl}>
								<Ionicons name="ellipse-outline" size={10} color={colors.textDim} />
								<Text style={styles.commitSubject} numberOfLines={1}>{c.subject}</Text>
								<Text style={styles.commitWhen}>{c.when}</Text>
								{log.webUrl ? <Ionicons name="open-outline" size={13} color={colors.textDim} /> : null}
							</Pressable>
						))}
					</>
				) : null}
				<View style={{ height: 24 }} />
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
	repoCard: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 12, marginBottom: 10 },
	repoName: { color: colors.text, fontSize: 14, fontWeight: '600', flex: 1 },
	repoBranch: { color: colors.accent, fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
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
	fileRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#21262d' },
	filePath: { flex: 1, color: colors.text, fontSize: 13 },
	fileLetter: { width: 18, textAlign: 'center', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12, fontWeight: '700', color: colors.textDim },
	mod: { color: colors.mod },
	add: { color: colors.add },
	del: { color: colors.del },
	commitRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
	commitSubject: { flex: 1, color: colors.text, fontSize: 13 },
	commitWhen: { color: colors.textDim, fontSize: 11 },
});
