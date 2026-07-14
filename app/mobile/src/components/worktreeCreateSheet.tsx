// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import type { WorktreeFormResult } from '../store.js';
import { BottomSheet } from './bottomSheet.js';
import { colors } from '../theme.js';
import { hapticImpact, hapticSelection } from '../haptics.js';

/**
 * 「新しいスペース（worktree）を作成」シート（space.html 案A/共通シート準拠）。
 * PC版の作成ダイアログと同じフィールド（スペース名/ブランチ名/指示/エージェント/
 * リポジトリ/ベースブランチ）を縦積みにしたもの。作成処理はPC側で走り、
 * ブランチ自動命名（手入力 > LLM > フォールバック）・スペース切り替え・
 * setupスクリプト・エージェント起動までPC版と同じ挙動になる。
 */
export function WorktreeCreateSheet({ visible, onClose }: {
	visible: boolean;
	onClose: () => void;
}) {
	const { workspace, worktreeForm, createWorktree, connection, pcOnline, sessionProtocolReady } = useAppStore(useShallow(s => ({
		workspace: s.workspace, worktreeForm: s.worktreeForm, createWorktree: s.createWorktree,
		connection: s.connection, pcOnline: s.pcOnline, sessionProtocolReady: s.sessionProtocolReady,
	})));
	const live = connection === 'online' && pcOnline && sessionProtocolReady && workspace?.renderers.some(renderer => renderer.ready) === true;
	const [form, setForm] = useState<WorktreeFormResult | undefined>(undefined);
	const [formError, setFormError] = useState<string | undefined>(undefined);
	const [name, setName] = useState('');
	const [branch, setBranch] = useState('');
	const [prompt, setPrompt] = useState('');
	const [agentId, setAgentId] = useState('none');
	const [repoId, setRepoId] = useState<string | undefined>(undefined);
	const [baseRef, setBaseRef] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const requestGenerationRef = useRef(0);
	const activeRequestRef = useRef<number | undefined>();
	const mountedRef = useRef(true);
	const visibleRef = useRef(visible);
	visibleRef.current = visible;
	useEffect(() => {
		mountedRef.current = true;
		return () => { mountedRef.current = false; };
	}, []);

	// 開くたびに入力を初期化する。接続の瞬断ではこのeffectは走らないため、入力中の内容を保持する。
	useEffect(() => {
		if (!visible || activeRequestRef.current !== undefined) {
			return;
		}
		setForm(undefined);
		setFormError(undefined);
		setName('');
		setBranch('');
		setPrompt('');
		setAgentId('none');
		setRepoId(undefined);
		setBaseRef(undefined);
		setBusy(false);
		setError(undefined);
	}, [visible]);

	// フォーム材料は未取得時だけ要求する。切断中は既に表示中のフォームと入力を残し、
	// 再接続後に材料が無い場合だけ自動で読み込む。
	useEffect(() => {
		if (!visible) {
			return;
		}
		if (!live) {
			setFormError('PCへ再接続すると作成フォームを読み込めます。');
			return;
		}
		if (form !== undefined) {
			setFormError(undefined);
			return;
		}
		setFormError(undefined);
		let cancelled = false;
		worktreeForm().then(result => {
			if (cancelled) {
				return;
			}
			setForm(result);
			// 既定リポジトリ: PC側アクティブワークスペースの親リポジトリ（PC版ダイアログと同じ）
			const active = workspace?.activeWs !== undefined ? workspace.workspaces.find(w => w.id === workspace.activeWs) : undefined;
			const preferredId = active !== undefined ? (active.parent ?? active.id) : undefined;
			const repo = result.repos.find(r => r.id === preferredId) ?? result.repos[0];
			setRepoId(repo?.id);
			setBaseRef(repo?.head ?? repo?.branches[0]);
		}).catch((e: unknown) => {
			if (!cancelled) {
				setFormError(String(e instanceof Error ? e.message : e));
			}
		});
		return () => { cancelled = true; };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [visible, live, form, worktreeForm, workspace]);

	const repo = form?.repos.find(r => r.id === repoId);
	const canCreate = live && repo !== undefined && baseRef !== undefined && !busy;

	const selectRepo = (id: string) => {
		hapticSelection();
		setRepoId(id);
		const next = form?.repos.find(r => r.id === id);
		setBaseRef(next?.head ?? next?.branches[0]);
	};

	const create = async () => {
		if (!live || !repo || !baseRef || busy) {
			return;
		}
		hapticImpact('medium');
		setBusy(true);
		setError(undefined);
		const requestGeneration = ++requestGenerationRef.current;
		activeRequestRef.current = requestGeneration;
		try {
			const result = await createWorktree({
				repo: repo.id,
				...(name.trim().length > 0 ? { name: name.trim() } : {}),
				...(branch.trim().length > 0 ? { branch: branch.trim() } : {}),
				base: baseRef,
				...(prompt.trim().length > 0 ? { prompt: prompt.trim() } : {}),
				...(agentId !== 'none' ? { agent: agentId } : {}),
			});
			if (!mountedRef.current || activeRequestRef.current !== requestGeneration) {
				return;
			}
			activeRequestRef.current = undefined;
			setBusy(false);
			if (visibleRef.current) {
				onClose();
			}
			if (result.warning) {
				Alert.alert('スペースを作成しました', `ただし後続の処理でエラーがありました: ${result.warning}`);
			}
		} catch (e) {
			if (!mountedRef.current || activeRequestRef.current !== requestGeneration) {
				return;
			}
			activeRequestRef.current = undefined;
			setError(String(e instanceof Error ? e.message : e));
			setBusy(false);
		}
	};

	const close = () => {
		if (activeRequestRef.current === undefined) {
			onClose();
		}
	};

	return (
		<BottomSheet visible={visible} onClose={close} title="新しいスペース（worktree）を作成">
			<KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
				<ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
					{formError ? <Text style={styles.error}>{formError}</Text> : null}
					{!form && !formError ? <ActivityIndicator style={styles.spinner} /> : null}
					{form ? (
						<>
							<View style={styles.fieldRow}>
								<TextInput
									style={[styles.input, styles.fieldHalf]}
									value={name}
									onChangeText={setName}
									placeholder="スペース名（表示名・任意）"
									placeholderTextColor={colors.textDim}
									autoCapitalize="none"
									editable={!busy}
								/>
								<TextInput
									style={[styles.input, styles.fieldHalf]}
									value={branch}
									onChangeText={setBranch}
									placeholder="ブランチ名（任意）"
									placeholderTextColor={colors.textDim}
									autoCapitalize="none"
									autoCorrect={false}
									editable={!busy}
								/>
							</View>
							<TextInput
								style={[styles.input, styles.promptInput]}
								value={prompt}
								onChangeText={setPrompt}
								placeholder="何をしますか？（任意 — エージェントへの指示。ブランチ名の自動生成にも使われます）"
								placeholderTextColor={colors.textDim}
								multiline
								editable={!busy}
							/>
							<Text style={styles.label}>エージェント</Text>
							<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pillRow}>
								{[{ id: 'none', label: '実行しない' }, ...form.agents].map(agent => (
									<Pressable
										key={agent.id}
										style={[styles.pill, agentId === agent.id && styles.pillActive]}
										onPress={() => { hapticSelection(); setAgentId(agent.id); }}
										disabled={busy}
									>
										<Text style={[styles.pillText, agentId === agent.id && styles.pillTextActive]}>{agent.label}</Text>
									</Pressable>
								))}
							</ScrollView>
							<Text style={styles.label}>リポジトリ</Text>
							<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pillRow}>
								{form.repos.map(r => (
									<Pressable
										key={r.id}
										style={[styles.pill, repoId === r.id && styles.pillActive]}
										onPress={() => selectRepo(r.id)}
										disabled={busy}
									>
										<Text style={[styles.pillText, repoId === r.id && styles.pillTextActive]}>{r.name}</Text>
									</Pressable>
								))}
							</ScrollView>
							<Text style={styles.label}>ベースブランチ</Text>
							<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pillRow}>
								{(repo?.branches ?? []).map(b => (
									<Pressable
										key={b}
										style={[styles.pill, baseRef === b && styles.pillActive]}
										onPress={() => { hapticSelection(); setBaseRef(b); }}
										disabled={busy}
									>
										<Text style={[styles.pillText, styles.pillTextMono, baseRef === b && styles.pillTextActive]}>{b}</Text>
									</Pressable>
								))}
								{repo !== undefined && repo.branches.length === 0 ? <Text style={styles.dim}>ブランチを取得できませんでした</Text> : null}
							</ScrollView>
							{error ? <Text style={styles.error}>{error}</Text> : null}
							<View style={styles.btnRow}>
								<Pressable style={[styles.btn, styles.btnCancel]} onPress={() => { hapticImpact('light'); onClose(); }} disabled={busy}>
									<Text style={styles.btnCancelText}>キャンセル</Text>
								</Pressable>
								<Pressable style={[styles.btn, styles.btnCreate, !canCreate && styles.btnDisabled]} onPress={() => { void create(); }} disabled={!canCreate}>
									<Text style={styles.btnCreateText}>{busy ? '作成中…' : '作成'}</Text>
								</Pressable>
							</View>
						</>
					) : null}
				</ScrollView>
			</KeyboardAvoidingView>
		</BottomSheet>
	);
}

