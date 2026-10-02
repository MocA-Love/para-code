// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Search, Settings2, SquareTerminal } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../appState.js';
import { haptic } from '../../haptics.js';
import { monoFamily } from '../../monoFont.js';
import { runPresetInBackground } from '../../presetLaunch.js';
import { presetApprovalKey, presetCommandSummary, presetTerminalCount, visiblePresets } from '../../presets.js';
import { routes } from '../../routes.js';
import type { PresetDef } from '../../store.js';
import { HIT_SIZE, colors, radius, space, squircle, type } from '../../theme.js';
import { BottomDrawer, Button, Icon, iconSize } from '../../ui/index.js';

/** 行の頭のアイコンの台（モックの `.qicon`: 26）。 */
const ICON_BOX = 26;
/** 検索欄（モックの `.sfield`: 36）。当たり判定は 44 に広げる。 */
const SEARCH_HEIGHT = 36;
const SEARCH_SLOP = { top: 4, bottom: 4, left: 0, right: 0 };

/**
 * クイックコマンド（Orca の QuickCommandsSheet。モックの「クイックコマンド」）。中身は既存の
 * コマンドプリセット（PC の設定・リポジトリの .paracode.json）で、実行も既存の `runPresetInBackground`。
 *
 * 旧シート（`components/presetSheet.tsx`）と同じく、初めてのプリセット（とコマンドが書き換わった
 * プリセット）は、実行の前に全文を出して確認を取る。一度通したものは次から1タップで走る。
 * 定義の編集はできない（PC が持つ）。出す項目は設定の「コマンドプリセット」で選ぶ。
 *
 * `onRan` は実行を始めたときに呼ぶ（画面は作られたターミナルのタブへ移る）。
 */
