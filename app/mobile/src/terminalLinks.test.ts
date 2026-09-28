// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { findTerminalLinkAt, findTerminalLinks, terminalOsc8Link, terminalUrlDestination } from './terminalLinks.js';

/** 見つかったリンクを、比べやすい形（種類・中身・元の文字列）にする。 */
function describeLinks(text: string) {
	return findTerminalLinks(text).map(link => link.kind === 'url'
		? { url: link.url, text: text.slice(link.start, link.end) }
		: { file: link.target, text: text.slice(link.start, link.end) });
}

describe('findTerminalLinks', () => {
	it('finds URLs and file paths with their line and column', () => {
		expect(describeLinks('Server ready at http://localhost:3000/app. Edited src/app.ts:42:7 and README.md')).toEqual([
			{ url: 'http://localhost:3000/app', text: 'http://localhost:3000/app' },
			{ file: { path: 'src/app.ts', line: 42, column: 7 }, text: 'src/app.ts:42:7' },
			{ file: { path: 'README.md' }, text: 'README.md' },
		]);
	});

	it('trims quotes, brackets and punctuation around a link but keeps balanced parentheses', () => {
		expect(describeLinks('File "src/a.py", line 3 (see https://example.com/x_(y)). app/(group)/page.tsx:9:')).toEqual([
			{ file: { path: 'src/a.py' }, text: 'src/a.py' },
			{ url: 'https://example.com/x_(y)', text: 'https://example.com/x_(y)' },
			{ file: { path: 'app/(group)/page.tsx', line: 9 }, text: 'app/(group)/page.tsx:9' },
		]);
	});

	it('reads the TypeScript error location and the #L form', () => {
		expect(describeLinks('src/a.ts(12,5): error TS2322 ./lib/b.ts#L4C2')).toEqual([
			{ file: { path: 'src/a.ts', line: 12, column: 5 }, text: 'src/a.ts(12,5)' },
			{ file: { path: './lib/b.ts', line: 4, column: 2 }, text: './lib/b.ts#L4C2' },
		]);
	});

	it('does not take version numbers, bare words or the path part of a URL', () => {
		expect(describeLinks('v1.2.3 released 3.14 done https://github.com/o/r/blob/main/src/a.ts ok')).toEqual([
			{ url: 'https://github.com/o/r/blob/main/src/a.ts', text: 'https://github.com/o/r/blob/main/src/a.ts' },
		]);
	});

	it('stops a URL at full-width punctuation', () => {
		expect(describeLinks('詳細はhttps://example.com/docs。次へ')).toEqual([
			{ url: 'https://example.com/docs', text: 'https://example.com/docs' },
		]);
	});

	it('finds absolute and home-relative paths', () => {
		expect(describeLinks('at /Users/example/project/src/index.ts:10 and ~/notes/todo.md')).toEqual([
			{ file: { path: '/Users/example/project/src/index.ts', line: 10 }, text: '/Users/example/project/src/index.ts:10' },
			{ file: { path: '~/notes/todo.md' }, text: '~/notes/todo.md' },
		]);
	});
});

describe('findTerminalLinkAt', () => {
	it('returns the link under the tapped character and nothing between links', () => {
		const text = 'open src/app.ts:4 or http://127.0.0.1:8080';
		expect({
			onPath: findTerminalLinkAt(text, text.indexOf('app')),
			between: findTerminalLinkAt(text, text.indexOf(' or ') + 1),
			onUrl: findTerminalLinkAt(text, text.length - 1),
			outside: findTerminalLinkAt(text, text.length),
		}).toEqual({
			onPath: { kind: 'file', target: { path: 'src/app.ts', line: 4 }, start: 5, end: 17 },
			between: undefined,
			onUrl: { kind: 'url', url: 'http://127.0.0.1:8080', start: 21, end: 42 },
			outside: undefined,
		});
	});
});

describe('terminalUrlDestination', () => {
	it('opens local and private addresses on the PC and everything else in Safari', () => {
		const urls = [
			'http://localhost:3000', 'http://app.localhost/', 'http://127.0.0.1:8080/x', 'http://0.0.0.0:5173',
			'http://10.0.0.5', 'http://172.20.1.1', 'http://192.168.1.10:8000', 'http://169.254.1.1',
			'http://100.101.102.103', 'http://[::1]:3000', 'http://[fd12::1]/', 'http://devbox:8080', 'http://printer.local',
			'https://example.com', 'http://172.32.0.1', 'https://user:pass@github.com/o/r', 'http://8.8.8.8',
			'javascript:alert(1)', 'ftp://example.com',
		];
		expect(Object.fromEntries(urls.map(url => [url, terminalUrlDestination(url)]))).toEqual({
			'http://localhost:3000': 'pc', 'http://app.localhost/': 'pc', 'http://127.0.0.1:8080/x': 'pc', 'http://0.0.0.0:5173': 'pc',
			'http://10.0.0.5': 'pc', 'http://172.20.1.1': 'pc', 'http://192.168.1.10:8000': 'pc', 'http://169.254.1.1': 'pc',
			'http://100.101.102.103': 'pc', 'http://[::1]:3000': 'pc', 'http://[fd12::1]/': 'pc', 'http://devbox:8080': 'pc', 'http://printer.local': 'pc',
			'https://example.com': 'external', 'http://172.32.0.1': 'external', 'https://user:pass@github.com/o/r': 'external', 'http://8.8.8.8': 'external',
			'javascript:alert(1)': undefined, 'ftp://example.com': undefined,
		});
	});
});

describe('terminalOsc8Link', () => {
	it('opens http(s) and file URIs and ignores other schemes', () => {
		expect([
			terminalOsc8Link('https://example.com/pr/1'),
			terminalOsc8Link('file:///Users/example/project/src/a.ts#L3'),
			terminalOsc8Link('javascript:alert(1)'),
		]).toEqual([
			{ kind: 'url', url: 'https://example.com/pr/1' },
			{ kind: 'file', target: { path: '/Users/example/project/src/a.ts', line: 3 } },
			undefined,
		]);
	});
});
