// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { PATH_LINK_LIMITS, buildPathLinkBridgeScript, buildPathLinkCollectScript, buildPathLinkMarkScript, isOutsideSpaceRoot, isProsePath, parsePathLinkMessage, pathLinkFailureOf, pathLinkResolveOrder, pathLinksOf, spaceRootOf, type PathLinkCandidate } from './viewerPathLinks.js';

describe('pathLinksOf', () => {
	it('marks local links, whole-path code and strict prose paths only', () => {
		const candidates: PathLinkCandidate[] = [
			{ i: 0, k: 'a', t: 'docs/guide.md#L4' },
			{ i: 1, k: 'a', t: 'https://example.com/a.md' },
			{ i: 2, k: 'a', t: '#section' },
			{ i: 3, k: 'a', t: 'mailto:someone@example.com' },
			{ i: 8, k: 'a', t: '?tab=2' },
			{ i: 4, k: 'code', t: 'src/app.ts:12' },
			{ i: 5, k: 'code', t: 'npm run build' },
			{ i: 6, k: 'code', t: 'README.md' },
			{ i: 7, k: 'text', t: '変更は src/vs/a.ts と /var/log/app と ~/notes/todo.md です。and/or と https://example.com/x/y.ts は除く' },
		];
		const { links, marks } = pathLinksOf(candidates);
		expect({
			links: links.map(link => [link.source, link.written, link.target.path, link.target.line ?? null]),
			marks,
		}).toEqual({
			links: [
				['a', 'docs/guide.md#L4', 'docs/guide.md', 4],
				['code', 'src/app.ts:12', 'src/app.ts', 12],
				['code', 'README.md', 'README.md', null],
				['text', 'src/vs/a.ts', 'src/vs/a.ts', null],
				['text', '/var/log/app', '/var/log/app', null],
				['text', '~/notes/todo.md', '~/notes/todo.md', null],
			],
			marks: [
				{ i: 0, id: 0 },
				{ i: 4, id: 1 },
				{ i: 6, id: 2 },
				{ i: 7, id: 3, s: 4, e: 15 },
				{ i: 7, id: 4, s: 18, e: 30 },
				{ i: 7, id: 5, s: 33, e: 48 },
			],
		});
	});

	it('stops at the mark limit', () => {
		const many = Array.from({ length: PATH_LINK_LIMITS.marks + 5 }, (_, i): PathLinkCandidate => ({ i, k: 'code', t: `src/f${i}.ts` }));
		expect(pathLinksOf(many).marks.length).toBe(PATH_LINK_LIMITS.marks);
	});
});

describe('isProsePath', () => {
	it('accepts paths with a folder and an extension, or absolute and home paths', () => {
		expect(['src/a.ts', 'app/(group)/page.tsx', '/etc/hosts', '~/x', 'and/or', 'README.md', '1.2/3.4', 'a/b.'].map(isProsePath))
			.toEqual([true, true, true, true, false, false, false, false]);
	});
});

describe('pathLinkResolveOrder', () => {
	it('tries the document folder first for links and the space root first for code and prose', () => {
		expect([
			pathLinkResolveOrder('docs/report.md', { source: 'a', target: { path: 'img/chart.md' } }),
			pathLinkResolveOrder('docs/report.md', { source: 'code', target: { path: 'src/a.ts' } }),
			pathLinkResolveOrder('docs/report.md', { source: 'a', target: { path: '../src/a.ts' } }),
			pathLinkResolveOrder('report.md', { source: 'text', target: { path: 'src/a.ts' } }),
			pathLinkResolveOrder('docs/report.md', { source: 'text', target: { path: '/home/example/repo/a.ts' } }),
			pathLinkResolveOrder('docs/report.md', { source: 'text', target: { path: '~/a.ts' } }),
		]).toEqual([
			['docs/img/chart.md', 'img/chart.md'],
			['src/a.ts', 'docs/src/a.ts'],
			['src/a.ts'],
			['src/a.ts'],
			['/home/example/repo/a.ts'],
			[],
		]);
	});
});

