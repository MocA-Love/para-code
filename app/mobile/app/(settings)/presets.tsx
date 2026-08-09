// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { ScreenHeader } from '../../src/components/screenHeader.js';
import { useEffectiveWs } from '../../src/components/wsDrawer.js';
import { useStableInsets } from '../../src/hooks/useStableInsets.js';
import { useContentColumnStyle } from '../../src/ipad/useContentColumn.js';
import { presetCommandSummary, presetIonicon, presetTerminalCount } from '../../src/presets.js';
import { colors, mono, radius, squircle } from '../../src/theme.js';
import { hapticSelection } from '../../src/haptics.js';
import type { PresetDef } from '../../src/store.js';

/**
 * 設定 →「コマンドプリセット」。ターミナル画面の雷から開く一覧に、どれを出すかを決める。
 *
 * **中身は編集できない。** プリセットの定義（名前・コマンド・アイコン）はPCが持ち
 * （設定 `paradis.terminal.presets` またはリポジトリの `.paracode.json`）、この画面が
 * 決めるのは表示だけ。ここでの選択はこの端末の中にPCごとに保存し、PCへは送らない
 * （ターミナル設定と同じ理由。複数のスマホやiPadで奪い合わないため）。
 *
 * 並び順を持たないのは、PC側に既に並べ替えがあるため。二重に順序を持つと、PCで並べ替えても
 * スマホが追従しない状態が生まれる。
 */
export default function PresetSettingsScreen() {
	const insets = useStableInsets();
	const [headerHeight, setHeaderHeight] = useState(0);
	const column = useContentColumnStyle();
	const ws = useEffectiveWs();
	const { presetList, hiddenKeys, setPresetHidden } = useAppStore(useShallow(s => ({
		presetList: s.presetList,
		hiddenKeys: s.presetHiddenKeys,
		setPresetHidden: s.setPresetHidden,
	})));
	const [presets, setPresets] = useState<PresetDef[] | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);

	useEffect(() => {
		if (ws === undefined) {
			setPresets([]);
			return;
		}
		let cancelled = false;
		// スペースが変わったら前の一覧を消す（別スペースの設定を触っているように見せない）。
		setPresets(undefined);
		setError(undefined);
		presetList(ws.id).then(result => {
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
	}, [ws, presetList]);

	return (
		<View style={styles.screen}>
			<ScreenHeader title="コマンドプリセット" onHeightChange={setHeaderHeight} />
			<ScrollView style={styles.scroll} contentContainerStyle={[{ paddingTop: headerHeight, paddingBottom: insets.bottom + 24 }, column]}>
				<Text style={styles.sectionTitle}>{ws?.name ?? 'スペース未選択'}</Text>
				{presets === undefined ? (
					<View style={styles.center}><ActivityIndicator color={colors.accent} /></View>
				) : presets.length === 0 ? (
					<View style={styles.card}>
						<Text style={styles.empty}>
							{ws === undefined
								? 'スペースを選ぶと、そこで使えるプリセットが出ます'
								: error !== undefined
									? `一覧を取得できませんでした（${error}）`
									: 'このスペースで使えるプリセットはまだありません。PCの設定、またはリポジトリの .paracode.json で作れます'}
						</Text>
					</View>
				) : (
					<View style={styles.card}>
						{presets.map((preset, index) => {
							const count = presetTerminalCount(preset);
							return (
								<View key={preset.key}>
									{index > 0 ? <View style={styles.separator} /> : null}
									<View style={styles.row}>
										<View style={styles.icon}>
											<Ionicons name={presetIonicon(preset.icon) as keyof typeof Ionicons.glyphMap} size={16} color={colors.accent} />
										</View>
										<View style={styles.rowBody}>
											<Text style={styles.rowTitle} numberOfLines={1}>
												{preset.name}
												<Text style={styles.rowSource}>{preset.source === 'workspace' ? '  リポジトリ' : '  ユーザー'}</Text>
												{count > 1 ? <Text style={styles.rowSource}>{`  ${count} 端末`}</Text> : null}
											</Text>
											<Text style={styles.rowCommand} numberOfLines={2}>{presetCommandSummary(preset)}</Text>
										</View>
										<Switch
											value={!hiddenKeys.has(preset.key)}
											onValueChange={value => { hapticSelection(); setPresetHidden(preset.key, !value); }}
											trackColor={{ true: colors.accent2 }}
										/>
									</View>
								</View>
							);
						})}
					</View>
				)}
				<Text style={styles.note}>
					オフにしたものはターミナル画面の一覧に出ません。PC側では今までどおり使えます。
					リポジトリごとのプリセットはそのスペースにしか出ないので、別のスペースで隠したものはそちらの画面で戻してください。
				</Text>
				<Text style={styles.note}>
					実行すると、PCはいつも新しいターミナルを作ってそこでコマンドを流します。作業中の端末に割り込むことはありません。
					初めて実行するプリセットは、走るコマンドを見せてから確認します。
				</Text>
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	scroll: { flex: 1, paddingHorizontal: 16 },
	sectionTitle: { color: colors.textDim, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8, marginBottom: 8 },
	card: { backgroundColor: colors.surface, borderRadius: radius.card, ...squircle, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14 },
	center: { paddingVertical: 34, alignItems: 'center' },
	empty: { color: colors.textDim, fontSize: 12, lineHeight: 18, paddingVertical: 16 },
	separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
	row: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 12 },
	icon: { width: 30, height: 30, borderRadius: 10, ...squircle, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentWash },
	rowBody: { flex: 1, minWidth: 0 },
	rowTitle: { color: colors.text, fontSize: 13.5, fontWeight: '600' },
	rowSource: { color: colors.textDim, fontSize: 10.5, fontWeight: '600' },
	rowCommand: { color: colors.textDim, fontSize: 10.5, marginTop: 3, fontFamily: mono.ios, lineHeight: 15 },
	note: { color: colors.textDim, fontSize: 11.5, lineHeight: 17, marginTop: 12, paddingHorizontal: 4 },
});
