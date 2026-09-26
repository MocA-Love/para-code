// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { hapticSelection } from '../../src/haptics.js';
import { useParaToast } from '../../src/paraToast.js';
import { colors, radius } from '../../src/theme.js';
import {
	ListGroup,
	ListRow,
	THEME_COLOR_SLOTS,
	THEME_COLOR_SLOT_LABELS,
	colorName,
	colorWarnings,
	isDefaultThemeColor,
	themeColorOf,
	useThemeColorStore,
	type ThemeColorSlot,
} from '../../src/ui/index.js';
import { ColorPickerDrawer } from '../../src/features/settings/colorPickerDrawer.js';
import { ColorPreview } from '../../src/features/settings/colorPreview.js';
import { resetThemeColors, setThemeColor } from '../../src/features/settings/themeColorSettings.js';
import { GroupGap, GroupHeader, GroupNote, SettingsScreen } from '../../src/features/settings/settingsScaffold.js';

function showSaveFailed(): void {
	useParaToast.getState().show({ key: 'theme-colors-save', text: '保存できませんでした', icon: 'alert-circle-outline', tone: 'warn' }, 2_500);
}

/**
 * 色（`/settings/colors`。モックの「設定 → 色」の案1）。主ボタン・自分の発言と送信・選択の印とリンクの
 * 3か所の色を変えられる。上にいまの色の見本、行を押すと色を選ぶシートが開く。
 * 状態の色（要対応・実行中・未確認・待機）は変えられない。この端末の中だけの設定で、PC へは送らない。
 */
export default function ColorSettingsScreen() {
	const settings = useThemeColorStore(s => s.settings);
	/** 色を選んでいる場所（シートを閉じる途中も見出しが変わらないように、閉じても残す）。 */
	const [editing, setEditing] = useState<ThemeColorSlot>('primary');
	const [drawerOpen, setDrawerOpen] = useState(false);
	const allDefault = THEME_COLOR_SLOTS.every(slot => isDefaultThemeColor(settings, slot));

	const open = (slot: ThemeColorSlot) => {
		hapticSelection();
		setEditing(slot);
		setDrawerOpen(true);
	};

	return (
		<SettingsScreen
			title="色"
			footer={(
				<ColorPickerDrawer
					visible={drawerOpen}
					slot={editing}
					onChange={(slot, hex) => { setThemeColor(slot, hex).catch(showSaveFailed); }}
					onClose={() => setDrawerOpen(false)}
				/>
			)}
		>
			<GroupHeader title="プレビュー" first />
			<ColorPreview />
			<GroupHeader title="場所ごとの色" />
			<ListGroup>
				{THEME_COLOR_SLOTS.map(slot => {
					const hex = themeColorOf(settings, slot);
					const warnings = colorWarnings(hex);
					const label = THEME_COLOR_SLOT_LABELS[slot];
					return (
						<ListRow
							key={slot}
							leading={<View style={[styles.dot, { backgroundColor: hex }]} />}
							label={label.name}
							hint={label.description}
							warning={warnings.length > 0 ? warnings.join('、') : undefined}
							value={isDefaultThemeColor(settings, slot) ? '既定' : colorName(hex)}
							trailing="chevron"
							onPress={() => open(slot)}
						/>
					);
				})}
			</ListGroup>
			<GroupNote after>上に載る文字の色は、選んだ色の明るさから自動で決まります。要対応・実行中・未確認・待機の色は変えられません。この端末の中だけの設定です。</GroupNote>
			<GroupGap />
			<ListGroup>
				<ListRow
					label="すべて既定に戻す"
					disabled={allDefault}
					onPress={() => {
						hapticSelection();
						resetThemeColors().catch(showSaveFailed);
					}}
				/>
			</ListGroup>
		</SettingsScreen>
	);
}

/** 色の丸（モックの `.dot`。22pt）。 */
const DOT_SIZE = 22;

const styles = StyleSheet.create({
	dot: {
		width: DOT_SIZE,
		height: DOT_SIZE,
		borderRadius: radius.pill,
		borderWidth: 1,
		borderColor: colors.borderStrong,
	},
});
