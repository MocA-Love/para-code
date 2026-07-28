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

/** 行頭に付けられる記号。編集ツールバーの各ボタンに対応する。 */
export type SpaceNotePrefix = 'task' | 'heading' | 'bullet' | 'none';

/** 複数行を1項目として足すときの、2行目以降のぶら下げ幅。PC側の CONTINUATION_INDENT と同値。 */
const CONTINUATION_INDENT = '  ';

/** 行頭記号（チェックボックス・見出し・箇条書き）と、その前のインデント。TASK_PATTERN と同じくボックス後のスペースは省略可。 */
const LINE_PREFIX_PATTERN = /^(\s*)(?:[-*] \[[ xX]\] ?|#{1,6} +|[-*] )?/;

/** position を含む行の範囲（end は行末の改行を含まない）。 */
function lineRangeAt(text: string, position: number): { start: number; end: number } {
	const clamped = Math.max(0, Math.min(position, text.length));
	const start = text.lastIndexOf('\n', clamped - 1) + 1;
	const end = text.indexOf('\n', clamped);
	return { start, end: end === -1 ? text.length : end };
}

/**
 * カーソル行の行頭記号を差し替えた本文と、差し替え後のカーソル位置。
 * 既存の記号は1つだけ剥がすので、ボタンを続けて押しても記号が積み重ならない。
 */
export function applySpaceNotePrefix(text: string, selectionStart: number, prefix: SpaceNotePrefix): { text: string; selection: number } {
	const { start, end } = lineRangeAt(text, selectionStart);
	const line = text.slice(start, end);
	const matched = LINE_PREFIX_PATTERN.exec(line);
	const indent = matched?.[1] ?? '';
	const body = line.slice(matched?.[0].length ?? 0);
	const marker = prefix === 'task' ? '- [ ] ' : prefix === 'heading' ? '# ' : prefix === 'bullet' ? '- ' : '';
	const next = indent + marker + body;
	const shifted = Math.max(start, Math.min(selectionStart + (next.length - line.length), start + next.length));
	return { text: text.slice(0, start) + next + text.slice(end), selection: shifted };
}

/**
 * チェックリスト行での改行を継続入力に変える。`previous` に改行1文字が挿入されて
 * `next` になった場合だけ働き、それ以外（変換中の文字揺れ・貼り付け等）は undefined を返す。
 *
 * 本文のある `- [ ]` 行での改行は次行にも `- [ ] ` を置き、本文が空のチェック行での改行は
 * 記号ごと消してリストから抜ける（一般的なMarkdownエディタと同じ挙動）。
 *
 * 呼び出し側はこの結果でのみ入力欄を書き換えること。改行はIMEの変換確定後にしか
 * 発生しないため、未確定の文字列（marked text）を壊さずに済む。
 */
export function continueSpaceNoteChecklist(previous: string, next: string): { text: string; selection: number } | undefined {
	if (next.length !== previous.length + 1) {
		return undefined;
	}
	// 挿入位置は末尾側から詰めて求める。先頭から走査すると、打った改行と既にある改行を
	// 区別できず1つ後ろの行を対象にしてしまい、行末で改行したときに本文が壊れる。
	let tail = 0;
	while (tail < previous.length && previous[previous.length - 1 - tail] === next[next.length - 1 - tail]) {
		tail++;
	}
	const inserted = previous.length - tail;
	if (next[inserted] !== '\n' || previous.slice(0, inserted) !== next.slice(0, inserted)) {
		return undefined;
	}
	const { start, end } = lineRangeAt(previous, inserted);
	// 継続するかはカーソルまでの内容で決める（行頭や記号の途中での改行では継続しない）
	const head = previous.slice(start, inserted);
	if (!TASK_PATTERN.test(head)) {
		return undefined;
	}
	// 空かどうかは行全体で見る。カーソルの後ろに本文が残っているなら消してはいけない
	if ((TASK_PATTERN.exec(previous.slice(start, end))?.[2] ?? '').trim().length === 0) {
		return { text: previous.slice(0, start) + previous.slice(end), selection: start };
	}
	const marker = `${/^\s*/.exec(head)?.[0] ?? ''}- [ ] `;
	return { text: next.slice(0, inserted + 1) + marker + next.slice(inserted + 1), selection: inserted + 1 + marker.length };
}

/**
 * 保存前に、自動継続が置いた末尾の空チェック項目を落とす。
 * 残したままだと未完了1件として数えられ、PCの一覧バッジにも幽霊が出る。
 */
export function trimSpaceNoteTrailingEmptyTask(text: string): string {
	return text.replace(/(?:^|\n)[ \t]*[-*] \[[ xX]\] ?[ \t]*$/, '');
}

/**
 * 本文の末尾に1件追記した結果。編集モードに入らず一覧から項目を足すために使う。
 * 中身が空なら undefined を返す。末尾の空白・空行は詰めるので、追加を繰り返しても行間が開いていかない。
 *
 * 改行を含むラベル（貼り付け等）はPC側の paradisAppendSpaceNoteTask と同じく、2行目以降を
 * ぶら下げの継続行に畳む。1件のつもりの追加でチェックボックスが増えないようにするため。
 */
export function appendSpaceNoteEntry(text: string, label: string, kind: 'task' | 'text'): string | undefined {
	const [first, ...rest] = label.split('\n').map(line => line.trim());
	if ((first ?? '').length === 0) {
		return undefined;
	}
	const continuation = rest.filter(line => line.length > 0).map(line => `${CONTINUATION_INDENT}${line}`);
	const entry = [kind === 'task' ? `- [ ] ${first}` : first, ...continuation].join('\n');
	const base = text.replace(/\s+$/, '');
	return base.length === 0 ? entry : `${base}\n${entry}`;
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
