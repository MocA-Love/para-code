// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { BottomSheet, useSheetCloseThen } from './bottomSheet.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import { presetApprovalKey, presetCommandSummary, presetIonicon, presetTerminalCount, visiblePresets } from '../presets.js';
import { runPresetInBackground } from '../presetLaunch.js';
import { colors, mono, radius, squircle } from '../theme.js';
import { hapticImpact, hapticSelection } from '../haptics.js';
import type { PresetDef } from '../store.js';

/**
 * コマンドプリセットの一覧シート（ターミナル画面のヘッダーの雷から開く）。
 *
 * PC版のターミナルタブバー右のボタンと同じ定義を、そのスペースぶんだけ並べる。中身の編集は
 * できない——プリセットの定義はPC（設定 / .paracode.json）が持ち、この端末が決めるのは
 * 「どれを出すか」だけ（設定 →「コマンドプリセット」）。
 *
 * **押す前に何が走るかを見せる。** 手元を離れたPCへコマンドを流す操作なので、初めての
 * プリセット（とコマンドが書き換わったプリセット）は、実行の前に全文を出して確認を取る。
 * 一度通したものは次から1タップで走る（PC側の autoRun と同じ流儀）。
 */
export function PresetSheet({ visible, ws, wsLabel, onClose }: {
	visible: boolean;
	/** 実行先のスペース（ワークスペースID）。 */
	ws: string | undefined;
	/** 見出しに出す実行先の名前。 */
	wsLabel: string;
	onClose: () => void;
}) {
	const router = useRouter();
	const insets = useStableInsets();
	// 「表示する項目を選ぶ…」は設定画面への遷移を伴う。シートの暗幕が閉じアニメのあいだ
	// 残るため、閉じ切ってから遷移しないと遷移先の最初のタップが吸われる。
	const closeThen = useSheetCloseThen(onClose);
	const { presetList, hiddenKeys, approvedKeys, approvePreset } = useAppStore(useShallow(s => ({
		presetList: s.presetList,
		hiddenKeys: s.presetHiddenKeys,
		approvedKeys: s.presetApprovedSignatures,
		approvePreset: s.approvePreset,
	})));
	const [presets, setPresets] = useState<PresetDef[] | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	// 確認待ちのプリセット。ここに入っている間はシートが確認の面に切り替わる。
	const [confirming, setConfirming] = useState<PresetDef | undefined>(undefined);

	// 開くたびに取り直す。PCで定義を書き換えた直後でも、開き直せば追いつく。
	useEffect(() => {
		if (!visible || ws === undefined) {
			return;
		}
		let cancelled = false;
		setError(undefined);
		setConfirming(undefined);
		// 前に開いたスペースの一覧を残さない。ユーザースコープのプリセットは別スペースでも
		// 実在するので、取得を待つ間に押せると「今いるスペースとは違う場所」で走ってしまう。
		setPresets(undefined);
		presetList(ws).then(result => {
			if (!cancelled) {
				setPresets(result.presets);
			}
		}).catch((e: unknown) => {
			if (!cancelled) {
				setPresets([]);
				setError(String(e instanceof Error ? e.message : e));
			}
		});
		return () => { cancelled = true; };
	}, [visible, ws, presetList]);

	const rows = useMemo(() => visiblePresets(presets ?? [], hiddenKeys), [presets, hiddenKeys]);

	const run = useCallback((preset: PresetDef) => {
		if (ws === undefined) {
			return;
		}
		hapticImpact('medium');
		runPresetInBackground({ ws, wsLabel, preset });
		onClose();
	}, [ws, wsLabel, onClose]);

	const press = useCallback((preset: PresetDef) => {
		if (approvedKeys.has(presetApprovalKey(preset))) {
			run(preset);
			return;
		}
		hapticSelection();
		setConfirming(preset);
	}, [approvedKeys, run]);

	const confirm = useCallback(() => {
		if (confirming === undefined) {
			return;
		}
		approvePreset(presetApprovalKey(confirming));
		run(confirming);
	}, [confirming, approvePreset, run]);

	if (confirming !== undefined) {
		return (
			// 下スワイプ・背景タップは**シートごと閉じる**。ここで一覧へ戻すだけにすると
			// `visible` が変わらないため、引き下げた位置から戻すばねが走らず、シートが
			// 途中で止まったまま固まる。一覧へ戻る道は下の「戻る」が持つ。
			<BottomSheet visible={visible} onClose={() => { setConfirming(undefined); onClose(); }} title={confirming.name} glass>
				<ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 20 }]}>
					{confirming.qualifier ? (
						// 同名のプリセットが並んでいる場合、名前だけでは「どちらを押したか」が
						// 確認の面でも分からない。一覧と同じ区別語をここにも出す。
						<View style={styles.confirmQualifierLine}>
							<Text style={styles.confirmName} numberOfLines={1}>{confirming.name}</Text>
							<Text style={styles.tag}>{confirming.qualifier}</Text>
						</View>
					) : null}
					<Text style={styles.confirmLead}>
						{wsLabel} で{presetTerminalCount(confirming) > 1 ? `${presetTerminalCount(confirming)}つのターミナルを作成して` : '新しいターミナルを作成して'}実行します。
					</Text>
					{confirming.tasks.map((task, index) => (
						<View key={index} style={styles.taskCard}>
							<Text style={styles.taskName}>{task.name ?? `${confirming.name}${confirming.tasks.length > 1 ? ` ${index + 1}` : ''}`}</Text>
							{task.commands.map((command, commandIndex) => (
								<Text key={commandIndex} style={styles.taskCommand}>{command}</Text>
							))}
						</View>
					))}
					{confirming.truncated ? (
						<Text style={styles.warn}>
							コマンドが長い、または数が多いため、ここに出しているのは一部です。実行されるのはPCにある定義の全部です。
						</Text>
					) : null}
					<Text style={styles.note}>
						このプリセットの確認はこれが最初の1回だけです。次からは押すとすぐ実行します（PC側でコマンドや作業ディレクトリが書き換わったら、もう一度ここに戻ります）。
					</Text>
					<Pressable style={({ pressed }) => [styles.cta, pressed && styles.ctaPressed]} onPress={confirm} accessibilityRole="button">
						<Ionicons name="flash" size={17} color="#04222b" />
						<Text style={styles.ctaText}>実行</Text>
					</Pressable>
					<Pressable style={styles.secondary} onPress={() => setConfirming(undefined)} accessibilityRole="button">
						<Text style={styles.secondaryText}>戻る</Text>
					</Pressable>
				</ScrollView>
			</BottomSheet>
		);
	}

	return (
		<BottomSheet visible={visible} onClose={onClose} title="コマンドプリセット" glass>
			<ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 20 }]}>
				<Text style={styles.lead}>{wsLabel} で使えるもの</Text>
				{presets === undefined ? (
					<View style={styles.center}><ActivityIndicator color={colors.accent} /></View>
				) : rows.length === 0 ? (
					<View style={styles.empty}>
						<Ionicons name="flash-outline" size={26} color={colors.textDim} />
						<Text style={styles.emptyText}>
							{error !== undefined
								? `一覧を取得できませんでした（${error}）`
								: (presets.length > 0
									? 'すべて非表示にしています。設定 →「コマンドプリセット」で戻せます'
									: 'このスペースで使えるプリセットはまだありません。PCの設定、またはリポジトリの .paracode.json で作れます')}
						</Text>
					</View>
				) : (
					<View style={styles.group}>
						{rows.map((preset, index) => (
							<PresetRow key={preset.key} preset={preset} first={index === 0} onPress={() => press(preset)} />
						))}
					</View>
				)}
				<Pressable
					style={styles.secondary}
					onPress={() => closeThen(() => router.push('/presets'))}
					accessibilityRole="button"
				>
					<Text style={styles.secondaryText}>表示する項目を選ぶ…</Text>
				</Pressable>
			</ScrollView>
		</BottomSheet>
	);
}

