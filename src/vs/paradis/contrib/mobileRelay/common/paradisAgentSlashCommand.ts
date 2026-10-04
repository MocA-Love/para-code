/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments and messages)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイルから送るスラッシュコマンドの読み取りと、エージェントが「そのコマンドは無い」と断ったことの見分け。
//
// - Claude Code（2.1.289 で実測）: 画面に `Unknown command: /x` が出て、入力欄は空になる。何も実行されない。
//   transcript にも `type: system`・`subtype: informational` の行で残るので、そちらで確かめる（paradisMobileAgentChat.ts）
// - Codex（0.160.0 で実測）: 画面に `Unrecognized command '/x'. Type "/" for a list of supported commands.` が出て、
//   入力欄に文字が残る（次の発言とつながってモデルへ届く）。transcript には残らないので、所有ウィンドウが画面を読む。
//   残った文字は消さない: Ctrl+C は空にできるが、空にした直後にもう一度押されると Codex が終わる（実測）。Ctrl+U・
//   Esc は効かず、Ctrl+A / Ctrl+K と Backspace はカーソルの位置と行に左右されて全部を消せない（実測）。代わりに
//   アプリへ「PC の入力欄に文字が残っています」と伝える

/** 送る文の先頭のスラッシュコマンド（`/name args`）。パス（`/Users/...`）や `/` だけの文は undefined。 */
export interface IParadisSlashCommand {
	readonly name: string;
	readonly args: string;
}

/** スラッシュコマンドの名前（Claude Code の plugin・MCP の prompt を含む）。 */
const SLASH_NAME_PATTERN = /^\/([A-Za-z0-9_][A-Za-z0-9_.:-]{0,127})(?=\s|$)/;
const COMMAND_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;

/** 断られたことを知らせる action-result の code（アプリは理由を入力欄の上に出し、文を入力欄へ戻す）。 */
export const PARADIS_SLASH_COMMAND_REJECTED_CODE = 'unknown-command';

/** 画面を読んで断りを探す時間。Enter から数百ミリ秒で出る（実測）ので、余裕を見る。 */
export const PARADIS_SLASH_REJECTION_WAIT_MS = 1_200;
export const PARADIS_SLASH_REJECTION_POLL_MS = 150;

export function paradisParseSlashCommand(text: string): IParadisSlashCommand | undefined {
	const trimmed = text.trimStart();
	const match = SLASH_NAME_PATTERN.exec(trimmed);
	if (match === null) {
		return undefined;
	}
	return { name: match[1], args: trimmed.slice(match[0].length).trim() };
}

/** shared process が所有ウィンドウへ添える、スラッシュコマンドの断りを確かめる頼み（`slashCheck`）。 */
export interface IParadisSlashCheck {
	readonly agent: 'claude' | 'codex';
	readonly command: string;
}

/** `slashCheck` を読む（形が合わなければ undefined。確かめずに今までどおり受け付ける）。 */
export function paradisReadSlashCheck(value: unknown): IParadisSlashCheck | undefined {
	const record = typeof value === 'object' && value !== null ? value as { agent?: unknown; command?: unknown } : undefined;
	return record !== undefined && (record.agent === 'claude' || record.agent === 'codex') && typeof record.command === 'string'
		&& COMMAND_NAME_PATTERN.test(record.command)
		? { agent: record.agent, command: record.command }
		: undefined;
}

/** エージェントが画面に出す「そのコマンドは無い」の行。 */
function rejectionLine(agent: 'claude' | 'codex', name: string): string {
	return agent === 'codex' ? `Unrecognized command '/${name}'` : `Unknown command: /${name}`;
}

/** 改行と行頭の空白を除く（狭いペインで折り返した行を 1 本につなぐ。折り返しの境目の空白も揃えて無視する）。 */
function joinWrapped(screen: string): string {
	return screen.replace(/\s+/g, '');
}

function countOccurrences(screen: string, needle: string, nameEnds: boolean): number {
	let count = 0;
	for (let index = screen.indexOf(needle); index >= 0; index = screen.indexOf(needle, index + needle.length)) {
		// 行が名前で終わる形（Claude Code）は、`/name` の後に名前の続きが来るもの（`/names`）を別のコマンドとみなす
		const next = screen.charAt(index + needle.length);
		if (!nameEnds || next === '' || !/[A-Za-z0-9_.:-]/.test(next)) {
			count++;
		}
	}
	return count;
}

/**
 * 送る前（`before`）より送った後（`after`）の画面に「そのコマンドは無い」の行が増えていれば true。
 * 前から同じ行が出ていても、数が増えたときだけ今回の断りとみなす。折り返した行も見つけるよう、空白を除いて比べる。
 */
export function paradisSlashCommandRejected(agent: 'claude' | 'codex', name: string, before: string, after: string): boolean {
	const line = joinWrapped(rejectionLine(agent, name));
	const nameEnds = agent === 'claude';
	return countOccurrences(joinWrapped(after), line, nameEnds) > countOccurrences(joinWrapped(before), line, nameEnds);
}

/**
 * Codex の入力欄（`\u203A` で始まる最後の行）に、断られたコマンドの文字がまだ残っているか。`/name` の直後が空白か
 * 行末のときだけ（`/name2` のような別の名前は数えない）。狭いペインで入力欄の行が折り返していても、続きの行の行頭の
 * 空白を除いてつないで見る。
 */
export function paradisCodexComposerHoldsCommand(screen: string, name: string): boolean {
	const lines = screen.split('\n');
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index].trimStart();
		if (!line.startsWith('\u203A')) {
			continue;
		}
		const rest = [line.slice(1).trimStart(), ...lines.slice(index + 1).map(next => next.trimStart())].join('\n');
		let position = 0;
		for (const char of `/${name}`) {
			// 名前の途中で折り返した境目は飛ばす
			while (rest.charAt(position) === '\n') {
				position++;
			}
			if (rest.charAt(position) !== char) {
				return false;
			}
			position++;
		}
		const next = rest.charAt(position);
		return next === '' || /\s/.test(next);
	}
	return false;
}

/**
 * 断られたコマンドの文字が Codex の入力欄に残っている（消すキーが無いので消さない）。アプリは理由と、端末の画面へ
 * 移って消すボタンを出す。残っている間に届いた次の発言は、キーで打たずにこれで断る（つながってモデルへ届かないように）。
 */
export const PARADIS_COMPOSER_NOT_EMPTY_CODE = 'composer-not-empty';

/** 前に断られた文字が残っている間に届いた発言への断り。 */
export const PARADIS_COMPOSER_NOT_EMPTY_MESSAGE = 'PC の Codex の入力欄に、前に送ったコマンドの文字が残っています。端末を開いて消してから送り直してください';

/** 断りの文に足す、PC の入力欄に文字が残っていることの知らせ（Codex。消さないので）。 */
export const PARADIS_SLASH_LEFT_IN_COMPOSER = '。PC の入力欄に文字が残っています。端末を開いて消してから送り直してください';

/** アプリへ返す断りの文。 */
export function paradisSlashRejectionMessage(agent: 'claude' | 'codex', name: string, reason?: string): string {
	const label = agent === 'codex' ? 'Codex' : 'Claude Code';
	return reason !== undefined && reason.trim().length > 0
		? `${label} が /${name} を実行しませんでした（${reason.trim().slice(0, 300)}）`
		: `${label} に /${name} というコマンドはありません`;
}
