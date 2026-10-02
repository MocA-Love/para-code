// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { haptic } from '../../src/haptics.js';
import { TERMINAL_FOLLOW_MIN_FONT_SIZE } from '../../src/terminalViewport.js';
import { ListGroup, ListRow } from '../../src/ui/index.js';
import { GroupHeader, GroupNote, SettingsScreen, SettingsSwitch } from '../../src/features/settings/settingsScaffold.js';
import { TerminalFontSizeDrawer } from '../../src/features/settings/terminalFontSizeDrawer.js';

/**
 * ターミナル（`/settings/terminal`。モックの「ターミナル」、旧「ターミナル」設定画面）。
 *
 * Para Code の端末の設定は「文字サイズ」と「PC 側の端末幅をこの画面に合わせるか」の2つ。
 * どちらもこの端末の中だけに保存し、PC へは送らない（複数のスマホで取り合いにならないように）。
 * PC へ届くのは、ターミナルを開いている間の寸法の申告だけで、それを出すかを「スマホの幅に合わせる」が決める。
 *
 * 文字サイズが効くのは「スマホの幅に合わせる」がオンのとき。オフ（既定）の間は PC の桁数に合わせて
 * 自動で縮める（下限 7pt。`TERMINAL_FOLLOW_MIN_FONT_SIZE`）ので、説明をオン・オフで出し分ける。
 *
 * モックにある「アプリを離れたとき」「キーボード入力」は Para Code に無い設定なので置いていない。
 */
export default function TerminalSettingsScreen() {
	const { terminalPrefs, setTerminalPref } = useAppStore(useShallow(s => ({
		terminalPrefs: s.terminalPrefs,
		setTerminalPref: s.setTerminalPref,
	})));
	const [sizeOpen, setSizeOpen] = useState(false);
	return (
		<SettingsScreen
			title="ターミナル"
			footer={(
				<TerminalFontSizeDrawer
					visible={sizeOpen}
					fontSize={terminalPrefs.fontSize}
					onSelect={size => {
						haptic('tick');
						setTerminalPref('fontSize', size);
					}}
					onClose={() => setSizeOpen(false)}
				/>
			)}
		>
			<GroupHeader title="文字サイズ" first />
			<GroupNote>
				{terminalPrefs.matchPcWidth
					? 'この大きさで入る桁数に、PC のターミナルを合わせます。'
					: `下の「スマホの幅に合わせる」をオンにしたときの大きさです。オフの間は、PC の桁数に合わせて自動で縮めます（最小 ${TERMINAL_FOLLOW_MIN_FONT_SIZE}pt）。`}
			</GroupNote>
			<ListGroup>
				<ListRow
					label="文字サイズ"
					hint={`${terminalPrefs.fontSize}pt`}
					trailing="chevron"
					onPress={() => { haptic('move'); setSizeOpen(true); }}
				/>
			</ListGroup>

			<GroupHeader title="PC 側の端末幅" />
			<GroupNote>見ている間だけ、PC のターミナルをこの画面に入る幅へ細くします。Claude や Codex の画面もその幅で描き直されます。見るのをやめると元に戻ります。</GroupNote>
			<ListGroup>
				<ListRow
					label="スマホの幅に合わせる"
					hint="ベータ"
					trailing={<SettingsSwitch value={terminalPrefs.matchPcWidth} onValueChange={value => setTerminalPref('matchPcWidth', value)} accessibilityLabel="スマホの幅に合わせる" />}
				/>
				<ListRow
					label="行数も合わせる"
					hint="オフにすると桁だけを合わせ、行数は PC のままにします"
					disabled={!terminalPrefs.matchPcWidth}
					trailing={<SettingsSwitch value={terminalPrefs.matchPcRows} onValueChange={value => setTerminalPref('matchPcRows', value)} disabled={!terminalPrefs.matchPcWidth} accessibilityLabel="行数も合わせる" />}
				/>
			</ListGroup>
			<GroupNote after>幅を変えるとシェルや TUI が画面を描き直すため、コマンドの実行中でも表示が一度作り直されます（出力が消えることはありません）。同じターミナルを他のスマホや iPad からも見ている場合は、いちばん狭い画面に合わせます。</GroupNote>
		</SettingsScreen>
	);
}