function PresetRow({ preset, first, onPress }: { preset: PresetDef; first: boolean; onPress: () => void }) {
	const count = presetTerminalCount(preset);
	return (
		<Pressable
			style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={preset.name}
			accessibilityHint={presetCommandSummary(preset)}
		>
			{first ? null : <View style={styles.rowDivider} pointerEvents="none" />}
			<View style={styles.rowIcon}>
				<Ionicons name={presetIonicon(preset.icon) as keyof typeof Ionicons.glyphMap} size={17} color={colors.accent} />
			</View>
			<View style={styles.rowBody}>
				<View style={styles.rowTitleLine}>
					<Text style={styles.rowTitle} numberOfLines={1}>{preset.name}</Text>
					{preset.qualifier ? <Text style={[styles.tag, styles.tagQualifier]} numberOfLines={1}>{preset.qualifier}</Text> : null}
					<Text style={styles.tag}>{preset.source === 'workspace' ? 'リポジトリ' : 'ユーザー'}</Text>
					{count > 1 ? <Text style={[styles.tag, styles.tagCount]}>{count} 端末</Text> : null}
				</View>
				<Text style={styles.rowCommand} numberOfLines={1}>{preset.description ?? presetCommandSummary(preset)}</Text>
			</View>
			<Ionicons name="chevron-forward" size={15} color={colors.textDim} />
		</Pressable>
	);
}

