// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Check, ChevronDown, X } from 'lucide-react-native';
import { agentModelOptions, matchAgentModel } from '../../agentModels.js';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import { hapticSelection } from '../../haptics.js';
import type { AgentMessageSendResult, AgentModelControlState } from '../../store.js';
import { HIT_SIZE, colors, radius, space, squircle, type } from '../../theme.js';
import { BottomDrawer, Button, Icon, iconSize } from '../../ui/index.js';

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
}

/**
 * コンポーザーのモデルと effort のピル（モックの `.pill`）と、押すと開く「モデルを選ぶ」のシート。
 *
 * 送り方は旧部品（`components/modelPill.tsx`）と同じ:
 *  - Claude: 既存の対応表から選び、確定したら `onClaudeSetting('model' | 'effort', …)` を順に送る
 *    （入力待ちでなければ PC が拒否する。理由はそのまま出す）
 *  - Codex: PC から届くモデルの一覧（model/list）を正本にし、確定したら model と effort を一度に送る
 * シートの中の選択は仮のもので、「適用」を押すまで何も送らない。
 */
export function ModelPill({ agent, model, effort, modelControl, onClaudeSetting, onRequestCodexCatalog, onUpdateCodexSettings }: {
	agent: string | undefined;
	model: string | undefined;
	effort: string | undefined;
	modelControl: AgentModelControlState | undefined;
	onClaudeSetting: (setting: 'model' | 'effort', value: string) => Promise<AgentMessageSendResult>;
	onRequestCodexCatalog: () => void;
	onUpdateCodexSettings: (model: string, effort: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [pickedModelId, setPickedModelId] = useState<string | undefined>(undefined);
	const [pickedEffort, setPickedEffort] = useState<string | undefined>(undefined);
	const [codexUpdatePending, setCodexUpdatePending] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; };
	}, []);
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

	const codexModels = modelControl?.models ?? [];
	const options: readonly ModelOption[] = agent === 'codex'
		? codexModels.map(option => ({
			id: option.model,
			label: option.displayName,
			aliases: option.id === option.model ? [] : [option.id],
			efforts: option.efforts.map(item => item.value),
		}))
		: agentModelOptions(agent);
	const currentModel = agent === 'codex'
		? options.find(option => option.id === model || option.aliases.includes(model ?? ''))
		: matchAgentModel(agent, model);
	const defaultCodexModel = agent === 'codex' ? codexModels.find(option => option.isDefault)?.model : undefined;
	const selected = (pickedModelId !== undefined ? options.find(option => option.id === pickedModelId) : undefined)
		?? currentModel
		?? (defaultCodexModel !== undefined ? options.find(option => option.id === defaultCodexModel) : undefined);
	const candidateEffort = pickedEffort ?? effort;
	const effectiveEffort = selected !== undefined && candidateEffort !== undefined && !selected.efforts.includes(candidateEffort)
		? selected.efforts[0]
		: candidateEffort;
	const label = [currentModel?.label ?? model, effort].filter(Boolean).join(' · ') || 'モデル';
	const isCodexBusy = agent === 'codex' && modelControl?.status !== 'ready';
	const locked = isCodexBusy || submitting;

	const openDrawer = () => {
		hapticSelection();
		setPickedModelId(undefined);
		setPickedEffort(undefined);
		setOpen(true);
		if (agent === 'codex') {
			onRequestCodexCatalog();
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
				disabled={modelControl?.status === 'updating' || submitting}
				accessibilityRole="button"
				accessibilityLabel={`モデルと effort を変更。いまは ${label}`}
			>
				<Text style={styles.pillText} numberOfLines={1}>{label}</Text>
				<Icon icon={ChevronDown} size={iconSize.xs} color={colors.textDim} />
			</Pressable>
			<BottomDrawer visible={open} onClose={close} accessibilityLabel="モデルを選ぶ">
				<View style={styles.head}>
					<Pressable onPress={close} hitSlop={hitSlopToMinimum(NAV_SIZE, NAV_SIZE)} style={styles.nav} accessibilityRole="button" accessibilityLabel="閉じる">
						<Icon icon={X} size={iconSize.lg} color={colors.textDim} strokeWidth={2.2} />
					</Pressable>
					<Text style={styles.headTitle} accessibilityRole="header">モデルを選ぶ</Text>
					<View style={styles.nav} />
				</View>
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
				) : (
					<View style={styles.group}>
						{options.map((option, index) => {
							const isSelected = selected?.id === option.id;
							return (
								<Pressable
									key={option.id}
									disabled={locked}
									onPress={() => { hapticSelection(); setPickedModelId(option.id); }}
									style={({ pressed }) => [styles.row, index > 0 ? styles.rowDivider : undefined, pressed ? styles.rowPressed : undefined]}
									accessibilityRole="button"
									accessibilityState={{ selected: isSelected, disabled: locked }}
								>
									<View style={styles.rowBody}>
										<Text style={styles.rowLabel}>{option.label}</Text>
										{currentModel?.id === option.id ? <Text style={styles.rowHint}>使用中</Text> : null}
									</View>
									{isSelected ? <Icon icon={Check} color={colors.accent} /> : null}
								</Pressable>
							);
						})}
					</View>
				)}
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
										onPress={() => { hapticSelection(); setPickedEffort(level); }}
										style={[styles.effort, on ? styles.effortOn : undefined]}
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
			</BottomDrawer>
		</>
	);
}

const styles = StyleSheet.create({
	pill: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
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
	effortOn: {
		borderColor: colors.accent,
		backgroundColor: colors.accentWash,
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
