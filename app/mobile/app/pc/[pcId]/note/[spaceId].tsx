// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { SpaceNotePanel } from '../../../../src/features/note/spaceNotePanel.js';

/**
 * スペースのメモ（`/pc/[pcId]/note/[spaceId]`）。中身は `SpaceNotePanel`（iPad のセッションの右のドックでも
 * 同じものを使う）。
 */
export default function SpaceNoteScreen() {
	return <SpaceNotePanel />;
}
