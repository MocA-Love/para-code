// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import type { WorktreeAgentDef, WorktreeFormResult } from '../store.js';
import { allowedEfforts, buildLaunchCommandPreview } from './agentLaunchCommand.js';
import { BottomSheet } from './bottomSheet.js';
import { EffortSlider } from './effortSlider.js';
import { GlassSurface } from './glassSurface.js';
import { ProviderLogo } from './providerLogo.js';
import { useEffectiveWs, wsColor } from './wsDrawer.js';
import { useTabBarSpacer } from '../hooks/useTabBarSpacer.js';
import { colors, mono } from '../theme.js';
import { hapticImpact, hapticSelection } from '../haptics.js';

/**
 * ホームヘッダーの＋ボタンから開く「新しいエージェントを起動」シート。
 * エージェント（Claude/Codex等）・起動先スペース（既存 or その場で新規worktree作成）・
 * 権限モード・モデル/Effort（折りたたみ、エージェント詳細画面の ModelPill/EffortSlider と
 * 同じ見た目）・最初の指示を選んで起動する。選択肢とコマンドテンプレートはPC側の
 * エージェント定義（worktreeForm の agents）を正本にし、コマンドプレビューもPC側の
 * 組み立て規則（プレースホルダ置換）をなぞって表示する。
 *
 * 起動はバックグラウンド方針: CTAで即シートを閉じ、画面下部のガラストーストで進行を示す。
 * 既存スペースへは scm launchAgent、新規スペースは従来の createWorktree（エージェント
 * オプション付き）を使い、いずれもPC側で対象ワークスペースへスコープ付けされたターミナルに
 * エージェントCLIコマンドが送られる。
 */

/** ヘッダー右側の＋ボタン（通知ベルと同じ40×40のLiquid Glass丸ボタン）。 */
export function AgentLaunchButton({ onPress }: { onPress: () => void }) {
	return (
		<Pressable style={styles.addBtn} onPress={() => { hapticImpact('light'); onPress(); }} accessibilityRole="button" accessibilityLabel="新しいエージェントを起動">
			<GlassSurface style={styles.addBtnGlass} interactive />
			<Ionicons name="add" size={22} color={colors.accent} />
		</Pressable>
	);
}

interface LaunchToastState {
	text: string;
	sub: string;
	phase: 'progress' | 'done';
}

