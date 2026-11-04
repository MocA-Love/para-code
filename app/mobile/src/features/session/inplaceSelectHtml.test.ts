// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { NEUTRAL_CHAT_TEXT_SCALE } from '../../chatTextScale.js';
import { buildInplaceSelectHtml, inplaceSelectMinHeight, localPressPoint, parseInplaceSelectMessage, type InplaceSelectLook } from './inplaceSelectHtml.js';

const NONCE = 'abcdefghijklmnop0123';
const LOOK: InplaceSelectLook = {
	scale: NEUTRAL_CHAT_TEXT_SCALE,
	osFontScale: 1,
	hairline: 0.5,
	fg: '#e0e0e0',
	accent: '#3b82f6',
	accentWash: 'rgba(59,130,246,0.12)',
	selection: 'rgba(59,130,246,0.3)',
};

/** `<body>` の中の本文（スクリプトを除く）。 */
function bodyOf(html: string): string {
	return /<div id="m">(?<body>[\s\S]*)<\/div><script/.exec(html)?.groups?.body ?? '';
}

describe('buildInplaceSelectHtml', () => {
	it('renders the same blocks as the chat, with code and table structure', () => {
		const html = buildInplaceSelectHtml([{ text: '# 見出し\n本文 **太字** と `code`\n\n- 項目\n  - 子\n\n```ts\nconst a = 1;\n```\n\n| a | b |\n|---|--:|\n| 1 | 2 |\n\n> 引用\n\n---', markdown: true }], LOOK, NONCE);
		expect(bodyOf(html)).toBe([
			'<div class="seg">',
			'<div class="p h h1">見出し</div>',
			'<div class="p">本文 <span class="b">太字</span> と <span class="ic">code</span></div>',
			'<div class="bl" style="padding-left:0px"><div class="br"><span class="bm">•</span><div class="bb p">項目</div></div></div>',
			'<div class="bl" style="padding-left:16px"><div class="br"><span class="bm">◦</span><div class="bb p">子</div></div></div>',
			'<div class="cb"><div class="io"><span class="iol">ts</span><span class="ioa">折り返し</span><span class="ioa">コピー</span></div><div class="cc"><div class="ct">const a = 1;</div></div></div>',
			'<div class="tw"><table style="width:104px"><colgroup><col style="width:52px"><col style="width:52px"></colgroup><tr class="hd"><th>a</th><th class="ar">b</th></tr><tr><td>1</td><td class="ar">2</td></tr></table></div>',
			'<div class="q"><div class="qb"></div><div class="qc"><div class="p">引用</div></div></div>',
			'<div class="hr"></div>',
			'</div>',
		].join(''));
	});

	it('escapes message text and never turns links into navigable elements', () => {
		const html = buildInplaceSelectHtml([{ text: '<script>alert(1)</script> [x" onclick="y](https://example.com/?a=<b>) & `<i>`', markdown: true }], LOOK, NONCE);
		expect(bodyOf(html)).toBe('<div class="seg"><div class="p">&lt;script&gt;alert(1)&lt;/script&gt; <span class="a">x" onclick="y</span> &amp; <span class="ic">&lt;i&gt;</span></div></div>');
		expect(html).not.toContain('href');
		expect(html.match(/<script/g)).toHaveLength(1);
	});

	it('draws a user message as plain bubble text', () => {
		const html = buildInplaceSelectHtml([{ text: '**そのまま**\n<b>', markdown: false }], LOOK, NONCE);
		expect(bodyOf(html)).toBe('<div class="seg"><div class="u">**そのまま**\n&lt;b&gt;</div></div>');
	});

	it('puts local file links on their own card and keeps the surrounding text', () => {
		const html = buildInplaceSelectHtml([{ text: '前 [a.ts](src/a.ts#L3) 後', markdown: true }], LOOK, NONCE);
		expect(bodyOf(html)).toBe('<div class="seg"><div class="st"><div class="p">前 </div><div class="fc"><div class="fi"></div><div class="fn"><div class="fl">a.ts</div><div class="fp">src/a.ts · 行 3</div></div><div class="fv"></div></div><div class="p"> 後</div></div></div>');
	});

	it('allows only the nonce script and passes the press point as numbers', () => {
		const html = buildInplaceSelectHtml([{ text: 'a', markdown: true }], LOOK, NONCE, { x: 12.34, y: 5 });
		expect(html).toContain(`script-src 'nonce-${NONCE}'`);
		expect(html).toContain(`<script nonce="${NONCE}">`);
		expect(html).toContain('selectAt([12.34,5])');
		expect(buildInplaceSelectHtml([{ text: 'a', markdown: true }], LOOK, NONCE)).toContain('selectAt(null)');
		expect(() => buildInplaceSelectHtml([{ text: 'a', markdown: true }], LOOK, 'bad nonce"')).toThrow();
	});

	it('matches the chat sizes, including the OS text size and the chat text size setting', () => {
		const sizes = (look: InplaceSelectLook) => {
			const html = buildInplaceSelectHtml([{ text: 'a', markdown: true }], look, NONCE);
			return {
				body: /body \{[^}]*font-size: (?<v>[\d.]+)px; line-height: (?<l>[\d.]+)px/.exec(html)?.groups,
				gap: /#m, \.seg \{[^}]*gap: (?<v>[\d.]+)px/.exec(html)?.groups?.v,
				bubble: /\.u \{ font-size: (?<v>[\d.]+)px; line-height: (?<l>[\d.]+)px/.exec(html)?.groups,
			};
		};
		expect([
			sizes(LOOK),
			sizes({ ...LOOK, osFontScale: 1.2 }),
			sizes({ ...LOOK, scale: { font: 1.5 / 1.2, layout: 1.5 }, osFontScale: 1.2 }),
		]).toEqual([
			{ body: { v: '14', l: '20' }, gap: '6', bubble: { v: '17', l: '23' } },
			{ body: { v: '16.8', l: '24' }, gap: '6', bubble: { v: '20.4', l: '27.6' } },
			{ body: { v: '21', l: '30' }, gap: '7.5', bubble: { v: '25.5', l: '34.5' } },
		]);
	});

	it('keeps several segments in order for a later multi-message selection', () => {
		const html = buildInplaceSelectHtml([{ text: '一', markdown: true }, { text: '二', markdown: false }], LOOK, NONCE);
		expect(bodyOf(html)).toBe('<div class="seg"><div class="p">一</div></div><div class="seg"><div class="u">二</div></div>');
	});
});

describe('parseInplaceSelectMessage', () => {
	it('accepts only ready / height with a positive height and clamps it', () => {
		expect([
			parseInplaceSelectMessage('{"type":"ready","height":120.2}'),
			parseInplaceSelectMessage('{"type":"height","height":9999999}'),
			parseInplaceSelectMessage('{"type":"other","height":10}'),
			parseInplaceSelectMessage('{"type":"height","height":-1}'),
			parseInplaceSelectMessage('{"type":"height","height":"10"}'),
			parseInplaceSelectMessage('not json'),
			parseInplaceSelectMessage(42),
		]).toEqual([
			{ kind: 'ready', height: 121 },
			{ kind: 'height', height: 200000 },
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});
});

describe('inplaceSelectMinHeight', () => {
	it('grows the row only when the web view is taller than the native view', () => {
		expect([
			inplaceSelectMinHeight(100, undefined),
			inplaceSelectMinHeight(100, 100.4),
			inplaceSelectMinHeight(100, 90),
			inplaceSelectMinHeight(100, 130),
			inplaceSelectMinHeight(undefined, 80),
		]).toEqual([undefined, undefined, undefined, 130, 80]);
	});
});

describe('localPressPoint', () => {
	const frame = { pageX: 20, pageY: 100, width: 300, height: 200 };
	it('turns the last touch into a point inside the message, ignoring stale or outside touches', () => {
		expect([
			localPressPoint({ pageX: 50.06, pageY: 150, at: 1000 }, frame, 2000),
			localPressPoint({ pageX: 50, pageY: 150, at: 1000 }, frame, 20_000),
			localPressPoint({ pageX: 10, pageY: 150, at: 1000 }, frame, 2000),
			localPressPoint({ pageX: 50, pageY: 400, at: 1000 }, frame, 2000),
			localPressPoint(undefined, frame, 2000),
		]).toEqual([{ x: 30.1, y: 50 }, undefined, undefined, undefined, undefined]);
	});
});
