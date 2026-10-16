/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/*
 * Codex の config.toml を 1 行ずつ読むための小さな道具（コメント・引用・複数行の文字列を見分ける）。
 * 何も import しない。タスクボード（app/taskboard）のサーバーも同じものを使うため（vs/base を持ち込めない）。
 */

export type MultilineDelimiter = '"""' | '\x27\x27\x27';

export interface ICommentScanResult {
	readonly code: string;
	readonly multiline?: MultilineDelimiter;
}

function findMultilineClose(line: string, start: number, delimiter: MultilineDelimiter): number {
	const quote = delimiter[0];
	let cursor = start;
	while (cursor < line.length) {
		const runStart = line.indexOf(quote, cursor);
		if (runStart < 0) {
			return -1;
		}
		let runEnd = runStart;
		while (line[runEnd] === quote) {
			runEnd++;
		}
		let escapedPrefix = 0;
		if (delimiter === '"""') {
			let backslashes = 0;
			for (let index = runStart - 1; index >= 0 && line[index] === '\\'; index--) {
				backslashes++;
			}
			escapedPrefix = backslashes % 2;
		}
		if (runEnd - runStart - escapedPrefix >= 3) {
			return runEnd - 3;
		}
		cursor = runEnd;
	}
	return -1;
}

export function scanTomlLine(line: string, initialMultiline?: MultilineDelimiter): ICommentScanResult {
	let multiline = initialMultiline;
	let code = '';
	let index = 0;
	while (index < line.length) {
		if (multiline !== undefined) {
			const closing = findMultilineClose(line, index, multiline);
			if (closing < 0) {
				return { code, multiline };
			}
			index = closing + multiline.length;
			multiline = undefined;
			continue;
		}
		const char = line[index];
		if (char === '#') {
			break;
		}
		if (line.startsWith('"""', index) || line.startsWith('\x27\x27\x27', index)) {
			multiline = line.slice(index, index + 3) as MultilineDelimiter;
			index += 3;
			continue;
		}
		if (char === '"' || char === '\x27') {
			const quote = char;
			code += char;
			index++;
			while (index < line.length) {
				const quoted = line[index];
				code += quoted;
				index++;
				if (quote === '"' && quoted === '\\' && index < line.length) {
					code += line[index];
					index++;
					continue;
				}
				if (quoted === quote) {
					break;
				}
			}
			continue;
		}
		code += char;
		index++;
	}
	return { code, multiline };
}

function decodeBasicKey(source: string): string | undefined {
	try {
		const decoded = JSON.parse(source);
		return typeof decoded === 'string' ? decoded : undefined;
	} catch {
		return undefined;
	}
}

export function parseTomlKeyPath(source: string): readonly string[] | undefined {
	const result: string[] = [];
	let index = 0;
	const skipSpace = () => {
		while (index < source.length && /\s/.test(source[index])) {
			index++;
		}
	};
	skipSpace();
	while (index < source.length) {
		let key: string | undefined;
		if (source[index] === '"') {
			const start = index++;
			while (index < source.length) {
				if (source[index] === '\\') {
					index += 2;
					continue;
				}
				if (source[index++] === '"') {
					key = decodeBasicKey(source.slice(start, index));
					break;
				}
			}
		} else if (source[index] === '\x27') {
			const end = source.indexOf('\x27', index + 1);
			if (end >= 0) {
				key = source.slice(index + 1, end);
				index = end + 1;
			}
		} else {
			const match = /^[A-Za-z0-9_-]+/.exec(source.slice(index));
			if (match !== null) {
				key = match[0];
				index += match[0].length;
			}
		}
		if (key === undefined) {
			return undefined;
		}
		result.push(key);
		skipSpace();
		if (index === source.length) {
			return result;
		}
		if (source[index] !== '.') {
			return undefined;
		}
		index++;
		skipSpace();
	}
	return undefined;
}

/** 引用の外にある最初の `=` の位置（キーと値の境目）。無ければ -1。 */
export function findTomlAssignment(code: string): number {
	let quote: '"' | '\x27' | undefined;
	for (let index = 0; index < code.length; index++) {
		const char = code[index];
		if (quote !== undefined) {
			if (quote === '"' && char === '\\') {
				index++;
			} else if (char === quote) {
				quote = undefined;
			}
			continue;
		}
		if (char === '"' || char === '\x27') {
			quote = char;
		} else if (char === '=') {
			return index;
		}
	}
	return -1;
}
