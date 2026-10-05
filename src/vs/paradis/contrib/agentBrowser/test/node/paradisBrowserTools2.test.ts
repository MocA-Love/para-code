/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisCdpScreenshotOptions } from '../../common/paradisAgentBrowser.js';
import { ParadisBrowserCapture, paradisCaptureLocalPathRefusal, paradisCaptureSavePath } from '../../node/paradisBrowserCapture.js';
import { ParadisBrowserDownloadReader, paradisDecodeText, paradisParseA1Range, paradisParseDelimited } from '../../node/paradisBrowserDownloadReader.js';
import { PARADIS_BROWSER_QUERY_PAGE_SCRIPT } from '../../node/paradisBrowserQueryPageScript.js';
import { PARADIS_BROWSER_FILE_TOOL_NAMES, PARADIS_MCP_BROWSER_FILE_TOOLS } from '../../node/paradisBrowserQueryTools.js';
import { paradisRunSteps } from '../../node/paradisBrowserRunSteps.js';
import { ParadisNetworkActivity, paradisRootTargetOfSession } from '../../node/paradisCdpNetworkActivity.js';

interface IResult {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
	readonly isError?: boolean;
}

function textOf(result: unknown): string {
	return (result as IResult).content[0].text ?? '';
}

function isError(result: unknown): boolean {
	return (result as IResult).isError === true;
}

function returned(value: unknown): unknown {
	return { content: [{ type: 'text', text: `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` }] };
}

