/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * スペース (リポジトリ本体 / worktree) ごとのメモ。キーは切り替え状態キーと同じ
 * (リポジトリは IParadisWorkspaceRepository.id、worktree は paradisWorktreeStateKey(uri))
 * なので、スペースの表示名を変えてもメモは追従する。
 */
export const PARADIS_SPACE_NOTES_STORAGE_KEY = 'paradis.workspaceSwitch.spaceNotes.v1';

/** メモ1件分。updatedAt は PC とモバイルの同時編集を last-write-wins で解決するために持つ。 */
export interface IParadisSpaceNote {
	readonly text: string;
	readonly updatedAt: number;
}

/** ツリー行のバッジやモバイルの一覧に載せる軽量サマリ (本文は含めない)。 */
export interface IParadisSpaceNoteSummary {
	readonly open: number;
	readonly done: number;
}

export type ParadisSpaceNoteLineKind = 'blank' | 'heading' | 'text' | 'task';

export interface IParadisSpaceNoteLine {
	/** 元テキスト内の行番号 (0-based)。チェックボックスのトグル対象を指すのに使う。 */
	readonly index: number;
	readonly kind: ParadisSpaceNoteLineKind;
	/** 表示用テキスト (task はチェックボックスの後ろ、heading は # の後ろ)。 */
	readonly text: string;
	/** kind === 'task' のときのみ意味を持つ。 */
	readonly done: boolean;
}

/** 1スペースあたりの本文上限。storage (SQLite) を肥大させないための実用上の上限。 */
export const PARADIS_SPACE_NOTE_MAX_LENGTH = 8_000;

/** メモを保持できるスペース数の上限。 */
export const PARADIS_SPACE_NOTES_MAX_COUNT = 512;
/** 状態キーの上限長 (worktree:<uri> のURIが極端に長い場合の保険)。 */
export const PARADIS_SPACE_NOTE_MAX_STATE_KEY_LENGTH = 1_024;

const MAX_SPACE_NOTES = PARADIS_SPACE_NOTES_MAX_COUNT;
const MAX_STATE_KEY_LENGTH = PARADIS_SPACE_NOTE_MAX_STATE_KEY_LENGTH;
/** JSON化した全メモの上限。キー・本文・区切りの最大値から算出する。 */
const MAX_SPACE_NOTES_STORAGE_LENGTH = MAX_SPACE_NOTES * (MAX_STATE_KEY_LENGTH + PARADIS_SPACE_NOTE_MAX_LENGTH + 64) + 2;

/** `- [ ] やること` / `* [x] やったこと` 形式のチェックリスト行。 */
const TASK_PATTERN = /^\s*[-*] \[([ xX])\] ?(.*)$/;
/** Markdown の見出し行 (`# ` 〜 `###### `)。 */
const HEADING_PATTERN = /^ {0,3}#{1,6} +(.*)$/;

export function paradisParseSpaceNote(text: string): IParadisSpaceNoteLine[] {
	if (!text) {
		return [];
	}
	return text.split('\n').map((line, index): IParadisSpaceNoteLine => {
		const task = TASK_PATTERN.exec(line);
		if (task) {
			return { index, kind: 'task', text: task[2], done: task[1].toLowerCase() === 'x' };
		}
		const heading = HEADING_PATTERN.exec(line);
		if (heading) {
			return { index, kind: 'heading', text: heading[1], done: false };
		}
		return { index, kind: line.trim().length === 0 ? 'blank' : 'text', text: line, done: false };
	});
}