const ROW_PADDING = 14;
const ROW_ICON = 30;
const ROW_GAP = 11;

const styles = StyleSheet.create({
	body: { paddingHorizontal: 16 },
	lead: { color: colors.textDim, fontSize: 12, paddingHorizontal: 12, paddingTop: 4, paddingBottom: 10 },
	center: { paddingVertical: 30, alignItems: 'center' },
	empty: { paddingVertical: 26, paddingHorizontal: 22, alignItems: 'center', gap: 10 },
	emptyText: { color: colors.textDim, fontSize: 12, textAlign: 'center', lineHeight: 18 },
	group: {
		borderRadius: 16, ...squircle, overflow: 'hidden',
		backgroundColor: colors.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
	},
	row: { flexDirection: 'row', alignItems: 'center', gap: ROW_GAP, paddingVertical: 11, paddingHorizontal: ROW_PADDING },
	rowPressed: { backgroundColor: 'rgba(255,255,255,0.06)' },
	rowDivider: {
		position: 'absolute', top: 0, right: 0, left: ROW_PADDING + ROW_ICON + ROW_GAP,
		height: StyleSheet.hairlineWidth, backgroundColor: colors.border,
	},
	rowIcon: {
		width: ROW_ICON, height: ROW_ICON, borderRadius: 10, ...squircle,
		alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentWash,
	},
	rowBody: { flex: 1, minWidth: 0 },
	rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
	rowTitle: { color: colors.text, fontSize: 13.5, fontWeight: '600', flexShrink: 1 },
	tag: {
		color: colors.textDim, fontSize: 9.5, fontWeight: '700', paddingHorizontal: 6, paddingVertical: 1.5,
		borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.09)', overflow: 'hidden',
	},
	tagCount: { color: colors.green, backgroundColor: 'rgba(79,209,165,0.15)' },
	// 区別語は名前の補足。保存元タグと同じ強さで並べると名前より目立つので、枠だけにする
	// 枠は colors.border より濃くする。同名を見分ける唯一の手掛かりが、ガラス面の上で
	// 一番読めない要素になってしまう
	tagQualifier: { backgroundColor: 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.24)', flexShrink: 1 },
	rowCommand: { color: colors.textDim, fontSize: 10.5, marginTop: 2, fontFamily: mono.ios },

	confirmQualifierLine: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingTop: 4 },
	confirmName: { color: colors.text, fontSize: 14, fontWeight: '700', flexShrink: 1 },
	confirmLead: { color: colors.text, fontSize: 13, lineHeight: 19, paddingHorizontal: 12, paddingTop: 4, paddingBottom: 12 },
	// 実行される本文をそのまま出す。要約すると「押す前に分かる」が成り立たない。
	taskCard: {
		backgroundColor: '#1a1a1e', borderRadius: radius.control, ...squircle,
		borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, padding: 10, marginBottom: 8,
	},
	taskName: { color: colors.textDim, fontSize: 10.5, fontWeight: '700', marginBottom: 5 },
	taskCommand: { color: '#d4d4d4', fontSize: 11, fontFamily: mono.ios, lineHeight: 17 },
	note: { color: colors.textDim, fontSize: 11, lineHeight: 16, paddingHorizontal: 12, paddingTop: 4, paddingBottom: 14 },
	warn: { color: colors.yellow, fontSize: 11, lineHeight: 16, paddingHorizontal: 12, paddingTop: 2 },
	cta: {
		flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
		backgroundColor: colors.accent, borderRadius: radius.pill, ...squircle, paddingVertical: 13,
	},
	ctaPressed: { opacity: 0.85 },
	ctaText: { color: '#04222b', fontSize: 15, fontWeight: '700' },
	secondary: { alignItems: 'center', paddingVertical: 14 },
	secondaryText: { color: colors.accent, fontSize: 13 },
});
