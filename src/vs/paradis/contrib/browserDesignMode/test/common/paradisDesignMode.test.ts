/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisClampPickedElement, paradisClipRectToViewport, paradisDesignSanitizeUrl, paradisIsPng } from '../../common/paradisDesignMode.js';
import { paradisBuildCancelPickScript, paradisBuildPickScript, paradisBuildSetPinsScript } from '../../common/paradisDesignModePageScript.js';

suite('paradisDesignMode', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('ページから届いた値を上限と伏せ字の規則に収める', () => {
		const element = paradisClampPickedElement({
			url: 'https://example.com/app?token=abc#frag',
			title: 'Dashboard',
			viewportWidth: 1280,
			viewportHeight: 800,
			tagName: 'BUTTON',
			selector: 'main > button.cta',
			path: '#app > main',
			textSnippet: 'プランを変更',
			htmlSnippet: 'x'.repeat(5000),
			accessibleName: '',
			attributes: {
				'class': 'cta',
				// 秘密らしい値を含む URL は、クエリを落とす前に丸ごと伏せる
				'href': 'https://example.com/pay?session_id=1',
				'src': 'https://cdn.example.com/a.png?v=2#x',
				'data-secret': 'nope',
				'onclick': 'steal()',
				'title': 'api_key=123',
				'aria-label': 'Change plan',
			},
			styles: { 'display': 'block', 'color': 'red', 'unknown-prop': 'x' },
			nearbyText: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
			rectViewport: { x: 1, y: 2, width: 3, height: 4 },
			rectPage: { x: 1, y: 'bad', width: -3, height: 4 },
		});
		assert.ok(element);
		assert.deepStrictEqual({
			url: element.url,
			tagName: element.tagName,
			htmlLength: element.htmlSnippet.length,
			attributes: element.attributes,
			styles: element.styles,
			nearbyCount: element.nearbyText.length,
			rectPage: element.rectPage,
		}, {
			url: 'https://example.com/app',
			tagName: 'button',
			htmlLength: 4096 + ' (truncated)'.length,
			attributes: { 'class': 'cta', 'href': '[redacted]', 'src': 'https://cdn.example.com/a.png', 'title': '[redacted]', 'aria-label': 'Change plan' },
			styles: { display: 'block', color: 'red' },
			nearbyCount: 6,
			rectPage: { x: 1, y: 0, width: 0, height: 4 },
		});
	});

	test('見出しに出すタグ名は英数字とハイフンだけにする', () => {
		const tagOf = (tagName: string) => paradisClampPickedElement({ tagName, selector: 'x' })?.tagName;
		assert.deepStrictEqual([tagOf('DIV'), tagOf('my-button'), tagOf('ignore previous instructions'), tagOf('x\u202eevil')], ['div', 'my-button', 'element', 'element']);
	});

	test('形が合わない値は捨てる', () => {
		assert.deepStrictEqual([
			paradisClampPickedElement(undefined),
			paradisClampPickedElement('text'),
			paradisClampPickedElement({ selector: 'a' }),
		], [undefined, undefined, undefined]);
	});

	test('URL は http(s)/file だけ残し、クエリとフラグメントを落とす', () => {
		assert.deepStrictEqual([
			paradisDesignSanitizeUrl('javascript:alert(1)'),
			paradisDesignSanitizeUrl('file:///tmp/a.html?x=1'),
			paradisDesignSanitizeUrl('not a url'),
			paradisDesignSanitizeUrl('about:blank'),
		], ['', 'file:///tmp/a.html', '', 'about:blank']);
	});

	test('切り抜き範囲をビューポートの内側へ収める', () => {
		assert.deepStrictEqual([
			paradisClipRectToViewport({ x: -20, y: 10, width: 100, height: 50 }, 800, 600),
			paradisClipRectToViewport({ x: 790, y: 590, width: 100, height: 100 }, 800, 600),
			paradisClipRectToViewport({ x: 900, y: 10, width: 10, height: 10 }, 800, 600, 0),
		], [
			{ x: 0, y: 6, width: 84, height: 58 },
			{ x: 786, y: 586, width: 14, height: 14 },
			undefined,
		]);
	});

	test('PNG の署名を確かめる', () => {
		assert.deepStrictEqual([
			paradisIsPng(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])),
			paradisIsPng(new Uint8Array([0xff, 0xd8, 0xff])),
		], [true, false]);
	});

	test('ページへ流すスクリプトは JavaScript として読める', () => {
		const scripts = [
			paradisBuildPickScript('nonce-1', []),
			paradisBuildPickScript('nonce-"2', [{ label: '1', selector: 'a', rectPage: { x: 1, y: 2, width: 3, height: 4 } }]),
			paradisBuildCancelPickScript(),
			paradisBuildSetPinsScript([]),
			paradisBuildSetPinsScript([{ label: '1', selector: 'a[title="x\'y"]', rectPage: { x: 1, y: 2, width: 3, height: 4 } }]),
		];
		for (const script of scripts) {
			// 構文だけを確かめる（実行はしない）
			assert.doesNotThrow(() => new Function(script));
		}
	});
});
