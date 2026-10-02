// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Alert, Pressable, StyleSheet, Text, View, findNodeHandle } from 'react-native';
import { Check, ChevronDown, ChevronLeft, Settings, X } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import { claudeModelDisplayName, matchAgentModel } from '../../agentModels.js';
import { useAppStore } from '../../appState.js';
import { isMaximumEffort } from '../../components/effortSliderBehavior.js';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import { haptic } from '../../haptics.js';
import { useClaudeModelOptions } from '../../hooks/useClaudeModelOptions.js';
import { EMPTY_HIDDEN_MODELS, canHideModel, initialModelSelection, modelVisibilityAgent, pickerModelChoices } from '../../modelVisibility.js';
import type { AgentMessageSendResult, AgentModelControlState } from '../../store.js';
import { HIT_SIZE, colors, radius, space, squircle, type } from '../../theme.js';
import { BottomDrawer, Button, Icon, iconSize, useThemeColors } from '../../ui/index.js';
import { SettingsSwitch } from '../settings/settingsScaffold.js';

/** ピルの見た目の高さ（モックの `.pill`: 28）。当たり判定は 44 に広げる。 */
const PILL_HEIGHT = 28;
const PILL_SLOP = hitSlopToMinimum(PILL_HEIGHT);
/** 見出しの閉じるボタン（モックの `.mnav`）。 */
const NAV_SIZE = 36;

interface ModelOption {
	readonly id: string;
	readonly label: string;
	readonly aliases: readonly string[];
	readonly efforts: readonly string[];
	/** Codex の既定のモデル（model/list の isDefault）。 */
	readonly isDefault?: boolean;
}

/** シートの中身。歯車で「表示するモデル」に切り替え、「完了」か戻るで「モデルを選ぶ」へ戻る。 */
type DrawerPage = 'pick' | 'visibility';

const AGENT_NAMES: Readonly<Record<'claude' | 'codex', string>> = { claude: 'Claude Code', codex: 'Codex' };

/**
 * コンポーザーのモデルと effort のピル（モックの `.pill`）と、押すと開く「モデルを選ぶ」のシート。
 *
 * 送り方は旧部品（`components/modelPill.tsx`）と同じ:
 *  - Claude: PC が Claude Code から取った一覧（取れなければ固定の対応表）から選び、確定したら
 *    `onClaudeSetting('model' | 'effort', …)` を順に送る
 *    （入力待ちでなければ PC が拒否する。理由はそのまま出す）
 *  - Codex: PC から届くモデルの一覧（model/list）を正本にし、確定したら model と effort を一度に送る
 * シートの中の選択は仮のもので、「適用」を押すまで何も送らない。
 *
 * `readOnly`（PC が「モバイルからは変えられない」と伝えてきた Codex のセッション）のときは、ピルは表示だけで
 * 押してもシートを開かない（PC のターミナルの /model で変える）。
 *
 * 右上の歯車で、同じシートの中身を「表示するモデル」（モデルごとのスイッチ）に切り替え、「完了」で戻す。
 * 別のシートを重ねて出さないのは、閉じる途中で次のモーダルを出すと iOS が取りこぼすため（`BottomDrawer` の約束）。
 * 隠したモデルは「モデルを選ぶ」に出さない（使用中のものと仮に選んでいるものは「非表示」の印付きで残す）。計算は `modelVisibility.ts`。
 * ページを切り替えたら、VoiceOver の読み上げ位置を新しいページの見出しへ移す。
 */
