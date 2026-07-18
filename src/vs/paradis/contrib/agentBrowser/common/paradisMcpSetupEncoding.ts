/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH comments)

// PARA-CODE: MCPセットアップの自動設定と手動スニペットで共有する、注入耐性のあるpure encoder。

export type ParadisMcpTomlSectionInspection = 'present' | 'absent' | 'ambiguous';

/** TOML basic string。制御文字をrawで残さず、非scalarなlone surrogateは拒否する。 */
export function encodeParadisTomlBasicString(value: string): string {
	let result = '"';
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xD800 && code <= 0xDBFF) {
			const low = value.charCodeAt(index + 1);
			if (!Number.isFinite(low) || low < 0xDC00 || low > 0xDFFF) {
				throw new Error('TOML string contains an unpaired surrogate');
			}
			result += value[index] + value[index + 1];
			index++;
			continue;
		}
		if (code >= 0xDC00 && code <= 0xDFFF) {
			throw new Error('TOML string contains an unpaired surrogate');
		}
		switch (code) {
			case 0x08: result += '\\b'; break;
			case 0x09: result += '\\t'; break;
			case 0x0A: result += '\\n'; break;
			case 0x0C: result += '\\f'; break;
			case 0x0D: result += '\\r'; break;
			case 0x22: result += '\\"'; break;
			case 0x5C: result += '\\\\'; break;
			default:
				if (code <= 0x1F || code === 0x7F) {
					result += `\\u${code.toString(16).padStart(4, '0')}`;
				} else {
					result += value[index];
				}
		}
	}
	return `${result}"`;
}

/** POSIX shellへ貼る手動スニペット用。値全体を1つのliteral argvに固定する。 */
export function encodeParadisPosixShellArgument(value: string): string {
	if (value.includes('\0')) {
		throw new Error('Shell argument contains NUL');
	}
	const quote = String.fromCharCode(0x27);
	return `${quote}${value.replaceAll(quote, `${quote}\\${quote}${quote}`)}${quote}`;
}

/** PowerShell single-quoted string。cmd.exe用ではない。 */
export function encodeParadisPowerShellArgument(value: string): string {
	if (value.includes('\0')) {
		throw new Error('PowerShell argument contains NUL');
	}
	const quote = String.fromCharCode(0x27);
	return `${quote}${value.replaceAll(quote, `${quote}${quote}`)}${quote}`;
}

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

function couldDefineMcpServers(code: string): boolean {
	return /(^|[\[\s])mcp_servers(?:\s|\.|=|\]|$)/.test(code);
}

function findTomlAssignment(code: string): number {
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

/**
 * para-browser tableが既にあるかを安全側に分類する。TOML全体を再実装せず、
 * mcp_serversに触れる曖昧な構文では自動追記を停止する。
 */
export function inspectParadisMcpTomlSection(source: string): ParadisMcpTomlSectionInspection {
	let multiline: MultilineDelimiter | undefined;
	for (const line of source.split(/\r?\n/)) {
		const scanned = scanTomlLine(line, multiline);
		multiline = scanned.multiline;
		const code = scanned.code.trim();
		if (code.length === 0) {
			continue;
		}
		if (code.startsWith('[[')) {
			if (!code.endsWith(']]')) {
				return 'ambiguous';
			}
			const path = parseTomlKeyPath(code.slice(2, -2));
			if (path === undefined || path[0] === 'mcp_servers') {
				return 'ambiguous';
			}
			continue;
		}
		if (code.startsWith('[')) {
			const close = code.lastIndexOf(']');
			if (close <= 0 || code.slice(close + 1).trim().length > 0) {
				return 'ambiguous';
			}
			const path = parseTomlKeyPath(code.slice(1, close));
			if (path?.[0] !== 'mcp_servers') {
				if (path === undefined) {
					return 'ambiguous';
				}
				continue;
			}
			if (path.length === 2 && path[1] === 'para-browser') {
				return 'present';
			}
			return 'ambiguous';
		}
		const assignment = findTomlAssignment(code);
		const assignmentPath = assignment >= 0 ? parseTomlKeyPath(code.slice(0, assignment)) : undefined;
		if (assignmentPath?.[0] === 'mcp_servers'
			|| (assignmentPath === undefined && (couldDefineMcpServers(code) || /["']mcp_servers["']/.test(code)))) {
			return 'ambiguous';
		}
	}
	return multiline === undefined ? 'absent' : 'ambiguous';
}
