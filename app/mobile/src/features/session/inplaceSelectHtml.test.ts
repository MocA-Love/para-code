// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { NEUTRAL_CHAT_TEXT_SCALE } from '../../chatTextScale.js';
import { buildInplaceSelectHtml, inplaceSelectContentSecurityPolicy, inplaceSelectMinHeight, safeColor, inplaceSelectStartScript, localPressPoint, parseInplaceSelectMessage, type InplaceSelectLook } from './inplaceSelectHtml.js';

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

	it('draws table cells at the body size the chat table actually shows (14/20), so rows below do not move', () => {
		const html = buildInplaceSelectHtml([{ text: '| a |\n|---|\n| 1 |', markdown: true }], LOOK, NONCE);
		expect(html).toContain('th, td { box-sizing: border-box; padding: 5px 7px; font-size: 14px; line-height: 20px;');
	});

	it('escapes message text and never turns links into navigable elements', () => {
		const html = buildInplaceSelectHtml([{ text: '<script>alert(1)</script> [x" onclick="y](https://example.com/?a=<b>) & `<i>`', markdown: true }], LOOK, NONCE);
		expect(bodyOf(html)).toBe('<div class="seg"><div class="p">&lt;script&gt;alert(1)&lt;/script&gt; <span class="a">x" onclick="y</span> &amp; <span class="ic">&lt;i&gt;</span></div></div>');
		expect(html).not.toContain('href');
		expect(html.match(/<script/g)).toHaveLength(1);
	});

	it('colors code from the highlight the chat already has, and drops colors that could break out of the attribute', () => {
		const look: InplaceSelectLook = {
			...LOOK,
			codeHighlight: (text, lang) => text === 'const a = 1;' && lang === 'ts'
				? { bg: '#1e1e1e', fg: '#d4d4d4', lines: [[{ text: 'const', color: '#569cd6', bold: true }, { text: ' a = ' }, { text: '1', color: 'red;" onload="x' }, { text: ';', italic: true }]] }
				: undefined,
		};
		const html = buildInplaceSelectHtml([{ text: '```ts\nconst a = 1;\n```\n\n```\n<plain>\n```', markdown: true }], look, NONCE);
		expect(bodyOf(html)).toBe([
			'<div class="seg">',
			'<div class="cb" style="background:#1e1e1e"><div class="io"><span class="iol">ts</span><span class="ioa">折り返し</span><span class="ioa">コピー</span></div>',
			'<div class="cc"><div class="ct" style="color:#d4d4d4"><span class="cbd" style="color:#569cd6">const</span> a = 1<span class="ci">;</span></div></div></div>',
			'<div class="cb"><div class="io"><span class="iol">コード</span><span class="ioa">折り返し</span><span class="ioa">コピー</span></div><div class="cc"><div class="ct">&lt;plain&gt;</div></div></div>',
			'</div>',
		].join(''));
	});

	it('accepts only color shapes, never url(), var() or expression', () => {
		const inputs = ['#569cd6', '#FFF', '#11223344', 'rgb(1, 2, 3)', 'rgba(59,130,246,0.12)', 'hsl(210 50% 40% / 0.5)', 'red', ' #abc ',
			'url(x)', 'URL(https://e.com/a.png)', 'var(--x)', 'expression(alert(1))', 'Expression', 'red;" onload="x', 'rgb(url(x))', 'calc(1px)', '#12', 'image-set(a)', ''];
		expect(inputs.map(safeColor)).toEqual(['#569cd6', '#FFF', '#11223344', 'rgb(1, 2, 3)', 'rgba(59,130,246,0.12)', 'hsl(210 50% 40% / 0.5)', 'red', '#abc',
			undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
		const html = buildInplaceSelectHtml([{ text: '```ts\na\n```', markdown: true }], { ...LOOK, codeHighlight: () => ({ bg: 'url(https://e.com/x.png)', fg: 'var(--x)', lines: [[{ text: 'a', color: 'expression(1)' }]] }) }, NONCE);
		expect(html).not.toMatch(/url\(|var\(|expression/);
	});

	it('blocks everything by default and opens only the nonce script and inline styles', () => {
		const html = buildInplaceSelectHtml([{ text: 'a', markdown: true }], LOOK, NONCE);
		const csp = inplaceSelectContentSecurityPolicy(NONCE);
		expect({ csp, inHead: html.startsWith(`<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}">`) }).toEqual({
			csp: `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${NONCE}'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'`,
			inHead: true,
		});
		expect(() => inplaceSelectContentSecurityPolicy('bad nonce"')).toThrow();
	});

	it('lays several messages out to scroll, with labels that are not copied, and scrolls the pressed one into its old place', () => {
		const html = buildInplaceSelectHtml(
			[{ text: '前の発言', markdown: false, label: 'あなた' }, { text: '押した発言', markdown: true, label: 'エージェント' }],
			LOOK, NONCE, { x: 10, y: 20 }, { anchor: 1, top: 120.5, left: 16, width: 343, pad: 600 },
		);
		expect({
			body: /<\/style>\n<\/head><body>(?<body>[\s\S]*)<script/.exec(html)?.groups?.body,
			place: html.includes('var lay=[1,120.5];'),
			// 押した点が取れないとき（iPad の右クリックなど）は、並べた全部ではなく押した発言の本文だけを選ぶ
			fallback: html.includes("var el=lay?root.querySelectorAll('.seg')[lay[0]]:null;"),
			label: html.includes('.sp {') && /\.sp \{[^}]*user-select: none/.test(html),
		}).toEqual({
			body: '<div id="m" class="across" style="padding:600px 0;margin-left:16px;width:343px"><div class="seg"><div class="sp">あなた</div><div class="u">前の発言</div></div><div class="seg"><div class="sp">エージェント</div><div class="p">押した発言</div></div></div>',
			place: true,
			fallback: true,
			label: true,
		});
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

	it('waits to select until the caller has shown and focused the web view, then selects the word or the whole message', () => {
		const html = buildInplaceSelectHtml([{ text: 'a', markdown: true }], LOOK, NONCE, { x: 1, y: 2 });
		const ready = html.slice(html.indexOf('function ready()'));
		expect([
			ready.slice(0, ready.indexOf('}', ready.indexOf('post('))).includes('selectAt'),
			html.includes('if(started&&s&&!s.isCollapsed){return;}started=true;if(!selectAt([1,2])){selectAll();}'),
			html.includes('tab-size: 28px'),
			html.includes("document.addEventListener('touchstart'"),
			html.includes("addEventListener('touchcancel'"),
			inplaceSelectStartScript(),
		]).toEqual([false, true, true, true, false, 'window.__paraSelectStart&&window.__paraSelectStart();true;']);
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