const styles = StyleSheet.create({
	content: { paddingHorizontal: 18, paddingBottom: 30 },
	spinner: { marginVertical: 24 },
	fieldRow: { flexDirection: 'row', gap: 8 },
	fieldHalf: { flex: 1 },
	input: {
		backgroundColor: 'rgba(0,0,0,0.35)', borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 10,
		paddingHorizontal: 12, paddingVertical: 10, color: colors.text, fontSize: 13, marginBottom: 8,
	},
	promptInput: { minHeight: 74, textAlignVertical: 'top' },
	label: { color: colors.textDim, fontSize: 12, marginTop: 6, marginBottom: 6 },
	pillRow: { flexDirection: 'row', gap: 8, paddingBottom: 4 },
	pill: { backgroundColor: colors.surface3, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 8, paddingHorizontal: 11, paddingVertical: 6 },
	pillActive: { backgroundColor: colors.accentWash, borderColor: colors.accent },
	pillText: { color: colors.text, fontSize: 12 },
	pillTextMono: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11 },
	pillTextActive: { color: colors.accent, fontWeight: '700' },
	dim: { color: colors.textDim, fontSize: 12 },
	error: { color: colors.red, fontSize: 12, marginTop: 8, lineHeight: 17 },
	btnRow: { flexDirection: 'row', gap: 10, marginTop: 16 },
	btn: { flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
	btnCancel: { backgroundColor: colors.surface3 },
	btnCancelText: { color: colors.text, fontSize: 14, fontWeight: '700' },
	btnCreate: { backgroundColor: colors.accent2 },
	btnDisabled: { opacity: 0.5 },
	btnCreateText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