export function AgentLaunchSheet({ visible, onClose }: {
	visible: boolean;
	onClose: () => void;
}) {
	const { workspace, worktreeForm, createWorktree, launchAgent, connection, pcOnline, sessionProtocolReady } = useAppStore(useShallow(s => ({
		workspace: s.workspace, worktreeForm: s.worktreeForm, createWorktree: s.createWorktree, launchAgent: s.launchAgent,
		connection: s.connection, pcOnline: s.pcOnline, sessionProtocolReady: s.sessionProtocolReady,
	})));
	const effectiveWs = useEffectiveWs();
	const tabBarSpacer = useTabBarSpacer();
	const live = connection === 'online' && pcOnline && sessionProtocolReady && workspace?.renderers.some(renderer => renderer.ready) === true;

	const [form, setForm] = useState<WorktreeFormResult | undefined>(undefined);
	const [formError, setFormError] = useState<string | undefined>(undefined);
	const [agentId, setAgentId] = useState<string | undefined>(undefined);
	/** 'new' はインラインの新規スペース作成。それ以外は既存ワークスペースid。 */
	const [spaceId, setSpaceId] = useState<string | undefined>(undefined);
	const [newName, setNewName] = useState('');
	const [newBranch, setNewBranch] = useState('');
	const [newRepoId, setNewRepoId] = useState<string | undefined>(undefined);
	const [runSetup, setRunSetup] = useState(true);
	const [permissionId, setPermissionId] = useState<string | undefined>(undefined);
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [modelId, setModelId] = useState<string>('default');
	const [effortId, setEffortId] = useState<string | undefined>(undefined);
	const [prompt, setPrompt] = useState('');
	const [toast, setToast] = useState<LaunchToastState | undefined>(undefined);
	const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			if (toastTimer.current !== undefined) {
				clearTimeout(toastTimer.current);
			}
		};
	}, []);

	// 開くたびに入力を初期化する（スペースの既定は現在の選択ワークスペース）。
	useEffect(() => {
		if (!visible) {
			return;
		}
		setForm(undefined);
		setFormError(undefined);
		setAgentId(undefined);
		setSpaceId(effectiveWs?.id);
		setNewName('');
		setNewBranch('');
		setNewRepoId(undefined);
		setRunSetup(true);
		setPermissionId(undefined);
		setAdvancedOpen(false);
		setModelId('default');
		setEffortId(undefined);
		setPrompt('');
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [visible]);

	// 既定リポジトリ算出用のworkspaceスナップショット。stateのpushで頻繁に更新されるため、
	// フォーム取得effectの依存には入れずrefで最新値だけ参照する（更新のたびの再フェッチを防ぐ）。
	const workspaceRef = useRef(workspace);
	workspaceRef.current = workspace;

	// フォーム材料（エージェント定義・リポジトリ一覧）の取得。WorktreeCreateSheet と同じ再接続方針。
	useEffect(() => {
		if (!visible) {
			return;
		}
		if (!live) {
			setFormError('PCへ再接続すると起動フォームを読み込めます。');
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
			// Gemini CLI はモバイルの起動シートでは提供しない（Claude/Codex＋カスタム定義のみ）
			result = { ...result, agents: result.agents.filter(candidate => candidate.id !== 'gemini') };
			setForm(result);
			const firstAgent = result.agents[0];
			setAgentId(firstAgent?.id);
			setPermissionId(firstAgent?.permissions?.[0]?.id);
			// 新規スペースの既定リポジトリ: PC側アクティブワークスペースの親リポジトリ
			const desktop = workspaceRef.current;
			const active = desktop?.activeWs !== undefined ? desktop.workspaces.find(w => w.id === desktop.activeWs) : undefined;
			const preferredId = active !== undefined ? (active.parent ?? active.id) : undefined;
			setNewRepoId((result.repos.find(r => r.id === preferredId) ?? result.repos[0])?.id);
		}).catch((e: unknown) => {
			if (!cancelled) {
				setFormError(String(e instanceof Error ? e.message : e));
			}
		});
		return () => { cancelled = true; };
	}, [visible, live, form, worktreeForm]);

	const agent = form?.agents.find(candidate => candidate.id === agentId);
	const agentAccent = agentId === 'claude' ? colors.claude : colors.accent;
	const agentAccentWash = agentId === 'claude' ? 'rgba(217,119,87,.14)' : colors.accentWash;
	const selectedModel = modelId !== 'default' ? agent?.models?.find(model => model.id === modelId) : undefined;
	const efforts = agent !== undefined ? allowedEfforts(agent, selectedModel) : undefined;
	const newRepo = form?.repos.find(r => r.id === newRepoId);
	const spaces = workspace?.workspaces ?? [];
	const selectedSpace = spaceId !== 'new' ? spaces.find(w => w.id === spaceId) : undefined;
	const selectedPermission = agent?.permissions?.find(permission => permission.id === permissionId);
	// 旧PCはエージェント定義をid/labelのみで配信し、scm launchAgent も未対応（送ると無応答で
	// タイムアウトする）。command の有無を能力判定に使い、既存スペースへの起動を無効化する。
	// 新規スペース作成（createWorktree）は旧PCでも通る（追加オプションは無視される）。
	const pcSupportsLaunch = form?.agents.some(candidate => candidate.command !== undefined) === true;
	const launchBlockedByOldPc = spaceId !== 'new' && !pcSupportsLaunch;
	const canLaunch = live && agent !== undefined && !launchBlockedByOldPc
		&& (spaceId === 'new' ? newRepo !== undefined : selectedSpace !== undefined);

	const selectAgent = (id: string) => {
		hapticSelection();
		setAgentId(id);
		const next = form?.agents.find(candidate => candidate.id === id);
		setPermissionId(next?.permissions?.[0]?.id);
		setModelId('default');
		setEffortId(undefined);
	};

	const selectModel = (id: string) => {
		hapticSelection();
		setModelId(id);
		if (id === 'default' || agent === undefined) {
			setEffortId(undefined);
			return;
		}
		const model = agent.models?.find(candidate => candidate.id === id);
		const allowed = allowedEfforts(agent, model) ?? [];
		// モデル変更でeffort候補が変わった場合は既定（無ければ中央値）へフォールバックする
		setEffortId(current => {
			if (current !== undefined && allowed.includes(current)) {
				return current;
			}
			if (model?.defaultEffort !== undefined && allowed.includes(model.defaultEffort)) {
				return model.defaultEffort;
			}
			return allowed[Math.floor((allowed.length - 1) / 2)];
		});
	};

	/** 実際の起動要求に載せるオプションid（既定・非対応の選択はフラグ同様に省く）。 */
	const launchOptionIds = () => ({
		...(selectedModel !== undefined ? { model: selectedModel.id } : {}),
		...(selectedModel !== undefined && effortId !== undefined && (efforts ?? []).includes(effortId) ? { effort: effortId } : {}),
		...(selectedPermission !== undefined && selectedPermission.flag.length > 0 ? { permission: selectedPermission.id } : {}),
	});

	const previewFlags = agent === undefined ? { model: '', effort: '', permission: '' } : {
		model: selectedModel?.flag ?? '',
		effort: selectedModel !== undefined && effortId !== undefined && (efforts ?? []).includes(effortId)
			? (agent.efforts?.find(effort => effort.id === effortId)?.flag ?? '')
			: '',
		permission: selectedPermission?.flag ?? '',
	};
	const commandPreview = agent !== undefined ? `$ ${buildLaunchCommandPreview(agent, prompt, previewFlags)}` : undefined;

	const showToast = (state: LaunchToastState, autoHideMs?: number) => {
		if (!mountedRef.current) {
			return;
		}
		if (toastTimer.current !== undefined) {
			clearTimeout(toastTimer.current);
			toastTimer.current = undefined;
		}
		setToast(state);
		if (autoHideMs !== undefined) {
			toastTimer.current = setTimeout(() => {
				toastTimer.current = undefined;
				if (mountedRef.current) {
					setToast(undefined);
				}
			}, autoHideMs);
		}
	};

	const launch = () => {
		if (!canLaunch || agent === undefined) {
			return;
		}
		hapticImpact('medium');
		const trimmedPrompt = prompt.trim();
		const agentLabel = agent.label;
		onClose();
		if (spaceId === 'new' && newRepo !== undefined) {
			const subtitle = newName.trim() || newBranch.trim() || newRepo.name;
			showToast({ text: `新しいスペースを作成して ${agentLabel} を起動中…`, sub: subtitle, phase: 'progress' });
			createWorktree({
				repo: newRepo.id,
				...(newName.trim().length > 0 ? { name: newName.trim() } : {}),
				...(newBranch.trim().length > 0 ? { branch: newBranch.trim() } : {}),
				...(newRepo.head !== undefined ? { base: newRepo.head } : {}),
				...(trimmedPrompt.length > 0 ? { prompt: trimmedPrompt } : {}),
				agent: agent.id,
				...launchOptionIds(),
				...(newRepo.setupScript !== undefined ? { runSetup } : {}),
			}).then(result => {
				showToast({ text: `${agentLabel} を起動しました`, sub: `${result.name} · ${result.branch}`, phase: 'done' }, 2_500);
				if (result.warning) {
					Alert.alert('スペースを作成しました', `ただし後続の処理でエラーがありました: ${result.warning}`);
				}
			}).catch((e: unknown) => {
				showToast({ text: '起動できませんでした', sub: '', phase: 'done' }, 1_200);
				Alert.alert('エージェントを起動できませんでした', String(e instanceof Error ? e.message : e));
			});
			return;
		}
		if (selectedSpace === undefined) {
			return;
		}
		const subtitle = `${selectedSpace.name.replace(/^✦ /, '')}${selectedSpace.branch ? ` · ${selectedSpace.branch}` : ''}`;
		showToast({ text: `${agentLabel} を起動中…`, sub: subtitle, phase: 'progress' });
		launchAgent({
			ws: selectedSpace.id,
			agent: agent.id,
			...(trimmedPrompt.length > 0 ? { prompt: trimmedPrompt } : {}),
			...launchOptionIds(),
		}).then(() => {
			showToast({ text: `${agentLabel} を起動しました`, sub: subtitle, phase: 'done' }, 2_500);
		}).catch((e: unknown) => {
			showToast({ text: '起動できませんでした', sub: '', phase: 'done' }, 1_200);
			Alert.alert('エージェントを起動できませんでした', String(e instanceof Error ? e.message : e));
		});
	};

	return (
		<>
			<BottomSheet visible={visible} onClose={onClose} title="新しいエージェントを起動">
				<KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
					<ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
						{formError ? <Text style={styles.error}>{formError}</Text> : null}
						{!form && !formError ? <ActivityIndicator style={styles.spinner} /> : null}
						{form && agent !== undefined ? (
							<>
								<Text style={styles.label}>エージェント</Text>
								<View style={styles.agentCards}>
									{form.agents.map(candidate => {
										const active = candidate.id === agentId;
										const accent = candidate.id === 'claude' ? colors.claude : colors.accent;
										return (
											<Pressable
												key={candidate.id}
												style={[styles.agentCard, active && { borderColor: accent, backgroundColor: candidate.id === 'claude' ? 'rgba(217,119,87,.13)' : colors.accentWash }]}
												onPress={() => selectAgent(candidate.id)}
												accessibilityRole="button"
												accessibilityState={{ selected: active }}
											>
												{candidate.id === 'claude' || candidate.id === 'codex'
													? <ProviderLogo provider={candidate.id} size={24} />
													: <Ionicons name="sparkles-outline" size={20} color={active ? accent : colors.textDim} />}
												<Text style={[styles.agentCardName, active && styles.agentCardNameActive]} numberOfLines={1}>{candidate.label}</Text>
												{active ? <Ionicons name="checkmark-circle" size={17} color={accent} style={styles.agentCardCheck} /> : null}
											</Pressable>
										);
									})}
								</View>

								<Text style={styles.label}>スペース</Text>
								<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
									{spaces.map(ws => {
										const active = spaceId === ws.id;
										const color = wsColor(ws);
										const name = ws.name.replace(/^✦ /, '');
										return (
											<Pressable
												key={ws.id}
												style={[styles.spaceChip, active && { borderColor: colors.accent, backgroundColor: colors.accentWash }]}
												onPress={() => { hapticSelection(); setSpaceId(ws.id); }}
												accessibilityRole="button"
												accessibilityState={{ selected: active }}
											>
												<View style={[styles.spaceAvatar, { backgroundColor: color + '26' }]}>
													<Text style={[styles.spaceAvatarText, { color }]}>{ws.parent !== undefined ? '✦' : name.charAt(0).toUpperCase()}</Text>
												</View>
												<View style={styles.spaceMeta}>
													<Text style={styles.spaceName} numberOfLines={1}>{name}</Text>
													{ws.branch ? (
														<View style={styles.spaceBranchRow}>
															<Ionicons name="git-branch-outline" size={9} color={colors.textDim} />
															<Text style={styles.spaceBranch} numberOfLines={1}>{ws.branch}</Text>
														</View>
													) : null}
												</View>
											</Pressable>
										);
									})}
									<Pressable
										style={[styles.spaceChip, styles.newSpaceChip, spaceId === 'new' && { borderColor: colors.accent, backgroundColor: colors.accentWash, borderStyle: 'solid' }]}
										onPress={() => { hapticSelection(); setSpaceId('new'); }}
										accessibilityRole="button"
										accessibilityState={{ selected: spaceId === 'new' }}
									>
										<View style={[styles.spaceAvatar, styles.newSpaceAvatar]}>
											<Ionicons name="add" size={13} color={colors.textDim} />
										</View>
										<View style={styles.spaceMeta}>
											<Text style={styles.spaceName}>新規スペース</Text>
										</View>
									</Pressable>
								</ScrollView>
								{spaceId === 'new' ? (
									<View style={styles.newSpacePanel}>
										<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pillRow}>
											{form.repos.map(r => (
												<Pressable
													key={r.id}
													style={[styles.pill, newRepoId === r.id && styles.pillActive]}
													onPress={() => { hapticSelection(); setNewRepoId(r.id); }}
												>
													<Text style={[styles.pillText, newRepoId === r.id && styles.pillTextActive]}>{r.name}</Text>
												</Pressable>
											))}
										</ScrollView>
										<View style={styles.fieldRow}>
											<TextInput
												style={[styles.input, styles.fieldHalf]}
												value={newName}
												onChangeText={setNewName}
												placeholder="スペース名（任意）"
												placeholderTextColor={colors.textDim}
												autoCapitalize="none"
											/>
											<TextInput
												style={[styles.input, styles.fieldHalf]}
												value={newBranch}
												onChangeText={setNewBranch}
												placeholder="ブランチ名（任意）"
												placeholderTextColor={colors.textDim}
												autoCapitalize="none"
												autoCorrect={false}
											/>
										</View>
										{newRepo?.setupScript !== undefined ? (
											<View style={styles.setupRow}>
												<Text style={styles.setupLabel}>setup スクリプトを実行</Text>
												<Text style={styles.setupScript} numberOfLines={1}>{newRepo.setupScript}</Text>
												<Switch value={runSetup} onValueChange={value => { hapticSelection(); setRunSetup(value); }} trackColor={{ true: colors.green }} />
											</View>
										) : null}
									</View>
								) : null}

								{(agent.permissions?.length ?? 0) > 0 ? (
									<>
										<Text style={styles.label}>権限</Text>
										<View style={styles.segRow}>
											{agent.permissions!.map(permission => {
												const active = permissionId === permission.id;
												return (
													<Pressable
														key={permission.id}
														style={[styles.segBtn, active && (permission.danger ? styles.segBtnDanger : styles.segBtnActive)]}
														onPress={() => { hapticSelection(); setPermissionId(permission.id); }}
														accessibilityRole="button"
														accessibilityState={{ selected: active }}
													>
														<Text style={[styles.segText, active && (permission.danger ? styles.segTextDanger : styles.segTextActive)]} numberOfLines={1}>
															{permission.label}
														</Text>
													</Pressable>
												);
											})}
										</View>
									</>
								) : null}

								{(agent.models?.length ?? 0) > 0 ? (
									<>
										<Pressable style={styles.disclosureBtn} onPress={() => { hapticSelection(); setAdvancedOpen(open => !open); }} accessibilityRole="button" accessibilityState={{ expanded: advancedOpen }}>
											<Text style={styles.label}>詳細設定（モデル・Effort）</Text>
											<Ionicons name={advancedOpen ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textDim} />
										</Pressable>
										{advancedOpen ? (
											<>
												{[{ id: 'default', label: '既定' }, ...agent.models!].map(model => {
													const active = modelId === model.id;
													return (
														<Pressable
															key={model.id}
															style={[styles.modelRow, active && { backgroundColor: agentAccentWash, borderColor: agentAccent }]}
															onPress={() => selectModel(model.id)}
															accessibilityRole="button"
															accessibilityState={{ selected: active }}
														>
															<Text style={[styles.modelLabel, active && styles.modelLabelActive]}>{model.label ?? model.id}</Text>
															{active ? <Ionicons name="checkmark" size={16} color={agentAccent} /> : null}
														</Pressable>
													);
												})}
												{selectedModel !== undefined && (efforts ?? []).length > 0 ? (
													<EffortSlider
														efforts={efforts!}
														value={effortId}
														disabled={false}
														accentColor={agentAccent}
														onChange={effort => setEffortId(effort)}
													/>
												) : selectedModel !== undefined ? (
													<Text style={styles.hint}>このモデルは Effort 指定に対応していません</Text>
												) : (
													<Text style={styles.hint}>モデルを選ぶと Effort を指定できます（既定はエージェント側の設定に従います）</Text>
												)}
											</>
										) : null}
									</>
								) : null}

								<Text style={styles.label}>最初の指示（任意）</Text>
								<TextInput
									style={[styles.input, styles.promptInput]}
									value={prompt}
									onChangeText={setPrompt}
									placeholder="何をしますか？（エージェントへの最初の指示）"
									placeholderTextColor={colors.textDim}
									multiline
								/>

								{commandPreview !== undefined ? (
									<Text style={styles.cmdPreview} numberOfLines={1}>{commandPreview}</Text>
								) : null}
								{launchBlockedByOldPc ? (
									<Text style={styles.hint}>PC側の Para Code が古いため、既存スペースへの起動には未対応です。PCを更新するか「新規スペース」を選んでください。</Text>
								) : null}
								<Pressable
									style={[styles.launchBtn, { backgroundColor: agentId === 'claude' ? colors.claude : colors.accent2 }, !canLaunch && styles.launchBtnDisabled]}
									onPress={launch}
									disabled={!canLaunch}
									accessibilityRole="button"
								>
									<Text style={styles.launchBtnText}>起動する</Text>
								</Pressable>
							</>
						) : null}
					</ScrollView>
				</KeyboardAvoidingView>
			</BottomSheet>
			{toast !== undefined ? (
				<View style={[styles.toast, { bottom: tabBarSpacer + 10 }]} pointerEvents="none">
					<GlassSurface style={styles.toastGlass} />
					{toast.phase === 'progress'
						? <ActivityIndicator size="small" color={colors.accent} />
						: <Ionicons name="checkmark-circle" size={18} color={colors.green} />}
					<View style={styles.toastBody}>
						<Text style={styles.toastText} numberOfLines={1}>{toast.text}</Text>
						{toast.sub.length > 0 ? <Text style={styles.toastSub} numberOfLines={1}>{toast.sub}</Text> : null}
					</View>
				</View>
			) : null}
		</>
	);
}

