// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StyleSheet, View } from 'react-native';
import { FileTreePanel } from '../features/code/fileTreePanel.js';
import type { PanelDock } from '../features/code/panelDock.js';
import { SourceControlPanel } from '../features/code/sourceControlPanel.js';
import { useCodeSpace, type CodeSpaceTarget } from '../features/code/useCodeSpace.js';
import { SpaceNotePanel } from '../features/note/spaceNotePanel.js';
import { colors } from '../theme.js';
import type { DockPanel } from './shortcuts.js';

/**
 * セッションの右のドック（Orca の SessionDockColumn）。ソース管理・ファイル・メモを、ルートで開くときと
 * 同じ部品で出す。幅と出し入れはセッションの画面が決める（`canDockPanel` / `dockWidthFor`）。
 */
export function SessionDock({ panel, target, dock }: { panel: DockPanel; target: CodeSpaceTarget; dock: PanelDock }) {
	return (
		<View style={styles.root}>
			{panel === 'scm' ? <SourceControlPanel target={target} dock={dock} />
				: panel === 'files' ? <DockedFiles target={target} dock={dock} />
				: <SpaceNotePanel target={target} dock={dock} />}
		</View>
	);
}

function DockedFiles({ target, dock }: { target: CodeSpaceTarget; dock: PanelDock }) {
	const codeSpace = useCodeSpace(target);
	return <FileTreePanel codeSpace={codeSpace} reveal={undefined} dock={dock} />;
}

const styles = StyleSheet.create({
	root: {
		flex: 1,
		backgroundColor: colors.panel,
	},
});
