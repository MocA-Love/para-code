// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { paraAlert } from '../paraAlert.js';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet } from './bottomSheet.js';
import { EffortSlider } from './effortSlider.js';
import { claudeModelDisplayName, matchAgentModel } from '../agentModels.js';
import { useClaudeModelOptions } from '../hooks/useClaudeModelOptions.js';
import { HIT_SIZE, alpha, colors, radius, squircle, tint, type } from '../theme.js';
import { hitSlopToMinimum } from './hitSlop.js';
import { monoFamily } from '../monoFont.js';
import { haptic } from '../haptics.js';
import type { AgentMessageSendResult, AgentModelControlState } from '../store.js';

/**
 * エージェントコンポーザーのモデル/Effortピル（mo.html 案A2）。セッションの現在値を
 * 表示し、タップで変更シートを開く。シートは上段でモデルを選択式で選び、下段には
 * Claudeは従来どおり静的対応表+PTYコマンド、Codexはapp-serverのmodel/listを正本にし、
 * modelとeffortをthread/settings/updateで原子的に変更する。
 */
export function ModelPill({ agent, model, effort, modelControl, onClaudeSetting, onRequestCodexCatalog, onUpdateCodexSettings }: {
	/** 'claude' | 'codex'（セッション未特定時は undefined）。 */
	agent: string | undefined;
	model: string | undefined;
	effort: string | undefined;
	modelControl: AgentModelControlState | undefined;
	onClaudeSetting: (setting: 'model' | 'effort', value: string) => Promise<AgentMessageSendResult>;
	onRequestCodexCatalog: () => void;
	onUpdateCodexSettings: (model: string, effort: string) => void;
}) {
	const [open, setOpen] = useState(false);
	// シート内での仮選択（未選択時はセッションの現在値から推定）。確定操作までは送信しない。
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
				paraAlert.alert('設定を変更できませんでした', modelControl.errorMessage ?? 'Codexから設定変更を確認できませんでした');
			}
		}
	}, [codexUpdatePending, modelControl?.errorMessage, modelControl?.status, open]);

	const claudeCatalog = useClaudeModelOptions(agent);
	const codexModels = modelControl?.models ?? [];
	const agentAccent = agent === 'claude' ? colors.claude : colors.accent;
	const agentAccentWash = agent === 'claude' ? tint(colors.claude, alpha.wash) : colors.accentWash;
	const options = agent === 'codex'
		? codexModels.map(option => ({
			id: option.model,
			label: option.displayName,
			aliases: option.id === option.model ? [] : [option.id],
			efforts: option.efforts.map(item => item.value),
		}))
		: claudeCatalog.options;
	const currentModel = agent === 'codex'
		? options.find(option => option.id === model || option.aliases.includes(model ?? ''))
		: matchAgentModel(agent, model, options);
	const defaultCodexModel = agent === 'codex' ? codexModels.find(option => option.isDefault)?.model : undefined;
	const selected = (pickedModelId !== undefined ? options.find(option => option.id === pickedModelId) : undefined)
		?? currentModel
		?? (defaultCodexModel !== undefined ? options.find(option => option.id === defaultCodexModel) : undefined);
	// 仮選択されたeffortがselectedのモデルで提供されていない場合（モデル変更でeffort候補が変わった場合）は先頭にフォールバックする。
	const candidateEffort = pickedEffort ?? effort;
	const effectiveEffort = selected !== undefined && candidateEffort !== undefined && !selected.efforts.includes(candidateEffort)
		? selected.efforts[0]
		: candidateEffort;

	const modelName = currentModel?.label ?? (agent === 'claude' && model !== undefined ? claudeModelDisplayName(model) : undefined) ?? model;
	// effort 非対応のモデル（Haiku）では、前のモデルの effort が残っていても出さない
	const shownEffort = currentModel !== undefined && currentModel.efforts.length === 0 ? undefined : effort;
	const label = [modelName, shownEffort].filter(Boolean).join(' · ') || 'model / effort';

	const applyModel = (id: string) => {
		haptic('tick');
		setPickedModelId(id);
	};
	const applyEffort = (level: string) => {
		setPickedEffort(level);
	};
	const openSheet = () => {
		haptic('move');
		setPickedModelId(undefined);
		setPickedEffort(undefined);
		setOpen(true);
		if (agent === 'codex') {
			onRequestCodexCatalog();
		} else {
			claudeCatalog.request();
		}
	};
	const cancelSheet = () => {
		if (submitting) { return; }
		setOpen(false);
	};
	const confirmSheet = async () => {
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
			if (effectiveEffort === undefined) {
				setOpen(false);
				return;
			}
			setCodexUpdatePending(true);
			onUpdateCodexSettings(selected.id, effectiveEffort);
			setOpen(false);
			return;
		}
		setSubmitting(true);
		// 失敗理由はPC側が返した内容をそのまま出す（固定文言だと、接続断・回答待ち・
		// セッション未対応のどれで失敗したのか切り分けられない）。
		const failureDetail = (result: AgentMessageSendResult): string =>
			(result.status === 'rejected' && result.message) || 'Claude Codeが入力待ちであることを確認してください';
		if (modelChanged) {
			const result = await onClaudeSetting('model', selected.id)
				.catch((): AgentMessageSendResult => ({ status: 'rejected' }));
			if (!mounted.current) { return; }
			if (result.status !== 'accepted') {
				setSubmitting(false);
				paraAlert.alert('設定を変更できませんでした', failureDetail(result));
				return;
			}
		}
		if (effortChanged && effectiveEffort !== undefined) {
			const result = await onClaudeSetting('effort', effectiveEffort)
				.catch((): AgentMessageSendResult => ({ status: 'rejected' }));
			if (!mounted.current) { return; }
			if (result.status !== 'accepted') {
				setSubmitting(false);
				paraAlert.alert('設定を変更できませんでした', failureDetail(result));
				return;
			}
		}
		setSubmitting(false);
		setOpen(false);
	};
	// 更新中だけでなく、カタログ取得中・失敗時の古い一覧も操作不能にする。
	// model/listで検証済みのready状態だけを設定変更の入力として受け付ける。
	const isCodexBusy = agent === 'codex' && modelControl?.status !== 'ready';
	const isCodexUpdating = agent === 'codex' && modelControl?.status === 'updating';

	return (
		<>
			<Pressable
				style={styles.pill}
				// 見た目はコンポーザーの行に収まる高さのまま、当たり判定だけ 44pt へ広げる。
				hitSlop={PILL_HIT_SLOP}
				onPress={openSheet}
				disabled={modelControl?.status === 'updating' || submitting}
				accessibilityRole="button"
				accessibilityState={{ disabled: modelControl?.status === 'updating' || submitting }}
				accessibilityLabel="モデルとeffortを変更"
			>
				<Ionicons name="hardware-chip-outline" size={12} color={colors.textDim} />
				<Text style={styles.pillText} numberOfLines={1}>{label}</Text>
			</Pressable>

			<BottomSheet
				visible={open}
				onClose={cancelSheet}
				onConfirm={() => { void confirmSheet(); }}
				title="モデルと Effort"
				glass
			>
				<ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
					<Text style={styles.sectionLabel}>モデル</Text>
					{agent === 'codex' && modelControl?.status === 'loading' ? (
						<View style={styles.loadingRow}><ActivityIndicator size="small" color={colors.accent} /><Text style={styles.hint}>Codexからモデル一覧を取得中…</Text></View>
					) : null}
					{agent === 'codex' && modelControl?.status === 'error' ? (
						<View style={styles.errorBox}>
							<Text style={styles.errorText}>{modelControl.errorMessage ?? 'モデル一覧を取得できませんでした'}</Text>
							<Pressable style={styles.retryBtn} onPress={onRequestCodexCatalog} accessibilityRole="button"><Text style={styles.retryText}>再試行</Text></Pressable>
						</View>
					) : null}
					{options.length === 0 && modelControl?.status !== 'loading' ? (
						<Text style={styles.hint}>エージェントのセッションが特定されるとモデルを選択できます</Text>
					) : options.map(option => {
						const isCurrent = currentModel?.id === option.id;
						const isSelected = selected?.id === option.id;
						return (
							<Pressable
								key={option.id}
								style={[styles.modelRow, isSelected && { backgroundColor: agentAccentWash, borderColor: agentAccent }]}
								onPress={() => applyModel(option.id)}
								disabled={isCodexBusy || submitting}
								accessibilityRole="button"
								accessibilityState={{ selected: isSelected, disabled: isCodexBusy || submitting }}
							>
								<View style={styles.modelBody}>
									<Text style={[styles.modelLabel, isSelected && styles.modelLabelActive]}>{option.label}</Text>
								</View>
								{isCurrent ? <Text style={[styles.currentTag, { color: agentAccent, backgroundColor: agentAccentWash }]}>使用中</Text> : null}
								{isSelected ? <Ionicons name="checkmark" size={16} color={agentAccent} /> : null}
							</Pressable>
						);
					})}

					{selected !== undefined && selected.efforts.length > 0 ? (
						<>
							<Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Effort（{selected.label}）</Text>
							<EffortSlider
								efforts={selected.efforts}
								value={effectiveEffort}
								disabled={isCodexBusy || submitting}
								accentColor={agentAccent}
								onChange={applyEffort}
							/>
						</>
					) : null}
					{agent === 'codex'
						? <Text style={styles.hint}>{isCodexUpdating ? 'Codexへ設定を適用中…' : '右上の✓で確定すると、モデルとEffortが次のターンへ同時に適用されます'}</Text>
						: <Text style={styles.hint}>{submitting ? 'Claude Codeへ設定を適用中…' : '右上の✓で確定すると、入力待ち状態を確認してモデル・Effortを変更します'}</Text>}
				</ScrollView>
			</BottomSheet>
		</>
	);
}