export function QuickCommandsDrawer({ visible, ws, wsLabel, onClose, onRan }: {
	visible: boolean;
	ws: string | undefined;
	wsLabel: string;
	onClose: () => void;
	onRan: () => void;
}) {
	const router = useRouter();
	const { presetList, hiddenKeys, approvedKeys, approvePreset } = useAppStore(useShallow(s => ({
		presetList: s.presetList,
		hiddenKeys: s.presetHiddenKeys,
		approvedKeys: s.presetApprovedSignatures,
		approvePreset: s.approvePreset,
	})));
	const [presets, setPresets] = useState<PresetDef[] | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const [confirming, setConfirming] = useState<PresetDef | undefined>(undefined);
	const [query, setQuery] = useState('');
	const afterClose = useRef<(() => void) | undefined>(undefined);

	// 開くたびに取り直す（PC で定義を書き換えた直後でも、開き直せば追いつく）。
	useEffect(() => {
		if (!visible || ws === undefined) {
			return undefined;
		}
		let cancelled = false;
		setError(undefined);
		setConfirming(undefined);
		setQuery('');
		// 前に開いたスペースの一覧を残さない（取得を待つ間に押せると別の場所で走る）。
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

	const rows = useMemo(() => {
		const all = visiblePresets(presets ?? [], hiddenKeys);
		const needle = query.trim().toLowerCase();
		return needle.length === 0 ? all : all.filter(preset => `${preset.name} ${presetCommandSummary(preset)}`.toLowerCase().includes(needle));
	}, [presets, hiddenKeys, query]);

	const run = (preset: PresetDef) => {
		if (ws === undefined) {
			return;
		}
		haptic('commit');
		runPresetInBackground({ ws, wsLabel, preset });
		onRan();
		onClose();
	};
	const press = (preset: PresetDef) => {
		if (approvedKeys.has(presetApprovalKey(preset))) {
			run(preset);
			return;
		}
		haptic('move');
		setConfirming(preset);
	};
	const confirm = () => {
		if (confirming !== undefined) {
			approvePreset(presetApprovalKey(confirming));
			run(confirming);
		}
	};
	const close = () => {
		setConfirming(undefined);
		onClose();
	};

	return (
		<BottomDrawer
			visible={visible}
			onClose={close}
			onAfterClose={() => {
				const next = afterClose.current;
				afterClose.current = undefined;
				next?.();
			}}
			accessibilityLabel="クイックコマンド"
		>
			<Text style={styles.head} accessibilityRole="header">{confirming !== undefined ? confirming.name : 'クイックコマンド'}</Text>
			{confirming !== undefined ? (
				<View style={styles.confirm}>
					<Text style={styles.lead}>
						{`${wsLabel} で${presetTerminalCount(confirming) > 1 ? `${presetTerminalCount(confirming)}つのターミナルを作って` : '新しいターミナルを作って'}実行します。`}
					</Text>
					{confirming.qualifier !== undefined ? <Text style={styles.note}>{confirming.qualifier}</Text> : null}
					{confirming.tasks.map((task, index) => (
						<View key={index} style={styles.task}>
							<Text style={styles.taskName}>{task.name ?? `${confirming.name}${confirming.tasks.length > 1 ? ` ${index + 1}` : ''}`}</Text>
							{task.commands.map((command, commandIndex) => <Text key={commandIndex} style={styles.command} selectable>{command}</Text>)}
						</View>
					))}
					{confirming.truncated === true ? (
						<Text style={styles.warn}>コマンドが長い、または多いため一部だけを出しています。実行されるのは PC にある定義の全部です。</Text>
					) : null}
					<Text style={styles.note}>確認するのは最初の1回だけです。次からは押すとすぐ実行します（PC 側で中身が書き換わったら、もう一度確認します）。</Text>
					<Button label="実行" onPress={confirm} />
					<Button label="戻る" variant="ghost" onPress={() => setConfirming(undefined)} />
				</View>
			) : (
				<>
					<View style={styles.search}>
						<Icon icon={Search} size={15} color={colors.textMuted} />
						<TextInput
							style={styles.searchInput}
							value={query}
							onChangeText={setQuery}
							placeholder="コマンドを検索…"
							placeholderTextColor={colors.textMuted}
							autoCapitalize="none"
							autoCorrect={false}
							hitSlop={SEARCH_SLOP}
							accessibilityLabel="コマンドを検索"
						/>
					</View>
					<View style={styles.group}>
						{presets === undefined ? (
							<View style={styles.message}><ActivityIndicator color={colors.textDim} /></View>
						) : rows.length === 0 ? (
							<View style={styles.message}>
								<Text style={styles.messageText}>
									{error !== undefined
										? `一覧を取得できませんでした（${error}）`
										: query.trim().length > 0 ? '一致するコマンドはありません'
											: presets.length > 0 ? 'すべて非表示にしています。設定の「コマンドプリセット」で戻せます'
												: 'このスペースで使えるコマンドはまだありません。PC の設定か、リポジトリの .paracode.json で作れます'}
								</Text>
							</View>
						) : rows.map((preset, index) => (
							<Pressable
								key={preset.key}
								onPress={() => press(preset)}
								style={({ pressed }) => [styles.row, index > 0 ? styles.divider : undefined, pressed ? styles.pressed : undefined]}
								accessibilityRole="button"
								accessibilityLabel={preset.name}
								accessibilityHint={presetCommandSummary(preset)}
							>
								<View style={styles.icon}><Icon icon={SquareTerminal} size={iconSize.sm} color={colors.textDim} /></View>
								<View style={styles.text}>
									<Text style={styles.name} numberOfLines={1}>{preset.qualifier !== undefined ? `${preset.name}（${preset.qualifier}）` : preset.name}</Text>
									<Text style={styles.summary} numberOfLines={1}>{preset.description ?? presetCommandSummary(preset)}</Text>
								</View>
							</Pressable>
						))}
					</View>
					<Pressable
						onPress={() => {
							afterClose.current = () => router.push(routes.settings('presets'));
							close();
						}}
						style={({ pressed }) => [styles.manage, pressed ? styles.pressed : undefined]}
						accessibilityRole="button"
					>
						<Icon icon={Settings2} color={colors.textDim} />
						<Text style={styles.manageText}>表示するコマンドを選ぶ</Text>
					</Pressable>
				</>
			)}
		</BottomDrawer>
	);
}

const styles = StyleSheet.create({
	head: {
		marginBottom: space.md,
		textAlign: 'center',
		fontSize: type.input,
		fontWeight: '600',
		color: colors.text,
	},
	search: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		height: SEARCH_HEIGHT,
		marginBottom: space.md,
		paddingHorizontal: 10,
		borderRadius: radius.control,
		backgroundColor: colors.raised,
	},
	searchInput: {
		flex: 1,
		minWidth: 0,
		height: SEARCH_HEIGHT,
		fontSize: type.input,
		color: colors.text,
	},
	group: {
		borderRadius: radius.group,
		...squircle,
		backgroundColor: colors.panel,
		overflow: 'hidden',
	},
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.md,
		minHeight: HIT_SIZE,
		paddingHorizontal: space.md,
		paddingVertical: space.md,
	},
	divider: {
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: colors.border,
	},
	pressed: {
		backgroundColor: colors.raised,
	},
	icon: {
		width: ICON_BOX,
		height: ICON_BOX,
		alignItems: 'center',
		justifyContent: 'center',
		borderRadius: radius.key,
		backgroundColor: colors.raised,
	},
	text: {
		flex: 1,
		minWidth: 0,
	},
	name: {
		fontSize: type.body,
		fontWeight: '600',
		color: colors.text,
	},
	summary: {
		marginTop: 1,
		fontFamily: monoFamily,
		fontSize: type.meta,
		color: colors.textDim,
	},
	message: {
		minHeight: HIT_SIZE,
		alignItems: 'center',
		justifyContent: 'center',
		padding: space.lg,
	},
	messageText: {
		textAlign: 'center',
		fontSize: type.meta,
		lineHeight: 18,
		color: colors.textMuted,
	},
	manage: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 6,
		height: HIT_SIZE,
		marginTop: space.md,
		borderRadius: radius.button,
		borderWidth: 1,
		borderColor: colors.border,
	},
	manageText: {
		fontSize: type.body,
		fontWeight: '600',
		color: colors.textDim,
	},
	confirm: {
		gap: space.sm,
	},
	lead: {
		fontSize: type.body,
		lineHeight: 20,
		color: colors.text,
	},
	task: {
		padding: 10,
		borderRadius: radius.control,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		backgroundColor: colors.panel,
	},
	taskName: {
		marginBottom: space.xs,
		fontSize: type.caption,
		fontWeight: '700',
		color: colors.textMuted,
	},
	command: {
		fontFamily: monoFamily,
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.terminalFg,
	},
	warn: {
		fontSize: type.caption,
		lineHeight: 16,
		color: colors.amber,
	},
	note: {
		fontSize: type.caption,
		lineHeight: 16,
		color: colors.textMuted,
	},
});