suite('para-browser tools: network idle, run_steps, capture_screenshot, read_download', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the network ledger counts each request once, ignores long-lived ones, and forgets a closed connection', () => {
		let now = 0;
		const activity = new ParadisNetworkActivity(() => now);
		const first = {};
		const second = {};
		activity.onEvent(first, 'page', 'Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://example.com/a' } });
		activity.onEvent(second, 'page', 'Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://example.com/a' } });
		activity.onEvent(first, 'frame', 'Network.requestWillBeSent', { requestId: 'r2', request: { url: 'https://example.com/b' } });
		now = 100;
		activity.onEvent(first, 'frame', 'Network.loadingFinished', { requestId: 'r2' });
		const afterFinish = activity.snapshot(30_000);
		now = 40_000;
		const longLived = activity.snapshot(30_000);
		activity.forgetConnection(first);
		assert.deepStrictEqual([afterFinish, longLived, activity.snapshot(30_000)], [
			{ inflight: 1, quietMs: 0, pendingUrls: ['https://example.com/a'], longLived: 0 },
			{ inflight: 0, quietMs: 39_900, pendingUrls: [], longLived: 1 },
			{ inflight: 0, quietMs: 39_900, pendingUrls: [], longLived: 0 },
		]);
	});

	test('events of an iframe session belong to the tab that holds it', () => {
		const parentOf = new Map<string, string | undefined>([['child', 'root'], ['grandchild', 'child']]);
		const targetOf = new Map([['root', 'tab'], ['child', 'frame'], ['grandchild', 'worker']]);
		assert.deepStrictEqual([
			paradisRootTargetOfSession('grandchild', parentOf, targetOf),
			paradisRootTargetOfSession('root', parentOf, targetOf),
			paradisRootTargetOfSession('unknown', parentOf, targetOf),
		], ['tab', 'tab', undefined]);
	});

	test('run_steps runs the steps in order and stops at the first failure', async () => {
		const called: string[] = [];
		const result = await paradisRunSteps({
			callTool: async name => {
				called.push(name);
				return name === 'click_by'
					? { content: [{ type: 'text', text: 'covered' }], isError: true }
					: { content: [{ type: 'text', text: `${name} done` }, ...(name === 'take_screenshot' ? [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] : [])] };
			},
		}, { steps: [{ tool: 'take_screenshot' }, { tool: 'fill_by', args: { selector: 'input', value: 'x' } }, { tool: 'click_by', args: { text: 'Save' } }, { tool: 'wait_until', args: { text: 'Saved' } }] });
		const refused = await paradisRunSteps({ callTool: async () => ({}) }, { steps: [{ tool: 'request_browser_page' }] });
		assert.deepStrictEqual({
			called,
			error: isError(result),
			summary: textOf(result),
			images: (result as IResult).content.filter(item => item.type === 'image').length,
			refused: isError(refused),
		}, {
			called: ['take_screenshot', 'fill_by', 'click_by'],
			error: true,
			summary: 'run_steps: 3 of 4 step(s) ran, 1 failed, 1 not run (stopped at the first failure).',
			images: 1,
			refused: true,
		});
	});

	test('capture_screenshot crops elements in document coordinates with padding and saves each image', async () => {
		const captured: IParadisCdpScreenshotOptions[] = [];
		const saved: string[] = [];
		const answers = [
			returned({ matched: 1, element: { tag: 'header' }, x: 10, y: 1500, width: 100, height: 40, documentWidth: 1200, documentHeight: 3000 }),
			returned({ matched: 2, element: { tag: 'li' }, x: 0, y: 0, width: 50, height: 20, documentWidth: 1200, documentHeight: 3000 }),
		];
		const result = await new ParadisBrowserCapture().call({
			evaluate: async source => {
				assert.ok(source.includes(PARADIS_BROWSER_QUERY_PAGE_SCRIPT));
				return answers.shift();
			},
			isCurrent: () => true,
			capture: async options => { captured.push(options); return 'AA=='; },
			save: async path => { saved.push(path); return { ok: true, path }; },
		}, { elements: [{ selector: 'header' }, { role: 'listitem' }], padding: 8, saveTo: '/work/shots/page.png' });
		assert.deepStrictEqual({ error: isError(result), captured, saved, inline: (result as IResult).content.length }, {
			error: false,
			captured: [
				{ format: 'png', pageRect: { x: 2, y: 1492, width: 116, height: 56 }, captureBeyondViewport: true },
				{ format: 'png', pageRect: { x: 0, y: 0, width: 58, height: 28 }, captureBeyondViewport: true },
			],
			saved: ['/work/shots/page-1.png', '/work/shots/page-2.png'],
			inline: 1,
		});
	});

	test('capture_screenshot save paths and the local folders it may write to', async () => {
		const realpath = async (path: string) => {
			if (path === '/work' || path === '/work/shots' || path === '/tmp' || path === '/') {
				return path === '/tmp' ? '/private/tmp' : path;
			}
			if (path === '/work/link') {
				return '/etc';
			}
			throw new Error('ENOENT');
		};
		assert.deepStrictEqual({
			paths: [paradisCaptureSavePath('/a/b.png', 0, 1, '.png'), paradisCaptureSavePath('/a/b', 1, 2, '.jpeg'), paradisCaptureSavePath('/a/b.jpg', 0, 1, '.jpeg')],
			inside: await paradisCaptureLocalPathRefusal('/work/shots/new/x.png', ['/work'], realpath),
			temporary: await paradisCaptureLocalPathRefusal('/tmp/x.png', ['/work', '/tmp'], realpath),
			outside: (await paradisCaptureLocalPathRefusal('/work/link/x.png', ['/work'], realpath))?.startsWith('"saveTo" (/work/link/x.png) is outside'),
			git: (await paradisCaptureLocalPathRefusal('/work/.git/x.png', ['/work'], realpath))?.includes('.git'),
			relative: (await paradisCaptureLocalPathRefusal('x.png', ['/work'], realpath))?.includes('absolute'),
		}, {
			paths: ['/a/b.png', '/a/b-2.jpeg', '/a/b.jpg'],
			inside: undefined,
			temporary: undefined,
			outside: true,
			git: true,
			relative: true,
		});
	});

	test('read_download reads csv and xlsx ranges in the download folder only', async () => {
		assert.deepStrictEqual(PARADIS_MCP_BROWSER_FILE_TOOLS.map(tool => tool.name), [...PARADIS_BROWSER_FILE_TOOL_NAMES]);
		const folder = await fs.mkdtemp(join(tmpdir(), 'paradis-read-download-'));
		try {
			const downloads = join(folder, 'downloads');
			await fs.mkdir(downloads);
			await fs.writeFile(join(downloads, 'list.csv'), '﻿name,note\n"Sato, A","line1\nline2"\nSuzuki,ok\n');
			await fs.writeFile(join(folder, 'secret.csv'), 'a,b\n');
			const ExcelJS = (await import('exceljs')).default;
			const workbook = new ExcelJS.Workbook();
			workbook.addWorksheet('Summary').addRows([['Item', 'Price'], ['Apple', 120], ['Pear', 200]]);
			workbook.addWorksheet('Raw').addRow(['x']);
			await fs.writeFile(join(downloads, 'book.xlsx'), Buffer.from(await workbook.xlsx.writeBuffer()));
			const reader = new ParadisBrowserDownloadReader({ downloadsDirectory: async () => downloads });
			const csv = await reader.call({ path: join(downloads, 'list.csv') });
			const xlsx = await reader.call({ path: join(downloads, 'book.xlsx'), range: 'A2:B3' });
			const outside = await reader.call({ path: join(folder, 'secret.csv') });
			assert.deepStrictEqual({
				csv: textOf(csv).split('\n').slice(1),
				xlsx: textOf(xlsx).split('\n').slice(-3),
				sheets: textOf(xlsx).includes('"name":"Raw"'),
				outside: [isError(outside), textOf(outside).includes('only reads files in Para Code\'s download folder')],
			}, {
				csv: ['Columns: A\tB', '1: name\tnote', '2: Sato, A\tline1\\nline2', '3: Suzuki\tok'],
				xlsx: ['Columns: A\tB', '2: Apple\t120', '3: Pear\t200'],
				sheets: true,
				outside: [true, true],
			});
		} finally {
			await fs.rm(folder, { recursive: true, force: true });
		}
	});

	test('ranges, delimited text and text encodings', () => {
		assert.deepStrictEqual({
			ranges: [paradisParseA1Range('B2:AA10'), paradisParseA1Range('c3'), paradisParseA1Range('B2:A1'), paradisParseA1Range('A0')],
			rows: paradisParseDelimited('a\tb\r\nc\td\r\ne\tf', '\t', 2),
			shiftJis: paradisDecodeText(new Uint8Array([0x82, 0xa0])).encoding,
		}, {
			ranges: [{ startRow: 2, startColumn: 2, endRow: 10, endColumn: 27 }, { startRow: 3, startColumn: 3, endRow: 3, endColumn: 3 }, undefined, undefined],
			rows: { rows: [['a', 'b'], ['c', 'd']], complete: false },
			shiftJis: 'Shift_JIS',
		});
	});
});