/** コンポーザーのピル（モデル・PR）の見た目の高さ。当たり判定は hitSlop で 44pt にする。 */
export const PILL_HEIGHT = 36;
const PILL_HIT_SLOP = hitSlopToMinimum(PILL_HEIGHT);

const styles = StyleSheet.create({
	// コンポーザー自体がGlassSurfaceなので、ここでネイティブglassを重ねない。
	pill: {
		flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: 190,
		backgroundColor: 'rgba(255,255,255,.06)', borderWidth: 1, borderColor: colors.glassBorder,
		borderRadius: radius.pill, ...squircle, paddingVertical: 9, paddingHorizontal: 13, minHeight: PILL_HEIGHT,
	},
	pillText: { color: colors.text, fontSize: type.meta, fontWeight: '600', fontFamily: monoFamily, flexShrink: 1 },
	body: { paddingHorizontal: 20 },
	bodyContent: { paddingBottom: 40 },
	loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10 },
	errorBox: { borderWidth: 1, borderColor: colors.red, borderRadius: radius.control, ...squircle, padding: 12, gap: 8, marginBottom: 10 },
	errorText: { color: colors.text, fontSize: type.meta, lineHeight: 18 },
	retryBtn: { minHeight: HIT_SIZE, justifyContent: 'center', alignSelf: 'flex-start' },
	retryText: { color: colors.accent, fontSize: type.meta, fontWeight: '700' },
	sectionLabel: { color: colors.textDim, fontSize: type.badge, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginTop: 4 },
	sectionLabelGap: { marginTop: 16 },
	modelRow: {
		flexDirection: 'row', alignItems: 'center', gap: 10,
		backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border,
		borderRadius: radius.card, ...squircle, paddingVertical: 11, paddingHorizontal: 13, marginBottom: 7,
	},
	modelBody: { flex: 1, minWidth: 0 },
	modelLabel: { color: colors.textDim, fontSize: type.body, fontWeight: '700' },
	modelLabelActive: { color: colors.text },
	currentTag: { color: colors.accent, fontSize: type.badge, fontWeight: '700', backgroundColor: colors.accentWash, borderRadius: radius.key, paddingHorizontal: 7, paddingVertical: 2, overflow: 'hidden' },
	hint: { color: colors.textDim, fontSize: type.badge, lineHeight: 15, marginTop: 4 },
});
