// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useRouter, usePreventZoomTransitionDismissal } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../src/appState.js';
import { launchAgentInBackground } from '../src/agentLaunch.js';
import type { WorktreeFormResult } from '../src/store.js';
import { allowedEfforts, buildLaunchCommandPreview } from '../src/components/agentLaunchCommand.js';
import { EffortSlider } from '../src/components/effortSlider.js';
import { GlassSurface } from '../src/components/glassSurface.js';
import { ProviderLogo } from '../src/components/providerLogo.js';
import { useEffectiveWs, wsColor } from '../src/components/wsDrawer.js';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { colors, mono } from '../src/theme.js';
import { hapticImpact, hapticSelection } from '../src/haptics.js';

/**
 * ズーム遷移で開いた画面の「どこからでもスワイプで閉じる」を、掴んでいる間だけ止めるための境界。
 * 開始できる領域を空にする指定で、expo-router 自身が gestureEnabled:false を表すのに使う値と同じ。
 */
const BLOCK_DISMISSAL = { unstable_dismissalBoundsRect: { maxX: 0, maxY: 0 } } as const;

/**
 * 「新しいエージェントを起動」画面。ホームヘッダーの＋から Link.AppleZoom で開く独立ルート
 * （旧agentLaunchSheet.tsxのボトムシートを置き換え。ズーム遷移はヘッダー付き画面と
 * 相性が悪いため、通知一覧・メモと同じく独自ヘッダーを描画する）。
 *
 * エージェント（Claude/Codex等）・起動先スペース（既存 or その場で新規worktree作成）・
 * 権限モード・モデル/Effort（折りたたみ、エージェント詳細画面の ModelPill/EffortSlider と
 * 同じ見た目）・最初の指示を選んで起動する。選択肢とコマンドテンプレートはPC側の
 * エージェント定義（worktreeForm の agents）を正本にし、コマンドプレビューもPC側の
 * 組み立て規則（プレースホルダ置換）をなぞって表示する。
 *
 * 起動はバックグラウンド方針: CTAで即この画面を閉じ、ホームのガラストーストで進行を示す
 * （実行と進行表示は画面の外＝agentLaunch.ts が持つ）。既存スペースへは scm launchAgent、
 * 新規スペースは従来の createWorktree（エージェントオプション付き）を使う。
 */
export default function AgentLaunchScreen() {
	const router = useRouter();
	const insets = useStableInsets();
	const { workspace, worktreeForm, connection, pcOnline, sessionProtocolReady } = useAppStore(useShallow(s => ({
		workspace: s.workspace, worktreeForm: s.worktreeForm,
		connection: s.connection, pcOnline: s.pcOnline, sessionProtocolReady: s.sessionProtocolReady,
	})));
	const effectiveWs = useEffectiveWs();
	const live = connection === 'online' && pcOnline && sessionProtocolReady && workspace?.renderers.some(renderer => renderer.ready) === true;

	const [form, setForm] = useState<WorktreeFormResult | undefined>(undefined);
	const [formError, setFormError] = useState<string | undefined>(undefined);
	const [agentId, setAgentId] = useState<string | undefined>(undefined);
	/** 'new' はインラインの新規スペース作成。それ以外は既存ワークスペースid（既定は現在の選択）。 */
	const [spaceId, setSpaceId] = useState<string | undefined>(effectiveWs?.id);
	const [newName, setNewName] = useState('');
	const [newBranch, setNewBranch] = useState('');
	const [newRepoId, setNewRepoId] = useState<string | undefined>(undefined);
	const [runSetup, setRunSetup] = useState(true);
	const [permissionId, setPermissionId] = useState<string | undefined>(undefined);
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [modelId, setModelId] = useState<string>('default');
	const [effortId, setEffortId] = useState<string | undefined>(undefined);
	const [prompt, setPrompt] = useState('');
	const [effortDragging, setEffortDragging] = useState(false);
	const scrollRef = useRef<ScrollView>(null);

	// Effortのつまみを掴んでいる間だけ、ズーム遷移の「スワイプで閉じる」を止める。
	// 止めないと横方向のドラッグがネイティブ側に取られ、値を変える途中で画面が閉じてホームへ戻る。
	usePreventZoomTransitionDismissal(effortDragging ? BLOCK_DISMISSAL : undefined);

	// 既定リポジトリ算出用のworkspaceスナップショット。stateのpushで頻繁に更新されるため、
	// フォーム取得effectの依存には入れずrefで最新値だけ参照する（更新のたびの再フェッチを防ぐ）。
	const workspaceRef = useRef(workspace);
	workspaceRef.current = workspace;

	// フォーム材料（エージェント定義・リポジトリ一覧）の取得。WorktreeCreateSheet と同じ再接続方針。
	useEffect(() => {
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
			// Gemini CLI はモバイルの起動フォームでは提供しない（Claude/Codex＋カスタム定義のみ）
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
	}, [live, form, worktreeForm]);

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

	const launch = () => {
		if (!canLaunch || agent === undefined) {
			return;
		}
		hapticImpact('medium');
		const trimmedPrompt = prompt.trim();
		if (spaceId === 'new' && newRepo !== undefined) {
			launchAgentInBackground({
				agentLabel: agent.label,
				subtitle: newName.trim() || newBranch.trim() || newRepo.name,
				agent: agent.id,
				prompt: trimmedPrompt,
				...launchOptionIds(),
				newSpace: {
					repo: newRepo.id,
					name: newName.trim(),
					branch: newBranch.trim(),
					...(newRepo.head !== undefined ? { base: newRepo.head } : {}),
					...(newRepo.setupScript !== undefined ? { runSetup } : {}),
				},
			});
			router.back();
			return;
		}
		if (selectedSpace === undefined) {
			return;
		}
		launchAgentInBackground({
			agentLabel: agent.label,
			subtitle: `${selectedSpace.name.replace(/^✦ /, '')}${selectedSpace.branch ? ` · ${selectedSpace.branch}` : ''}`,
			agent: agent.id,
			prompt: trimmedPrompt,
			ws: selectedSpace.id,
			...launchOptionIds(),
		});
		router.back();
	};

	return (
		<View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
			<View style={styles.header}>
				<Pressable
					style={styles.iconBtn}
					onPress={() => { hapticImpact('light'); router.back(); }}
					hitSlop={6}
					accessibilityRole="button"
					accessibilityLabel="閉じる"
				>
					{/* 角丸はガラス面自体に渡す（ネイティブglassが正しい丸形状で描画される） */}
					<GlassSurface style={styles.iconGlass} interactive />
					<Ionicons name="chevron-back" size={18} color={colors.text} />
				</Pressable>
				<Text style={styles.title}>新しいエージェント</Text>
				{/* 左のボタンと釣り合いを取るための空き（タイトルを中央に置くため） */}
				<View style={styles.iconBtn} />
			</View>

			<KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
				<ScrollView ref={scrollRef} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 30 }]} keyboardShouldPersistTaps="handled">
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
													onDragChange={setEffortDragging}
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
								// キーボードで縮んだ後に、入力欄とCTAが見える位置まで送る
								// （キーボードアニメーションの完了を待つ）
								onFocus={() => setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 300)}
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
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	flex: { flex: 1 },
	header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingBottom: 10 },
	title: { flex: 1, color: colors.text, fontSize: 20, fontWeight: '800', letterSpacing: -0.3, textAlign: 'center' },
	iconBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
	iconGlass: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: 18, overflow: 'hidden' },
	content: { paddingHorizontal: 18 },
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
});