export function paradisSpaceNoteSummary(text: string): IParadisSpaceNoteSummary {
	let open = 0;
	let done = 0;
	for (const line of paradisParseSpaceNote(text)) {
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

/**
 * 指定行のチェックボックスを反転した本文を返す。対象行がチェックリストでなければ
 * undefined を返し、呼び出し側が書き込みをスキップできるようにする。
 */
export function paradisToggleSpaceNoteTask(text: string, lineIndex: number): string | undefined {
	const lines = text.split('\n');
	const line = lines[lineIndex];
	if (line === undefined) {
		return undefined;
	}
	const task = TASK_PATTERN.exec(line);
	if (!task) {
		return undefined;
	}
	// 行頭側のチェックボックスが必ず先にマッチするため、本文中に `[x]` があっても誤爆しない
	lines[lineIndex] = line.replace(/\[[ xX]\]/, task[1].toLowerCase() === 'x' ? '[ ]' : '[x]');
	return lines.join('\n');
}

/** 継続行 (Shift+Enter で足した2行目以降) のインデント。 */
const CONTINUATION_INDENT = '  ';

/** caret を含む行の範囲 [start, end) を返す (end は改行を含まない)。 */
function lineRangeAt(text: string, caret: number): { start: number; end: number } {
	const start = text.lastIndexOf('\n', caret - 1) + 1;
	const newline = text.indexOf('\n', caret);
	return { start, end: newline === -1 ? text.length : newline };
}

/**
 * 編集中に Enter を押したときのチェックリスト継続。
 * - チェックリスト行なら次の行へ同じインデントの `- [ ] ` を足す
 * - 中身が空のチェックリスト行なら、マーカーを外して普通の行に戻す (リストの終わり)
 * - チェックリスト行でなければ undefined を返し、通常の改行に任せる
 */
export function paradisContinueSpaceNoteList(text: string, caret: number): { text: string; caret: number } | undefined {
	const { start, end } = lineRangeAt(text, caret);
	const line = text.slice(start, end);
	const task = TASK_PATTERN.exec(line);
	if (!task) {
		return undefined;
	}
	if (task[2].trim().length === 0) {
		return { text: text.slice(0, start) + text.slice(end), caret: start };
	}
	const indent = /^\s*/.exec(line)?.[0] ?? '';
	const inserted = `\n${indent}- [ ] `;
	return { text: text.slice(0, caret) + inserted + text.slice(caret), caret: caret + inserted.length };
}

/**
 * 選択範囲に掛かる行をチェックリストにする / 解除する (すべてがチェックリストなら解除)。
 * 空行は変えない。変化しない場合は undefined を返す。
 */
export function paradisToggleSpaceNoteListMarkers(text: string, selectionStart: number, selectionEnd: number): { text: string; selectionStart: number; selectionEnd: number } | undefined {
	const from = lineRangeAt(text, selectionStart).start;
	const to = lineRangeAt(text, selectionEnd).end;
	const lines = text.slice(from, to).split('\n');
	const meaningful = lines.filter(line => line.trim().length > 0);
	if (meaningful.length === 0) {
		return undefined;
	}
	const remove = meaningful.every(line => TASK_PATTERN.test(line));
	const converted = lines.map(line => {
		if (line.trim().length === 0) {
			return line;
		}
		if (remove) {
			return line.replace(/^(\s*)[-*] \[[ xX]\] ?/, '$1');
		}
		if (TASK_PATTERN.test(line)) {
			return line;
		}
		const indent = /^\s*/.exec(line)?.[0] ?? '';
		return `${indent}- [ ] ${line.slice(indent.length)}`;
	}).join('\n');
	if (converted === text.slice(from, to)) {
		return undefined;
	}
	return { text: text.slice(0, from) + converted + text.slice(to), selectionStart: from, selectionEnd: from + converted.length };
}

/**
 * 「やることを追加」で1件足した本文を返す。複数行 (Shift+Enter で改行) の場合、
 * 2行目以降はインデント付きの継続行として書き、チェックリストの行数を増やさない。
 * 中身が空なら undefined を返す。
 */
export function paradisAppendSpaceNoteTask(text: string, task: string): string | undefined {
	const lines = task.split('\n').map(line => line.trimEnd());
	const [first, ...rest] = lines;
	if ((first ?? '').trim().length === 0) {
		return undefined;
	}
	const entry = [`- [ ] ${first.trim()}`, ...rest.filter(line => line.trim().length > 0).map(line => `${CONTINUATION_INDENT}${line.trim()}`)].join('\n');
	const body = text.replace(/\s*$/, '');
	return body.length === 0 ? entry : `${body}\n${entry}`;
}

/** 保存前に本文を上限へ丸める (入力側の maxlength をすり抜けた経路への保険)。 */
export function paradisNormalizeSpaceNoteText(text: string): string {
	return text.length > PARADIS_SPACE_NOTE_MAX_LENGTH ? text.slice(0, PARADIS_SPACE_NOTE_MAX_LENGTH) : text;
}

/**
 * 永続化された全メモを防御的に読む。折りたたみ状態などの再生成可能な view state と違い
 * メモはユーザーが書いた資産なので、壊れた1件で全件を捨てず、その1件だけ読み飛ばす。
 */
export function paradisParseSpaceNotes(raw: string | undefined): Map<string, IParadisSpaceNote> {
	const notes = new Map<string, IParadisSpaceNote>();
	if (raw === undefined || raw.length > MAX_SPACE_NOTES_STORAGE_LENGTH) {
		return notes;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return notes;
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return notes;
	}
	for (const [stateKey, entry] of Object.entries(value as Record<string, unknown>)) {
		if (notes.size >= MAX_SPACE_NOTES) {
			break;
		}
		if (stateKey.length === 0 || stateKey.length > MAX_STATE_KEY_LENGTH) {
			continue;
		}
		if (typeof entry !== 'object' || entry === null) {
			continue;
		}
		const { text, updatedAt } = entry as { text?: unknown; updatedAt?: unknown };
		if (typeof text !== 'string' || text.length > PARADIS_SPACE_NOTE_MAX_LENGTH) {
			continue;
		}
		notes.set(stateKey, {
			text,
			updatedAt: typeof updatedAt === 'number' && isFinite(updatedAt) && updatedAt >= 0 ? updatedAt : 0
		});
	}
	return notes;
}

/** reader と同じ上限を満たす snapshot だけを返す。拒否時は呼び出し側が既存storageを保持する。 */
export function paradisSerializeSpaceNotes(notes: ReadonlyMap<string, IParadisSpaceNote>): string | undefined {
	if (notes.size > MAX_SPACE_NOTES) {
		return undefined;
	}
	const record: Record<string, IParadisSpaceNote> = {};
	for (const stateKey of [...notes.keys()].sort()) {
		const note = notes.get(stateKey)!;
		if (stateKey.length === 0 || stateKey.length > MAX_STATE_KEY_LENGTH || note.text.length > PARADIS_SPACE_NOTE_MAX_LENGTH) {
			return undefined;
		}
		record[stateKey] = note;
	}
	const serialized = JSON.stringify(record);
	return serialized.length <= MAX_SPACE_NOTES_STORAGE_LENGTH ? serialized : undefined;
}

export const IParadisSpaceNotesService = createDecorator<IParadisSpaceNotesService>('paradisSpaceNotesService');

/**
 * スペースごとのメモを保持するサービス。Workspaces ビュー下部のメモ欄と、
 * モバイルリレー (閲覧・編集) の両方から使う。
 */
export interface IParadisSpaceNotesService {
	readonly _serviceBrand: undefined;

	/** 変化した状態キー。ツリーのバッジ更新・モバイルへの再送のトリガに使う。 */
	readonly onDidChangeNotes: Event<readonly string[]>;

	/** 未設定なら空文字列を返す。 */
	read(stateKey: string): string;

	summary(stateKey: string): IParadisSpaceNoteSummary;

	/** メモを更新する。空文字列にするとエントリごと削除される。 */
	write(stateKey: string, text: string): void;

	/** 指定行のチェックボックスを反転する。対象行がチェックリストでなければ何もしない。 */
	toggleTask(stateKey: string, lineIndex: number): void;

	/** スペースが失われた (worktree 削除など) ときにメモも捨てる。 */
	remove(stateKey: string): void;
}