describe('parsePathLinkMessage', () => {
	const token = 'token-0123456789abcdef';
	const secret = 'secret-0123456789abcdef';
	it('accepts only messages with the right secret, type and token', () => {
		const wrap = (body: object, key = secret) => JSON.stringify({ secret: key, body });
		const message = (body: object) => wrap({ type: 'paradisPathLinks', token, ...body });
		expect([
			parsePathLinkMessage(message({ op: 'tap', id: 2 }), token, secret),
			parsePathLinkMessage(message({ op: 'hold', id: 0 }), token, secret),
			parsePathLinkMessage(message({ op: 'candidates', items: [{ i: 0, k: 'a', t: 'a.md' }, { i: 'x', k: 'a', t: 'b' }, { i: 1, k: 'img', t: 'c' }] }), token, secret),
			parsePathLinkMessage(message({ op: 'tap', id: -1 }), token, secret),
			parsePathLinkMessage(message({ op: 'tap', id: PATH_LINK_LIMITS.marks }), token, secret),
			parsePathLinkMessage(wrap({ type: 'paradisPathLinks', token: 'other', op: 'tap', id: 1 }), token, secret),
			parsePathLinkMessage(wrap({ type: 'paradisFind', token, op: 'tap', id: 1 }), token, secret),
			parsePathLinkMessage('not json', token, secret),
			// ページが token を読んで直接送った「押した」（secret を知らない）
			parsePathLinkMessage(JSON.stringify({ type: 'paradisPathLinks', token, op: 'tap', id: 1 }), token, secret),
			parsePathLinkMessage(wrap({ type: 'paradisPathLinks', token, op: 'tap', id: 1 }, 'guessed'), token, secret),
		]).toEqual([
			{ op: 'tap', id: 2 },
			{ op: 'hold', id: 0 },
			{ op: 'candidates', items: [{ i: 0, k: 'a', t: 'a.md' }] },
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});
});

describe('spaceRootOf and isOutsideSpaceRoot', () => {
	it('derives the space root from the viewed file and tells absolute paths outside it', () => {
		const root = spaceRootOf('/home/example/repo/docs/report.md', 'docs/report.md');
		expect([
			root,
			spaceRootOf('/home/example/other/report.md', 'docs/report.md'),
			spaceRootOf('C:\\repo\\report.md', 'report.md'),
			isOutsideSpaceRoot('/var/log/app', '/home/example/repo'),
			isOutsideSpaceRoot('/home/example/repo2/a.ts', '/home/example/repo'),
			isOutsideSpaceRoot('/home/example/repo/src/a.ts', '/home/example/repo'),
			isOutsideSpaceRoot('src/a.ts', '/home/example/repo'),
		]).toEqual(['/home/example/repo', undefined, undefined, true, true, false, false]);
	});
});

describe('pathLinkFailureOf', () => {
	it('reads the PC refusal', () => {
		expect([pathLinkFailureOf('file link is outside the workspace'), pathLinkFailureOf('file link does not point to a file')]).toEqual(['outside', 'missing']);
	});
});

describe('path link scripts', () => {
	it('embed the token and marks without closing a script tag', () => {
		const collect = buildPathLinkCollectScript('t</script>', 's');
		const mark = buildPathLinkMarkScript('t', 's', [{ i: 0, id: 0 }], '#58a6ff');
		expect([collect.includes('</script>'), collect.includes('\\u003c/script>'), mark.includes('"marks":[{"i":0,"id":0}]')]).toEqual([false, true, true]);
	});

	it('send through a mouth the page cannot replace, and only for the caller that knows the secret', () => {
		const sent: string[] = [];
		const window: Record<string, unknown> = { ReactNativeWebView: { postMessage: (data: string) => sent.push(data) } };
		new Function('window', buildPathLinkBridgeScript('s3cret'))(window);
		const post = window.__paradisPathLinkPost as (key: string, json: string) => void;
		// ページは口を差し替えられず、secret を知らなければ送れない
		const replace = () => { window.__paradisPathLinkPost = () => sent.push('replaced'); };
		(window.ReactNativeWebView as { postMessage: unknown }).postMessage = (data: string) => sent.push(`sniffed:${data}`);
		post('guess', '{"op":"tap","id":1}');
		post('s3cret', '{"op":"tap","id":1}');
		expect(replace).toThrow(TypeError);
		expect([window.__paradisPathLinkPost === post, sent]).toEqual([true, ['{"secret":"s3cret","body":{"op":"tap","id":1}}']]);
	});
});
