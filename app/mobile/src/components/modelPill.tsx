// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet } from './bottomSheet.js';
import { agentModelOptions, matchAgentModel } from '../agentModels.js';
import { colors } from '../theme.js';

/**
 * エージェントコンポーザーのモデル/Effortピル（mo.html 案A2）。セッションの現在値を
 * 表示し、タップで変更シートを開く。シートは上段でモデルを選択式で選び、下段には
 * 選択中モデルが対応する effort だけを出す（対応表: agentModels.ts）。
 * 変更はPTYへのスラッシュコマンド注入（`/model <id>` / `/effort <level>`）で行う
 * （専用APIは無い。useAgentActions.sendText経由）。
 */
export function ModelPill({ agent, model, effort, onCommand }: {
	/** 'claude' | 'codex'（セッション未特定時は undefined）。 */
	agent: string | undefined;
	model: string | undefined;
	effort: string | undefined;
	/** スラッシュコマンドをエージェントのPTYへ送る（sendText: テキスト+250ms後CR）。 */
	onCommand: (command: string) => void;
}) {
	const [open, setOpen] = useState(false);
	// シート内で選択したモデル（未選択時はセッションの現在モデルから推定）
	const [pickedModelId, setPickedModelId] = useState<string | undefined>(undefined);

	const options = agentModelOptions(agent);
	const currentModel = matchAgentModel(agent, model);
	const selected = (pickedModelId !== undefined ? options.find(o => o.id === pickedModelId) : undefined) ?? currentModel;

	const label = [currentModel?.label ?? model, effort].filter(Boolean).join(' · ') || 'model / effort';

	const applyModel = (id: string) => {
		setPickedModelId(id);
		onCommand(`/model ${id}`);
	};
	const applyEffort = (level: string) => {
		onCommand(`/effort ${level}`);
		setOpen(false);
	};

	return (
		<>
			<Pressable style={styles.pill} onPress={() => { setPickedModelId(undefined); setOpen(true); }} accessibilityLabel="モデルとeffortを変更">
				<Ionicons name="hardware-chip-outline" size={12} color={colors.textDim} />
				<Text style={styles.pillText} numberOfLines={1}>{label}</Text>
			</Pressable>

			<BottomSheet visible={open} onClose={() => setOpen(false)} title="モデルと Effort">
				<ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
					<Text style={styles.sectionLabel}>モデル</Text>
					{options.length === 0 ? (
						<Text style={styles.hint}>エージェントのセッションが特定されるとモデルを選択できます</Text>
					) : options.map(option => {
						const isCurrent = currentModel?.id === option.id;
						const isSelected = selected?.id === option.id;
						return (
							<Pressable
								key={option.id}
								style={[styles.modelRow, isSelected && styles.modelRowActive]}
								onPress={() => applyModel(option.id)}
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
									>
										<Text style={[styles.effortText, effort === level && styles.effortTextActive]}>{level}</Text>
									</Pressable>
								))}
							</View>
						</>
					) : null}
					<Text style={styles.hint}>変更はエージェントのTUIへ /model・/effort コマンドとして送られます</Text>
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
