// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { FIND_MATCH_LIMIT, buildFindScript, findCountLabel, findTargetOf, normalizeFindQuery, parseFindMessage, stepFindIndex, viewerScriptContentSecurityPolicy } from './fileFind.js';
import { buildCodeHtml, buildMarkdownHtml } from './fileViewerModel.js';

const TOKEN = 'abcdef0123456789abcdef0123456789';
const message = (fields: Record<string, unknown>) => JSON.stringify({ type: 'paradisFind', token: TOKEN, seq: 3, count: 5, index: 1, capped: false, ...fields });

describe('findTargetOf', () => {
	test('画像・動画・PDF は探せず、コードは行番号を除いて探す', () => {
		expect({
			pdf: findTargetOf('pdf', 'render'),
			image: findTargetOf('image', 'render'),
			av: findTargetOf('av', 'render'),
			code: findTargetOf('other', 'code'),
			markdownSource: findTargetOf('markdown', 'code'),
			markdown: findTargetOf('markdown', 'render'),
			html: findTargetOf('html', 'render'),
			spreadsheet: findTargetOf('spreadsheet', 'render'),
			docx: findTargetOf('docx', 'render'),
		}).toEqual({
			pdf: undefined,
			image: undefined,
			av: undefined,
			code: { root: '.src', exclude: '.l > i' },
			markdownSource: { root: '.src', exclude: '.l > i' },
			markdown: {},
			html: {},
			spreadsheet: {},
			docx: { root: '#content', waitFor: '#status' },
		});
	});
});

describe('buildFindScript', () => {
	test('文字列として正しい JS で、語の `</script>` で閉じられない', () => {
		const script = buildFindScript({ op: 'search', query: '</script><b>"\'\u2028', index: 0 }, { token: TOKEN, seq: 1, target: { root: '.src', exclude: '.l > i' } });
		expect({
			parses: (() => { new Function(script); return true; })(),
			closesTag: script.includes('</script>'),
			endsTrue: script.trimEnd().endsWith('true;\n})();'),
		}).toEqual({ parses: true, closesTag: false, endsTrue: true });
	});

	test('select と clear も同じ形で作れる', () => {
		for (const command of [{ op: 'select', index: 2 }, { op: 'clear' }] as const) {
			expect(() => new Function(buildFindScript(command, { token: TOKEN, seq: 2, target: {} }))).not.toThrow();
		}
	});
});

describe('parseFindMessage', () => {
	test('合言葉・形が合うものだけを結果として読む', () => {
		expect([
			parseFindMessage(message({}), TOKEN),
			parseFindMessage(message({ count: 0, index: -1 }), TOKEN),
			parseFindMessage(message({ count: FIND_MATCH_LIMIT, index: 0, capped: true }), TOKEN),
		]).toEqual([
			{ seq: 3, count: 5, index: 1, capped: false },
			{ seq: 3, count: 0, index: -1, capped: false },
			{ seq: 3, count: FIND_MATCH_LIMIT, index: 0, capped: true },
		]);
	});

	test('ページが送った別のメッセージや偽物は捨てる', () => {
		expect([
			parseFindMessage('not json', TOKEN),
			parseFindMessage('[1]', TOKEN),
			parseFindMessage(JSON.stringify({ type: 'paradisOfficeRecovery', generation: 1 }), TOKEN),
			parseFindMessage(message({ token: 'other' }), TOKEN),
			parseFindMessage(message({ count: FIND_MATCH_LIMIT + 1 }), TOKEN),
			parseFindMessage(message({ index: 5 }), TOKEN),
			parseFindMessage(message({ count: 0, index: 0 }), TOKEN),
			parseFindMessage(message({ count: 2, index: -1 }), TOKEN),
			parseFindMessage(message({ count: 1.5 }), TOKEN),
			parseFindMessage(message({ seq: -1 }), TOKEN),
			parseFindMessage(message({ capped: 'no' }), TOKEN),
		].every(result => result === undefined)).toBe(true);
	});
});

describe('件数と移動', () => {
	test('前後へ動くと端で反対の端へ回り、一致が無ければ動かない', () => {
		const result = { seq: 1, count: 3, index: 2, capped: false };
		expect([
			stepFindIndex(result, 1),
			stepFindIndex(result, -1),
			stepFindIndex({ ...result, index: 0 }, -1),
			stepFindIndex({ ...result, count: 0, index: -1 }, 1),
			stepFindIndex(undefined, 1),
		]).toEqual([0, 1, 2, -1, -1]);
	});

	test('欄の右の件数', () => {
		const result = { seq: 1, count: 5, index: 1, capped: false };
		expect([
			findCountLabel('', result),
			findCountLabel('a', undefined),
			findCountLabel('a', result),
			findCountLabel('a', { ...result, count: 0, index: -1 }),
			findCountLabel('a', { ...result, capped: true }),
		]).toEqual(['', '', '2 / 5', '0 件', '2 / 5+']);
	});

	test('改行は空白にして探す', () => {
		expect(normalizeFindQuery('a\r\nb\nc ')).toBe('a b c ');
	});
});

describe('コードと Markdown の CSP', () => {
	const NONCE = '0123456789abcdef0123456789abcdef';

	test('自分のスクリプトだけを許し、フレームと埋め込みを止める', () => {
		expect(viewerScriptContentSecurityPolicy(NONCE)).toBe(`script-src 'nonce-${NONCE}'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'`);
		expect(() => viewerScriptContentSecurityPolicy('bad"nonce')).toThrow();
	});

	test('nonce を渡すと CSP を head の先頭に置き、一致行のスクリプトにだけ nonce を付ける', () => {
		const html = buildCodeHtml({ content: 'a\nb', truncated: false, size: 3 }, 2, undefined, NONCE);
		expect({
			cspFirst: html.indexOf('<head><meta http-equiv="Content-Security-Policy"') >= 0,
			nonceScript: html.includes(`<script nonce="${NONCE}">`),
		}).toEqual({ cspFirst: true, nonceScript: true });
	});

	test('Markdown の本文に混ざったスクリプトには nonce を付けない', () => {
		const html = buildMarkdownHtml({ content: '# t\n\n<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">' }, undefined, NONCE);
		expect({
			csp: html.startsWith(`<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="script-src 'nonce-${NONCE}';`),
			rawScriptKeptWithoutNonce: html.includes('<script>alert(1)</script>'),
			noncedScripts: html.split(`nonce="${NONCE}"`).length - 1,
		}).toEqual({ csp: true, rawScriptKeptWithoutNonce: true, noncedScripts: 0 });
	});

	test('nonce を渡さなければ今までどおり（CSP を付けない）', () => {
		expect(buildCodeHtml({ content: 'a', truncated: false, size: 1 }).includes('Content-Security-Policy')).toBe(false);
	});
});
