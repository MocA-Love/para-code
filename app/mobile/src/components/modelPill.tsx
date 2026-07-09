// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet } from './bottomSheet.js';
import { agentModelOptions, matchAgentModel } from '../agentModels.js';
import { colors } from '../theme.js';
import { hapticSelection } from '../haptics.js';
import type { AgentModelControlState } from '../store.js';

/**
 * エージェントコンポーザーのモデル/Effortピル（mo.html 案A2）。セッションの現在値を
 * 表示し、タップで変更シートを開く。シートは上段でモデルを選択式で選び、下段には
 * Claudeは従来どおり静的対応表+PTYコマンド、Codexはapp-serverのmodel/listを正本にし、
 * modelとeffortをthread/settings/updateで原子的に変更する。
 */
export function ModelPill({ agent, model, effort, modelControl, onClaudeCommand, onRequestCodexCatalog, onUpdateCodexSettings }: {
	/** 'claude' | 'codex'（セッション未特定時は undefined）。 */
	agent: string | undefined;
	model: string | undefined;
	effort: string | undefined;
	modelControl: AgentModelControlState | undefined;
	onClaudeCommand: (command: string) => void;
	onRequestCodexCatalog: () => void;
	onUpdateCodexSettings: (model: string, effort: string) => void;
}) {
	const [open, setOpen] = useState(false);
	// シート内で選択したモデル（未選択時はセッションの現在モデルから推定）
	const [pickedModelId, setPickedModelId] = useState<string | undefined>(undefined);
	const [codexUpdatePending, setCodexUpdatePending] = useState(false);

	useEffect(() => {
		if (!codexUpdatePending) {
			return;
		}
		if (modelControl?.status === 'ready') {
			setCodexUpdatePending(false);
			setOpen(false);
		} else if (modelControl?.status === 'error') {
			setCodexUpdatePending(false);
			if (!open) {
				Alert.alert('設定を変更できませんでした', modelControl.errorMessage ?? 'Codexから設定変更を確認できませんでした');
			}
		}
	}, [codexUpdatePending, modelControl?.errorMessage, modelControl?.status, open]);

	const codexModels = modelControl?.models ?? [];
	const options = agent === 'codex'
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

	const label = [currentModel?.label ?? model, effort].filter(Boolean).join(' · ') || 'model / effort';

	const applyModel = (id: string) => {
		hapticSelection();
		setPickedModelId(id);
		if (agent !== 'codex') {
			onClaudeCommand(`/model ${id}`);
		}
	};
	const applyEffort = (level: string) => {
		hapticSelection();
		if (agent === 'codex' && selected !== undefined) {
			const apply = () => {
				setCodexUpdatePending(true);
				onUpdateCodexSettings(selected.id, level);
			};
			if (level === 'ultra') {
				Alert.alert(
					'Ultraを使用しますか？',
					'Ultraはサブエージェントを並列実行するため、通常のEffortより使用量が大きくなる可能性があります。',
					[{ text: 'キャンセル', style: 'cancel' }, { text: '使用する', onPress: apply }],
				);
			} else {
				apply();
			}
			return;
		}
		onClaudeCommand(`/effort ${level}`);
		setOpen(false);
	};
	const openSheet = () => {
		hapticSelection();
		setPickedModelId(undefined);
		setOpen(true);
		if (agent === 'codex') {
			onRequestCodexCatalog();
		}
	};
	// 更新中だけでなく、カタログ取得中・失敗時の古い一覧も操作不能にする。
	// model/listで検証済みのready状態だけを設定変更の入力として受け付ける。
	const isCodexBusy = agent === 'codex' && modelControl?.status !== 'ready';
	const isCodexUpdating = agent === 'codex' && modelControl?.status === 'updating';

	return (
		<>
			<Pressable
				style={styles.pill}
				onPress={openSheet}
				disabled={modelControl?.status === 'updating'}
				accessibilityRole="button"
				accessibilityState={{ disabled: modelControl?.status === 'updating' }}
				accessibilityLabel="モデルとeffortを変更"
			>
				<Ionicons name="hardware-chip-outline" size={12} color={colors.textDim} />
				<Text style={styles.pillText} numberOfLines={1}>{label}</Text>
			</Pressable>

			<BottomSheet visible={open} onClose={() => setOpen(false)} title="モデルと Effort">
				<ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
					<Text style={styles.sectionLabel}>モデル</Text>
					{agent === 'codex' && modelControl?.status === 'loading' ? (
						<View style={styles.loadingRow}><ActivityIndicator size="small" color={colors.accent} /><Text style={styles.hint}>Codexからモデル一覧を取得中…</Text></View>
					) : null}
					{agent === 'codex' && modelControl?.status === 'error' ? (
						<View style={styles.errorBox}>
							<Text style={styles.errorText}>{modelControl.errorMessage ?? 'モデル一覧を取得できませんでした'}</Text>
							<Pressable onPress={onRequestCodexCatalog} accessibilityRole="button"><Text style={styles.retryText}>再試行</Text></Pressable>
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
								style={[styles.modelRow, isSelected && styles.modelRowActive]}
								onPress={() => applyModel(option.id)}
								disabled={isCodexBusy}
								accessibilityRole="button"
								accessibilityState={{ selected: isSelected, disabled: isCodexBusy }}
							>
								<View style={styles.modelBody}>
									<Text style={[styles.modelLabel, isSelected && styles.modelLabelActive]}>{option.label}</Text>
									<Text style={styles.modelId}>{option.id}</Text>
								</View>
								{isCurrent ? <Text style={styles.currentTag}>使用中</Text> : null}
								{isSelected ? <Ionicons name="checkmark" size={16} color={colors.accent} /> : null}
							</Pressable>
						);
					})}

					{selected !== undefined ? (
						<>
							<Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Effort（{selected.label}）</Text>
							<View style={styles.effortRow}>
								{selected.efforts.map(level => (
									<Pressable
										key={level}
										style={[styles.effortBtn, effort === level && styles.effortBtnActive]}
									onPress={() => applyEffort(level)}
									disabled={isCodexBusy}
									accessibilityRole="button"
									accessibilityState={{ selected: effort === level, disabled: isCodexBusy }}
									>
										<Text style={[styles.effortText, effort === level && styles.effortTextActive]}>{level}</Text>
									</Pressable>
								))}
							</View>
						</>
					) : null}
					{agent === 'codex'
						? <Text style={styles.hint}>{isCodexUpdating ? 'Codexへ設定を適用中…' : 'Effortを選ぶと、モデルとEffortが次のターンへ同時に適用されます'}</Text>
						: <Text style={styles.hint}>変更はClaude CodeのTUIへ /model・/effort コマンドとして送られます</Text>}
				</ScrollView>
			</BottomSheet>
		</>
	);
}