export function ModelPill({ agent, model, effort, modelControl, readOnly = false, onClaudeSetting, onRequestCodexCatalog, onUpdateCodexSettings }: {
	agent: string | undefined;
	model: string | undefined;
	effort: string | undefined;
	modelControl: AgentModelControlState | undefined;
	readOnly?: boolean;
	onClaudeSetting: (setting: 'model' | 'effort', value: string) => Promise<AgentMessageSendResult>;
	onRequestCodexCatalog: () => void;
	onUpdateCodexSettings: (model: string, effort: string) => void;
}) {
	const theme = useThemeColors();
	const [open, setOpen] = useState(false);
	const [page, setPage] = useState<DrawerPage>('pick');
	const { hiddenModels, setModelHidden } = useAppStore(useShallow(s => ({ hiddenModels: s.hiddenModels, setModelHidden: s.setModelHidden })));
	const [pickedModelId, setPickedModelId] = useState<string | undefined>(undefined);
	const [pickedEffort, setPickedEffort] = useState<string | undefined>(undefined);
	const [codexUpdatePending, setCodexUpdatePending] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; };
	}, []);
	// 歯車・「完了」・戻るでページを切り替えたときだけ、新しいページの見出しへ VoiceOver を移す
	// （シートを開いたときの読み上げ位置は `BottomDrawer` に任せる）
	const headingRef = useRef<Text>(null);
	const pageSwitched = useRef(false);
	const switchPage = (next: DrawerPage) => {
		haptic('move');
		pageSwitched.current = true;
		setPage(next);
	};
	useEffect(() => {
		if (!pageSwitched.current) {
			return;
		}
		pageSwitched.current = false;
		const node = headingRef.current !== null ? findNodeHandle(headingRef.current) : null;
		if (node !== null) {
			AccessibilityInfo.setAccessibilityFocus(node);
		}
	}, [page]);
	useEffect(() => {
		if (!codexUpdatePending) {
			return;
		}
		if (modelControl?.status === 'ready') {
			setCodexUpdatePending(false);
		} else if (modelControl?.status === 'error') {
			setCodexUpdatePending(false);
			if (!open) {
				Alert.alert('設定を変更できませんでした', modelControl.errorMessage ?? 'Codex から設定の変更を確認できませんでした');
			}
		}
	}, [codexUpdatePending, modelControl?.errorMessage, modelControl?.status, open]);

	const claudeCatalog = useClaudeModelOptions(agent);
	const codexModels = modelControl?.models ?? [];
	const options: readonly ModelOption[] = agent === 'codex'
		? codexModels.map(option => ({
			id: option.model,
			label: option.displayName,
			aliases: option.id === option.model ? [] : [option.id],
			efforts: option.efforts.map(item => item.value),
			isDefault: option.isDefault,
		}))
		: claudeCatalog.options;
	const currentModel = agent === 'codex'
		? options.find(option => option.id === model || option.aliases.includes(model ?? ''))
		: matchAgentModel(agent, model, options);
	const visibilityAgent = modelVisibilityAgent(agent);
	const hiddenIds = visibilityAgent !== undefined ? hiddenModels[visibilityAgent] : EMPTY_HIDDEN_MODELS.claude;
	const choices = pickerModelChoices(options, hiddenIds, currentModel?.id, pickedModelId);
	// 選んだもの → 使用中 → 表示中の既定 → 表示中の先頭（先頭まで落とすのは Codex だけ）
	const selected = initialModelSelection(choices.map(choice => choice.option), {
		pickedId: pickedModelId,
		currentId: currentModel?.id,
		defaultId: agent === 'codex' ? codexModels.find(option => option.isDefault)?.model : undefined,
		fallbackToFirst: agent === 'codex',
	});
	const candidateEffort = pickedEffort ?? effort;
	const effectiveEffort = selected !== undefined && candidateEffort !== undefined && !selected.efforts.includes(candidateEffort)
		? selected.efforts[0]
		: candidateEffort;
	const modelName = currentModel?.label ?? (agent === 'claude' && model !== undefined ? claudeModelDisplayName(model) : undefined) ?? model;
	// effort 非対応のモデル（Haiku）では、前のモデルの effort が残っていても出さない
	const shownEffort = currentModel !== undefined && currentModel.efforts.length === 0 ? undefined : effort;
	const label = [modelName, shownEffort].filter(Boolean).join(' · ') || 'モデル';
	const isCodexBusy = agent === 'codex' && modelControl?.status !== 'ready';
	const locked = isCodexBusy || submitting;

	const openDrawer = () => {
		haptic('move');
		setPickedModelId(undefined);
		setPickedEffort(undefined);
		pageSwitched.current = false;
		setPage('pick');
		setOpen(true);
		if (agent === 'codex') {
			onRequestCodexCatalog();
		} else {
			claudeCatalog.request();
		}
	};
	const close = () => {
		if (!submitting) {
			setOpen(false);
		}
	};
	const apply = async () => {
		if (submitting || selected === undefined) {
			setOpen(false);
			return;
		}
		const modelChanged = selected.id !== currentModel?.id;
		const effortChanged = effectiveEffort !== undefined && effectiveEffort !== effort;
		if (!modelChanged && !effortChanged) {
			setOpen(false);
			return;
		}
		if (agent === 'codex') {
			if (effectiveEffort !== undefined) {
				setCodexUpdatePending(true);
				onUpdateCodexSettings(selected.id, effectiveEffort);
			}
			setOpen(false);
			return;
		}
		setSubmitting(true);
		const failureDetail = (result: AgentMessageSendResult): string =>
			(result.status === 'rejected' && result.message) || 'Claude Code が入力待ちであることを確認してください';
		const steps: ['model' | 'effort', string][] = [];
		if (modelChanged) {
			steps.push(['model', selected.id]);
		}
		if (effortChanged && effectiveEffort !== undefined) {
			steps.push(['effort', effectiveEffort]);
		}
		for (const [setting, value] of steps) {
			const result = await onClaudeSetting(setting, value).catch((): AgentMessageSendResult => ({ status: 'rejected' }));
			if (!mounted.current) {
				return;
			}
			if (result.status !== 'accepted') {
				setSubmitting(false);
				Alert.alert('設定を変更できませんでした', failureDetail(result));
				return;
			}
		}
		setSubmitting(false);
		setOpen(false);
	};

	return (
		<>
			<Pressable
				style={({ pressed }) => [styles.pill, pressed ? styles.pressed : undefined]}
				hitSlop={PILL_SLOP}
				onPress={openDrawer}
				disabled={readOnly || modelControl?.status === 'updating' || submitting}
				accessibilityRole={readOnly ? 'text' : 'button'}
				accessibilityLabel={readOnly ? `モデルと effort は ${label}。PC のターミナルの /model で変更します` : `モデルと effort を変更。いまは ${label}`}
			>
				<Text style={styles.pillText} numberOfLines={1}>{label}</Text>
				{readOnly ? null : <Icon icon={ChevronDown} size={iconSize.xs} color={colors.textDim} />}
			</Pressable>
			<BottomDrawer visible={open} onClose={close} accessibilityLabel={page === 'visibility' ? '表示するモデル' : 'モデルを選ぶ'}>
				{page === 'visibility' ? (
					<View style={styles.head}>
						<Pressable onPress={() => switchPage('pick')} hitSlop={hitSlopToMinimum(NAV_SIZE, NAV_SIZE)} style={styles.nav} accessibilityRole="button" accessibilityLabel="モデルを選ぶに戻る">
							<Icon icon={ChevronLeft} size={iconSize.lg} color={colors.textDim} strokeWidth={2.2} />
						</Pressable>
						<Text ref={headingRef} style={styles.headTitle} accessibilityRole="header">表示するモデル</Text>
						<View style={styles.nav} />
					</View>
				) : (
					<View style={styles.head}>
						<Pressable onPress={close} hitSlop={hitSlopToMinimum(NAV_SIZE, NAV_SIZE)} style={styles.nav} accessibilityRole="button" accessibilityLabel="閉じる">
							<Icon icon={X} size={iconSize.lg} color={colors.textDim} strokeWidth={2.2} />
						</Pressable>
						<Text ref={headingRef} style={styles.headTitle} accessibilityRole="header">モデルを選ぶ</Text>
						{visibilityAgent !== undefined ? (
							<Pressable
								onPress={() => switchPage('visibility')}
								disabled={submitting}
								hitSlop={hitSlopToMinimum(NAV_SIZE, NAV_SIZE)}
								style={({ pressed }) => [styles.nav, pressed ? styles.pressed : undefined]}
								accessibilityRole="button"
								accessibilityLabel="表示するモデルを選ぶ"
							>
								<Icon icon={Settings} size={iconSize.lg} color={colors.textDim} strokeWidth={2.2} />
							</Pressable>
						) : <View style={styles.nav} />}
					</View>
				)}
				{agent === 'codex' && modelControl?.status === 'loading' ? (
					<View style={styles.notice}><ActivityIndicator size="small" color={colors.textDim} /><Text style={styles.hint}>Codex からモデルの一覧を取得しています…</Text></View>
				) : null}
				{agent === 'codex' && modelControl?.status === 'error' ? (
					<View style={styles.notice}>
						<Text style={styles.error}>{modelControl.errorMessage ?? 'モデルの一覧を取得できませんでした'}</Text>
						<Button label="再試行" variant="ghost" size="sm" onPress={onRequestCodexCatalog} />
					</View>
				) : null}
				{options.length === 0 && modelControl?.status !== 'loading' ? (
					<Text style={styles.hint}>エージェントのセッションが特定されるとモデルを選べます</Text>
				) : null}
				{page === 'visibility' ? (
					<>
						{options.length > 0 ? (
							<>
								<Text style={[styles.section, styles.sectionFirst]}>{visibilityAgent !== undefined ? AGENT_NAMES[visibilityAgent] : ''}</Text>
								<View style={styles.group}>
									{options.map((option, index) => {
										const shown = !hiddenIds.includes(option.id);
										// 表示中で隠せないもの（表示中が 1 つだけ）は、そのスイッチを切れない
										const lastOne = shown && !canHideModel(options, hiddenIds, option.id);
										const hint = currentModel?.id === option.id
											? (shown ? '使用中' : '使用中のあいだはモデルを選ぶ画面に出ます')
											: lastOne ? '1 つは表示が必要です' : option.isDefault === true ? '既定' : undefined;
										return (
											<View key={option.id} style={[styles.row, index > 0 ? styles.rowDivider : undefined]}>
												{/* 読み上げはスイッチ 1 つにまとめる（名前はラベル、補足はヒント） */}
												<View style={styles.rowBody} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
													<Text style={styles.rowLabel}>{option.label}</Text>
													{hint !== undefined ? <Text style={styles.rowHint}>{hint}</Text> : null}
												</View>
												<SettingsSwitch
													value={shown}
													disabled={lastOne}
													accessibilityHint={hint}
													onValueChange={value => {
														if (visibilityAgent !== undefined && (value || canHideModel(options, hiddenIds, option.id))) {
															setModelHidden(visibilityAgent, option.id, !value);
														}
													}}
													accessibilityLabel={`${option.label} を一覧に出す`}
												/>
											</View>
										);
									})}
								</View>
							</>
						) : null}
						<Text style={styles.hint}>オフにしたモデルは「モデルを選ぶ」に出ません。この端末の設定で、どの PC につないでも同じです。PC に新しいモデルが増えたときは表示されます。</Text>
						<Button label="完了" onPress={() => switchPage('pick')} style={styles.apply} />
					</>
				) : (
					<>
						{options.length > 0 ? (
							<View style={styles.group}>
								{choices.map(({ option, hidden }, index) => {
									const isSelected = selected?.id === option.id;
									return (
										<Pressable
											key={option.id}
											disabled={locked}
											onPress={() => { haptic('tick'); setPickedModelId(option.id); }}
											style={({ pressed }) => [styles.row, index > 0 ? styles.rowDivider : undefined, pressed ? styles.rowPressed : undefined]}
											accessibilityRole="button"
											accessibilityState={{ selected: isSelected, disabled: locked }}
										>
											<View style={styles.rowBody}>
												<Text style={[styles.rowLabel, hidden ? styles.rowLabelHidden : undefined]}>{option.label}</Text>
												{currentModel?.id === option.id
													? <Text style={styles.rowHint}>{hidden ? '使用中・非表示' : '使用中'}</Text>
													: hidden ? <Text style={styles.rowHint}>非表示</Text> : null}
											</View>
											{isSelected ? <Icon icon={Check} color={theme.accent} /> : null}
										</Pressable>
									);
								})}
							</View>
						) : null}
						{selected !== undefined && selected.efforts.length > 0 ? (
							<>
								<Text style={styles.section}>{`Effort（${selected.label}）`}</Text>
								<View style={styles.efforts}>
									{selected.efforts.map(level => {
										const on = level === effectiveEffort;
										return (
											<Pressable
												key={level}
												disabled={locked}
												onPress={() => { haptic(isMaximumEffort(level) ? 'charge' : 'tick'); setPickedEffort(level); }}
												style={[styles.effort, on ? { borderColor: theme.accent, backgroundColor: theme.accentWash } : undefined]}
												accessibilityRole="button"
												accessibilityState={{ selected: on, disabled: locked }}
											>
												<Text style={[styles.effortText, on ? styles.effortTextOn : undefined]}>{level}</Text>
											</Pressable>
										);
									})}
								</View>
							</>
						) : null}
						<Text style={styles.hint}>
							{agent === 'codex'
								? '適用すると、モデルと effort が次のターンから同時に変わります'
								: submitting ? 'Claude Code へ設定を送っています…' : '適用すると、入力待ちであることを確かめてからモデルと effort を変えます'}
						</Text>
						<Button label="適用" onPress={() => { void apply(); }} loading={submitting} disabled={locked || selected === undefined} style={styles.apply} />
					</>
				)}
			</BottomDrawer>
		</>
	);
}

