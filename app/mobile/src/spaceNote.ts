// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * スペースのメモ（PC版 Workspaces ビュー下部のメモ欄）の Markdown チェックリスト解釈。
 * 判定規則はPC側の src/vs/paradis/contrib/workspaceSwitch/common/paradisSpaceNotes.ts と
 * 同一にしてある（どちらで書いても同じ行がチェックリストとして扱われるようにするため）。
 */

/** 1スペースあたりの本文上限。PC側の PARADIS_SPACE_NOTE_MAX_LENGTH と同値。 */
export const SPACE_NOTE_MAX_LENGTH = 8_000;

export type SpaceNoteLineKind = 'blank' | 'heading' | 'text' | 'task';

export interface SpaceNoteLine {
	/** 元テキスト内の行番号（0-based）。トグル対象の指定に使う。 */
	index: number;
	kind: SpaceNoteLineKind;
	/** 表示用テキスト（task はチェックボックスの後ろ、heading は # の後ろ）。 */
	text: string;
	/** kind === 'task' のときのみ意味を持つ。 */
	done: boolean;
}

const TASK_PATTERN = /^\s*[-*] \[([ xX])\] ?(.*)$/;
const HEADING_PATTERN = /^ {0,3}#{1,6} +(.*)$/;

export function parseSpaceNote(text: string): SpaceNoteLine[] {
	if (!text) {
		return [];
	}
	return text.split('\n').map((line, index): SpaceNoteLine => {
		const task = TASK_PATTERN.exec(line);
		if (task) {
			return { index, kind: 'task', text: task[2] ?? '', done: (task[1] ?? '').toLowerCase() === 'x' };
		}
		const heading = HEADING_PATTERN.exec(line);
		if (heading) {
			return { index, kind: 'heading', text: heading[1] ?? '', done: false };
		}
		return { index, kind: line.trim().length === 0 ? 'blank' : 'text', text: line, done: false };
	});
}

export function spaceNoteSummary(text: string): { open: number; done: number } {
	let open = 0;
	let done = 0;
	for (const line of parseSpaceNote(text)) {
		if (line.kind !== 'task') {
			continue;
		}
		if (line.done) {
			done++;
		} else {
			open++;
		}
	}
	return { open, done };
}

/** 指定行のチェックボックスを反転した本文。対象行がチェックリストでなければ undefined。 */
export function toggleSpaceNoteTask(text: string, lineIndex: number): string | undefined {
	const lines = text.split('\n');
	const line = lines[lineIndex];
	if (line === undefined) {
		return undefined;
	}
	const task = TASK_PATTERN.exec(line);
	if (!task) {
		return undefined;
	}
	lines[lineIndex] = line.replace(/\[[ xX]\]/, (task[1] ?? '').toLowerCase() === 'x' ? '[ ]' : '[x]');
	return lines.join('\n');
}
