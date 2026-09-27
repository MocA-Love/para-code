// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { SourceControlPanel } from '../../../../src/features/code/sourceControlPanel.js';

/**
 * ソース管理（`/pc/[pcId]/source-control/[spaceId]`）。中身は `SourceControlPanel`（iPad のセッションの
 * 右のドックでも同じものを使う）。
 */
export default function SourceControlScreen() {
	return <SourceControlPanel />;
}