const styles = StyleSheet.create({
	pill: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
		// 幅が足りないとき（右に Monitor のピルが出ているとき）は、こちらが縮んで文字を省略する。
		flexShrink: 1,
		maxWidth: 180,
		minHeight: PILL_HEIGHT,
		paddingHorizontal: space.sm,
		paddingVertical: space.xs,
		borderRadius: radius.control,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		backgroundColor: colors.raised,
	},
	pressed: {
		opacity: 0.7,
	},
	pillText: {
		flexShrink: 1,
		fontSize: type.meta,
		color: colors.text,
	},
	head: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingBottom: space.lg,
	},
	nav: {
		width: NAV_SIZE,
		height: NAV_SIZE,
		alignItems: 'center',
		justifyContent: 'center',
	},
	headTitle: {
		flex: 1,
		textAlign: 'center',
		fontSize: type.title,
		fontWeight: '700',
		color: colors.text,
	},
	group: {
		borderRadius: radius.card,
		...squircle,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		backgroundColor: colors.raised,
		overflow: 'hidden',
	},
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.md,
		minHeight: HIT_SIZE,
		paddingHorizontal: 14,
		paddingVertical: space.md,
	},
	rowDivider: {
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: colors.border,
	},
	rowPressed: {
		backgroundColor: colors.border,
	},
	rowBody: {
		flex: 1,
		minWidth: 0,
	},
	rowLabel: {
		fontSize: type.body,
		fontWeight: '500',
		color: colors.text,
	},
	rowLabelHidden: {
		color: colors.textDim,
	},
	rowHint: {
		marginTop: 2,
		fontSize: type.meta,
		color: colors.textMuted,
	},
	section: {
		marginTop: space.lg,
		marginBottom: space.sm,
		paddingHorizontal: space.xs,
		fontSize: type.caption,
		fontWeight: '600',
		color: colors.textMuted,
	},
	sectionFirst: {
		marginTop: 0,
	},
	efforts: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: space.sm,
	},
	effort: {
		minHeight: HIT_SIZE,
		minWidth: HIT_SIZE,
		justifyContent: 'center',
		alignItems: 'center',
		paddingHorizontal: space.md,
		borderRadius: radius.control,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		backgroundColor: colors.raised,
	},
	effortText: {
		fontSize: type.body,
		color: colors.textDim,
	},
	effortTextOn: {
		color: colors.text,
		fontWeight: '600',
	},
	notice: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingBottom: space.md,
	},
	hint: {
		marginTop: space.md,
		paddingHorizontal: space.xs,
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.textMuted,
	},
	error: {
		flex: 1,
		fontSize: type.meta,
		color: colors.red,
	},
	apply: {
		marginTop: space.lg,
	},
});