const styles = StyleSheet.create({
	addBtn: {
		width: 40, height: 40, borderRadius: 20,
		alignItems: 'center', justifyContent: 'center',
	},
	addBtnGlass: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 20, overflow: 'hidden' },
	content: { paddingHorizontal: 18, paddingBottom: 30 },
	spinner: { marginVertical: 24 },
	error: { color: colors.red, fontSize: 12, marginTop: 8, lineHeight: 17 },
	label: { color: colors.textDim, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 12, marginBottom: 7 },
	hint: { color: colors.textDim, fontSize: 10.5, lineHeight: 15, marginTop: 6 },
	// エージェントカード（コンパクトな横並び行）
	agentCards: { flexDirection: 'row', gap: 8 },
	agentCard: {
		flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8,
		backgroundColor: colors.surface2, borderWidth: 1.5, borderColor: colors.border,
		borderRadius: 13, paddingVertical: 9, paddingHorizontal: 10,
	},
	agentCardName: { flex: 1, color: colors.textDim, fontSize: 12.5, fontWeight: '700' },
	agentCardNameActive: { color: colors.text },
	agentCardCheck: { marginLeft: -4 },
	// スペースチップ
	chipRow: { flexDirection: 'row', gap: 8, paddingBottom: 3 },
	spaceChip: {
		flexDirection: 'row', alignItems: 'center', gap: 8,
		backgroundColor: colors.surface3, borderWidth: 1, borderColor: colors.borderStrong,
		borderRadius: 13, paddingVertical: 6, paddingHorizontal: 10, paddingLeft: 6, maxWidth: 190,
	},
	newSpaceChip: { borderStyle: 'dashed', backgroundColor: 'transparent' },
	spaceAvatar: { width: 24, height: 24, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
	newSpaceAvatar: { borderWidth: 1.2, borderColor: colors.textDim, borderStyle: 'dashed' },
	spaceAvatarText: { fontSize: 11, fontWeight: '800', fontFamily: Platform.OS === 'ios' ? mono.ios : mono.default },
	spaceMeta: { flexShrink: 1 },
	spaceName: { color: colors.text, fontSize: 12, fontWeight: '600' },
	spaceBranchRow: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 1 },
	spaceBranch: { color: colors.textDim, fontSize: 10, fontFamily: Platform.OS === 'ios' ? mono.ios : mono.default, flexShrink: 1 },
	// 新規スペースのインラインパネル
	newSpacePanel: {
		marginTop: 10, padding: 10, borderRadius: 12, gap: 8,
		backgroundColor: 'rgba(0,0,0,0.28)', borderWidth: 1, borderColor: colors.border,
	},
	fieldRow: { flexDirection: 'row', gap: 8 },
	fieldHalf: { flex: 1 },
	input: {
		backgroundColor: 'rgba(0,0,0,0.35)', borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 10,
		paddingHorizontal: 12, paddingVertical: 10, color: colors.text, fontSize: 13,
	},
	promptInput: { minHeight: 64, textAlignVertical: 'top' },
	pillRow: { flexDirection: 'row', gap: 7, paddingBottom: 2 },
	pill: { backgroundColor: colors.surface3, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 8, paddingHorizontal: 11, paddingVertical: 6 },
	pillActive: { backgroundColor: colors.accentWash, borderColor: colors.accent },
	pillText: { color: colors.text, fontSize: 12 },
	pillTextActive: { color: colors.accent, fontWeight: '700' },
	setupRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	setupLabel: { color: colors.text, fontSize: 11.5, flexShrink: 0 },
	setupScript: {
		flex: 1, color: colors.textDim, fontSize: 10, fontFamily: Platform.OS === 'ios' ? mono.ios : mono.default,
		backgroundColor: 'rgba(0,0,0,0.35)', borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden',
	},
	// 権限セグメント
	segRow: { flexDirection: 'row', gap: 3, backgroundColor: colors.surface3, borderRadius: 12, padding: 3, borderWidth: 1, borderColor: colors.border },
	segBtn: { flex: 1, borderRadius: 9, paddingVertical: 9, paddingHorizontal: 4, alignItems: 'center' },
	segBtnActive: { backgroundColor: colors.surface2 },
	segBtnDanger: { backgroundColor: 'rgba(244,114,114,.16)' },
	segText: { color: colors.textDim, fontSize: 12, fontWeight: '700' },
	segTextActive: { color: colors.text },
	segTextDanger: { color: colors.red },
	// 詳細設定（モデル行はエージェント詳細画面の ModelPill シートと同デザイン）
	disclosureBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingRight: 2 },
	modelRow: {
		flexDirection: 'row', alignItems: 'center', gap: 10,
		backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border,
		borderRadius: 13, paddingVertical: 11, paddingHorizontal: 13, marginBottom: 7,
	},
	modelLabel: { flex: 1, color: colors.textDim, fontSize: 13.5, fontWeight: '700' },
	modelLabelActive: { color: colors.text },
	// フッター
	cmdPreview: {
		marginTop: 12, color: colors.textDim, fontSize: 10, fontFamily: Platform.OS === 'ios' ? mono.ios : mono.default,
		backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, overflow: 'hidden',
	},
	launchBtn: { marginTop: 10, borderRadius: 13, paddingVertical: 13, alignItems: 'center' },
	launchBtnDisabled: { opacity: 0.5 },
	launchBtnText: { color: '#fff', fontSize: 14, fontWeight: '800' },
	// 起動トースト（タブバーの上のLiquid Glass。シートを閉じた後の進行表示）
	toast: {
		position: 'absolute', left: 16, right: 16,
		flexDirection: 'row', alignItems: 'center', gap: 10,
		borderRadius: 16, paddingVertical: 11, paddingHorizontal: 14,
	},
	toastGlass: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 16, overflow: 'hidden' },
	toastBody: { flex: 1, minWidth: 0 },
	toastText: { color: colors.text, fontSize: 12.5, fontWeight: '700' },
	toastSub: { color: colors.textDim, fontSize: 10.5, marginTop: 1 },
});
