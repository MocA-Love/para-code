// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { presetCommandSummary, presetIonicon, presetTerminalCount } from '../../src/presets.js';
import type { PresetDef } from '../../src/store.js';
import { colors, space } from '../../src/theme.js';
import { ListGroup, ListRow, iconSize } from '../../src/ui/index.js';
import { GroupHeader, GroupNote, SettingsScreen, SettingsSwitch } from '../../src/features/settings/settingsScaffold.js';

/**
 * コマンドプリセット（`/settings/presets`。旧「コマンドプリセット」画面。モックには無い）。
 * ターミナルのクイックコマンドの一覧に、どれを出すかを決める。
 *
 * **中身は編集できない。** 定義（名前・コマンド・アイコン）は PC が持ち（設定 `paradis.terminal.presets` か
 * リポジトリの `.paracode.json`）、ここが決めるのは表示だけ。選択はこの端末の中に PC ごとに保存し、PC へは送らない。
 *
 * 対象のスペースは、いま選んでいるスペース（無ければ最初のスペース）。リポジトリごとのプリセットは
 * そのスペースにしか出ない。
 */
export default function PresetSettingsScreen() {
	const targetSpace = useAppStore(useShallow(s => {
		const list = s.workspace?.workspaces ?? [];
		const found = list.find(w => w.id === s.selectedWs) ?? list[0];
		return found === undefined ? undefined : { id: found.id, name: found.name };
	}));
	const { presetList, hiddenKeys, setPresetHidden } = useAppStore(useShallow(s => ({
		presetList: s.presetList,
		hiddenKeys: s.presetHiddenKeys,
		setPresetHidden: s.setPresetHidden,
	})));
	const [presets, setPresets] = useState<PresetDef[] | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const spaceId = targetSpace?.id;

	useEffect(() => {
		if (spaceId === undefined) {
			setPresets([]);
			return undefined;
		}
		let cancelled = false;
		// スペースが変わったら前の一覧を消す（別のスペースの設定を触っているように見せない）
		setPresets(undefined);
		setError(undefined);
		presetList(spaceId).then(result => {
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
	}, [spaceId, presetList]);

	return (
		<SettingsScreen title="コマンドプリセット" subtitle={targetSpace?.name}>
			<GroupHeader title="一覧に出すもの" first />
			{presets === undefined ? (
				<View style={styles.loading}><ActivityIndicator color={colors.textDim} /></View>
			) : presets.length === 0 ? (
				<ListGroup>
					<ListRow
						label={targetSpace === undefined ? 'スペースがありません' : error !== undefined ? '一覧を取得できませんでした' : 'プリセットはまだありません'}
						hint={targetSpace === undefined
							? 'PC につながると、スペースで使えるプリセットが出ます'
							: error ?? 'PC の設定か、リポジトリの .paracode.json で作れます'}
					/>
				</ListGroup>
			) : (
				<ListGroup>
					{presets.map(preset => {
						const count = presetTerminalCount(preset);
						const source = preset.source === 'workspace' ? 'リポジトリ' : 'ユーザー';
						return (
							<ListRow
								key={preset.key}
								leading={<Ionicons name={presetIonicon(preset.icon) as keyof typeof Ionicons.glyphMap} size={iconSize.md} color={colors.textDim} />}
								label={preset.name}
								hint={`${source}${count > 1 ? ` · ${count} 端末` : ''} · ${presetCommandSummary(preset)}`}
								trailing={<SettingsSwitch value={!hiddenKeys.has(preset.key)} onValueChange={value => setPresetHidden(preset.key, !value)} accessibilityLabel={`${preset.name} を一覧に出す`} />}
							/>
						);
					})}
				</ListGroup>
			)}
			<GroupNote after>オフにしたものはターミナルの一覧に出ません。PC 側ではいままでどおり使えます。実行すると、PC はいつも新しいターミナルを作ってそこでコマンドを流します。初めて実行するプリセットは、走るコマンドを見せてから確かめます。</GroupNote>
		</SettingsScreen>
	);
}

const styles = StyleSheet.create({
	loading: {
		paddingVertical: space.xl,
		alignItems: 'center',
	},
});