const styles = StyleSheet.create({
	pill: {
		flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: 190,
		backgroundColor: colors.surface3, borderWidth: 1, borderColor: colors.border,
		borderRadius: 999, paddingVertical: 9, paddingHorizontal: 13,
	},
	pillText: { color: colors.text, fontSize: 11.5, fontWeight: '600', fontFamily: 'Menlo', flexShrink: 1 },
	body: { paddingHorizontal: 20 },
	bodyContent: { paddingBottom: 40 },
	loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10 },
	errorBox: { borderWidth: 1, borderColor: colors.red, borderRadius: 8, padding: 12, gap: 8, marginBottom: 10 },
	errorText: { color: colors.text, fontSize: 11.5, lineHeight: 17 },
	retryText: { color: colors.accent, fontSize: 12, fontWeight: '700' },
	sectionLabel: { color: colors.textDim, fontSize: 10.5, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginTop: 4 },
	sectionLabelGap: { marginTop: 16 },
	modelRow: {
		flexDirection: 'row', alignItems: 'center', gap: 10,
		backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border,
		borderRadius: 13, paddingVertical: 11, paddingHorizontal: 13, marginBottom: 7,
	},
	modelRowActive: { backgroundColor: colors.accentWash, borderColor: colors.accent },
	modelBody: { flex: 1, minWidth: 0 },
	modelLabel: { color: colors.textDim, fontSize: 13.5, fontWeight: '700' },
	modelLabelActive: { color: colors.text },
	modelId: { color: colors.textDim, fontSize: 10.5, fontFamily: 'Menlo', marginTop: 1 },
	currentTag: { color: colors.accent, fontSize: 10, fontWeight: '700', backgroundColor: colors.accentWash, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2, overflow: 'hidden' },
	effortRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
	effortBtn: { minWidth: 76, alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border },
	effortBtnActive: { backgroundColor: colors.accentWash, borderColor: colors.accent },
	effortText: { color: colors.textDim, fontSize: 12.5, fontWeight: '600', fontFamily: 'Menlo' },
	effortTextActive: { color: colors.text },
	hint: { color: colors.textDim, fontSize: 10.5, lineHeight: 15, marginTop: 4 },
});
