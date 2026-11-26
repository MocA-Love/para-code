/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { readFileSync } from 'fs';
import { FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAdjustDevtoolsToolDescriptor, paradisPrepareDevtoolsToolCall } from '../../node/paradisDevtoolsToolAdjustments.js';

const VENDORED = 'vs/paradis/contrib/agentBrowser/node/media/chrome-devtools-mcp';

interface ISourceMapEntry {
	readonly lineNumber: number;
	readonly columnNumber: number;
	readonly sourceURL?: string;
	readonly sourceLineNumber: number;
	readonly sourceColumnNumber: number;
	readonly name?: string;
}

interface ISourceMap {
	url(): string;
	json(): unknown;
	findEntry(line: number, column: number): ISourceMapEntry | null;
}

interface ISourceMaps {
	readonly byScriptId: Map<string, ISourceMap>;
	readonly byUrl: Map<string, ISourceMap>;
	readonly saved: { url: string; sourceMapUrl?: string; sourceMap: unknown }[];
	readonly visibleScripts: Map<string, string>;
}

interface ISaveOptions {
	readonly includeScriptContent: boolean;
	readonly includeSourceMaps: boolean;
}

interface IScript {
	readonly scriptId: string;
	readonly sourceURL: string;
	readonly sourceMapURL?: string;
}

/** The fork-owned helpers of the vendored performance tools (plain JavaScript, loaded by the vendored child process). */
interface ITraceExtras {
	paradisTraceSaveOptions(params: unknown): ISaveOptions;
	paradisExtraTraceCategories(options: ISaveOptions): string[];
	paradisCollectSourceMaps(debuggerModel: unknown, waitMs?: number): Promise<ISourceMaps>;
	paradisRewriteTraceForSave(buffer: Uint8Array, options: ISaveOptions, sourceMaps: ISourceMaps | undefined): { data: Uint8Array; sourceMapCount: number; scriptSourceCount: number };
	paradisPrepareTraceSave(buffer: Uint8Array, options: ISaveOptions, sourceMaps: ISourceMaps | undefined): { data: Uint8Array | undefined; lines: string[] };
	paradisOriginalLocationLines(insight: unknown, sourceMaps: ISourceMaps | undefined): string[];
}

/** A source map with the given mappings, sorted by generated position; `findEntry` returns the last one at or before the position. */
function fakeSourceMap(url: string, entries: ISourceMapEntry[]): ISourceMap {
	return {
		url: () => url,
		json: () => ({ version: 3, sources: [...new Set(entries.map(entry => entry.sourceURL))], mappings: 'AAAA' }),
		findEntry: (line, column) => entries.findLast(entry => entry.lineNumber < line || (entry.lineNumber === line && entry.columnNumber <= column)) ?? null,
	};
}

function fakeDebuggerModel(scripts: IScript[], maps: Map<string, Promise<ISourceMap | undefined>>): unknown {
	return {
		scripts: () => scripts,
		sourceMapManager: () => ({ sourceMapForClientPromise: (script: IScript) => maps.get(script.scriptId) ?? Promise.resolve(undefined) }),
	};
}

suite('Paradis trace extras (vendored performance tools)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let extras: ITraceExtras;
	suiteSetup(async () => {
		extras = await import(FileAccess.asFileUri(`${VENDORED}/paradis/paradisTraceExtras.js`).toString(true));
	});

	const appMap = () => fakeSourceMap('https://example.test/app.min.js.map', [
		{ lineNumber: 0, columnNumber: 15, sourceURL: 'https://example.test/src/layout.ts', sourceLineNumber: 0, sourceColumnNumber: 16, name: 'heavyLayout' },
		{ lineNumber: 0, columnNumber: 194, sourceURL: 'https://example.test/src/layout.ts', sourceLineNumber: 9, sourceColumnNumber: 11 },
		{ lineNumber: 0, columnNumber: 287, sourceURL: 'https://example.test/src/app.ts', sourceLineNumber: 3, sourceColumnNumber: 16, name: 'runWork' },
		{ lineNumber: 0, columnNumber: 288, sourceURL: 'https://example.test/src/app.ts', sourceLineNumber: 3, sourceColumnNumber: 23 },
	]);

	test('the script list is recorded only when asked, and the script text only for includeScriptContent', () => {
		const categories = (params: unknown) => extras.paradisExtraTraceCategories(extras.paradisTraceSaveOptions(params));
		assert.deepStrictEqual({
			none: categories(undefined),
			off: categories({ includeScriptContent: false, includeSourceMaps: false }),
			notBoolean: categories({ includeScriptContent: 'true', includeSourceMaps: 1 }),
			maps: categories({ includeSourceMaps: true }),
			content: categories({ includeScriptContent: true }),
		}, {
			none: [],
			off: [],
			notBoolean: [],
			maps: ['disabled-by-default-devtools.target-rundown', 'disabled-by-default-devtools.v8-source-rundown'],
			content: ['disabled-by-default-devtools.target-rundown', 'disabled-by-default-devtools.v8-source-rundown', 'disabled-by-default-devtools.v8-source-rundown-sources'],
		});
	});

	test('source maps are collected from the scripts that have one, without waiting forever and without data: URLs in the saved list', async () => {
		const inlineMap = fakeSourceMap('data:application/json;base64,e30=', []);
		const model = fakeDebuggerModel([
			{ scriptId: '7', sourceURL: 'https://example.test/app.min.js', sourceMapURL: 'app.min.js.map' },
			{ scriptId: '8', sourceURL: 'https://example.test/app.min.js', sourceMapURL: 'app.min.js.map' },
			{ scriptId: '9', sourceURL: 'https://example.test/inline.js', sourceMapURL: 'data:application/json;base64,e30=' },
			{ scriptId: '10', sourceURL: 'https://example.test/plain.js' },
			{ scriptId: '11', sourceURL: 'https://example.test/slow.js', sourceMapURL: 'slow.js.map' },
			{ scriptId: '12', sourceURL: 'https://example.test/broken.js', sourceMapURL: 'broken.js.map' },
		], new Map<string, Promise<ISourceMap | undefined>>([
			['7', Promise.resolve(appMap())],
			['8', Promise.resolve(appMap())],
			['9', Promise.resolve(inlineMap)],
			['11', new Promise<ISourceMap | undefined>(() => { })],
			['12', Promise.reject(new Error('404'))],
		]));
		const collected = await extras.paradisCollectSourceMaps(model, 10);
		assert.deepStrictEqual({
			byScriptId: [...collected.byScriptId.keys()],
			byUrl: [...collected.byUrl.keys()],
			saved: collected.saved.map(saved => ({ url: saved.url, sourceMapUrl: saved.sourceMapUrl })),
			visibleScripts: [...collected.visibleScripts.keys()],
			noModel: (await extras.paradisCollectSourceMaps(undefined)).saved,
		}, {
			byScriptId: ['7', '8', '9'],
			byUrl: ['https://example.test/app.min.js', 'https://example.test/inline.js'],
			saved: [
				{ url: 'https://example.test/app.min.js', sourceMapUrl: 'https://example.test/app.min.js.map' },
				{ url: 'https://example.test/inline.js', sourceMapUrl: undefined },
			],
			visibleScripts: ['7', '8', '9', '10', '11', '12'],
			noModel: [],
		});
	});

	test('the saved file gets the DevTools metadata for what was asked, and only the scripts of the page that its debugger knows', () => {
		const listed = (isolate: string, scriptId: number, url: string) => ({ cat: 'disabled-by-default-devtools.v8-source-rundown', name: 'ScriptCatchup', args: { data: { isolate, scriptId, url } } });
		const frameOf = (isolate: string, scriptId: number) => ({ cat: 'disabled-by-default-devtools.target-rundown', name: 'ScriptCompiled', args: { data: { isolate, scriptId } } });
		const sourceOf = (isolate: string, scriptId: number, name = 'ScriptCatchup') => ({ cat: 'disabled-by-default-devtools.v8-source-rundown-sources', name, args: { data: { isolate, scriptId, sourceText: `text of ${isolate}:${scriptId}` } } });
		const raw = {
			traceEvents: [
				{ cat: 'devtools.timeline', name: 'Layout' },
				listed('page', 13, 'https://example.test/app.min.js'), frameOf('page', 13), sourceOf('page', 13),
				// 大きいスクリプトは分けて書かれる
				listed('page', 14, 'https://example.test/big.js'), sourceOf('page', 14, 'LargeScriptCatchup'), sourceOf('page', 14, 'LargeScriptCatchup'),
				// URL の無いスクリプト（evaluate）は、ページの isolate のものだけ
				listed('page', 15, ''), sourceOf('page', 15),
				// デバッガが知らないスクリプト（Para Code が隠している world・拡張・前の文書）
				listed('page', 20, 'chrome-extension://abc/content.js'), frameOf('page', 20), sourceOf('page', 20),
				// 別の isolate（Electron ではアプリ全体が載る）の、同じ番号のスクリプト
				listed('workbench', 13, 'file:///app/out/main.js'), sourceOf('workbench', 13),
				listed('workbench', 15, 'node:internal/mime'), sourceOf('workbench', 15),
				listed('node', 15, ''), sourceOf('node', 15),
				// 一覧に無い本文
				sourceOf('page', 99),
			],
			metadata: { 'os-name': 'Mac OS X' },
		};
		const buffer = new TextEncoder().encode(JSON.stringify(raw));
		const saved = [{ url: 'https://example.test/app.min.js', sourceMapUrl: 'https://example.test/app.min.js.map', sourceMap: { version: 3 } }];
		const withVisible = (visible: [string, string][]): ISourceMaps => ({ byScriptId: new Map(), byUrl: new Map(), saved, visibleScripts: new Map(visible) });
		const sourceMaps = withVisible([['13', 'https://example.test/app.min.js'], ['14', 'https://example.test/big.js'], ['15', '']]);
		const save = (options: ISaveOptions, maps: ISourceMaps | undefined, input: Uint8Array = buffer) => {
			const rewritten = extras.paradisRewriteTraceForSave(input, options, maps);
			const file = JSON.parse(new TextDecoder().decode(rewritten.data)) as { traceEvents: { cat: string; args?: { data?: { isolate?: string; scriptId?: number; sourceText?: string } } }[]; metadata: object };
			return {
				scriptEvents: file.traceEvents.filter(event => event.cat.includes('rundown')).map(event => `${event.cat.split('.').pop()} ${event.args?.data?.isolate}:${event.args?.data?.scriptId}`),
				otherEvents: file.traceEvents.filter(event => !event.cat.includes('rundown')).length,
				metadata: file.metadata,
				counts: [rewritten.scriptSourceCount, rewritten.sourceMapCount],
			};
		};
		assert.deepStrictEqual({
			both: save({ includeScriptContent: true, includeSourceMaps: true }, sourceMaps),
			// 本文を頼んでいなければ、一覧だけを残す
			mapsOnly: save({ includeScriptContent: false, includeSourceMaps: true }, sourceMaps),
			contentWithoutDebugger: save({ includeScriptContent: true, includeSourceMaps: false }, undefined),
			// URL で確かめられるスクリプトが 1 つも無ければ、どの isolate もページのものとみなさない
			noUrlToMatch: save({ includeScriptContent: true, includeSourceMaps: false }, withVisible([['15', '']])).scriptEvents,
			bareArray: save({ includeScriptContent: false, includeSourceMaps: true }, sourceMaps, new TextEncoder().encode(JSON.stringify([raw.traceEvents[0]]))),
		}, {
			both: {
				scriptEvents: [
					'v8-source-rundown page:13', 'target-rundown page:13', 'v8-source-rundown-sources page:13',
					'v8-source-rundown page:14', 'v8-source-rundown-sources page:14', 'v8-source-rundown-sources page:14',
					'v8-source-rundown page:15', 'v8-source-rundown-sources page:15',
				],
				otherEvents: 1,
				metadata: { 'os-name': 'Mac OS X', enhancedTraceVersion: 1, sourceMaps: saved },
				counts: [3, 1],
			},
			mapsOnly: {
				scriptEvents: ['v8-source-rundown page:13', 'target-rundown page:13', 'v8-source-rundown page:14', 'v8-source-rundown page:15'],
				otherEvents: 1,
				metadata: { 'os-name': 'Mac OS X', sourceMaps: saved },
				counts: [0, 1],
			},
			contentWithoutDebugger: { scriptEvents: [], otherEvents: 1, metadata: { 'os-name': 'Mac OS X', enhancedTraceVersion: 1 }, counts: [0, 0] },
			noUrlToMatch: [],
			bareArray: { scriptEvents: [], otherEvents: 1, metadata: { sourceMaps: saved }, counts: [0, 1] },
		});
	});

	test('without the options the file is the raw buffer itself, and a trace that cannot be rewritten is not saved at all', () => {
		const listed = { cat: 'disabled-by-default-devtools.v8-source-rundown', name: 'ScriptCatchup', args: { data: { isolate: 'page', scriptId: 13, url: 'https://example.test/app.min.js' } } };
		const source = { cat: 'disabled-by-default-devtools.v8-source-rundown-sources', name: 'ScriptCatchup', args: { data: { isolate: 'page', scriptId: 13, sourceText: 'x()' } } };
		const buffer = new TextEncoder().encode(JSON.stringify({ traceEvents: [listed, source], metadata: {} }));
		// 途中で切れた記録（生のままだと、アプリ全体のスクリプトの一覧と本文が絞られずに載っている）
		const broken = buffer.slice(0, buffer.length - 5);
		const sourceMaps: ISourceMaps = { byScriptId: new Map(), byUrl: new Map(), saved: [], visibleScripts: new Map([['13', 'https://example.test/app.min.js']]) };
		const off = extras.paradisPrepareTraceSave(broken, { includeScriptContent: false, includeSourceMaps: false }, sourceMaps);
		const on = extras.paradisPrepareTraceSave(buffer, { includeScriptContent: true, includeSourceMaps: true }, sourceMaps);
		const failed = extras.paradisPrepareTraceSave(broken, { includeScriptContent: true, includeSourceMaps: false }, sourceMaps);
		assert.deepStrictEqual({
			offIsTheSameBuffer: off.data === broken,
			offLines: off.lines,
			onLines: on.lines,
			onKeepsText: new TextDecoder().decode(on.data).includes('"sourceText":"x()"'),
			failedData: failed.data,
			failedLine: failed.lines.map(line => line.replace(/\(.*\)/, '(…)')),
		}, {
			offIsTheSameBuffer: true,
			offLines: [],
			onLines: ['The saved trace includes the text of 1 script(s) of the page as it is now (scripts of earlier documents and of other frames are not included) and 0 source map(s). It can hold anything those contain; do not share it more widely than the page source.'],
			onKeepsText: true,
			failedData: undefined,
			failedLine: ['The trace was not saved: the script content and source maps could not be added (…). Record again without includeScriptContent and includeSourceMaps to save the raw trace.'],
		});
	});

	test('the forced reflow call frames get their original position: 1-based event payloads, 0-based profile frames, and the function name only at a function start', () => {
		const sourceMaps: ISourceMaps = { byScriptId: new Map([['7', appMap()]]), byUrl: new Map([['https://example.test/app.min.js', appMap()]]), saved: [], visibleScripts: new Map() };
		const header = 'Original source positions of the call frames below, from the source maps of the page (generated -> original, original as line:column counted from 1):';
		const bottomUp = [
			{ bottomUpData: { functionName: 'i', url: 'https://example.test/app.min.js', scriptId: 7, lineNumber: 0, columnNumber: 194 } },
			{ bottomUpData: { functionName: 'i', url: 'https://example.test/app.min.js', scriptId: 7, lineNumber: 0, columnNumber: 194 } },
			{ bottomUpData: { functionName: 'x', url: 'https://example.test/unmapped.js', scriptId: 99, lineNumber: 0, columnNumber: 3 } },
			{ bottomUpData: null },
		];
		assert.deepStrictEqual({
			fromEventPayload: extras.paradisOriginalLocationLines({
				topLevelFunctionCallData: { topLevelFunctionCall: { functionName: 'l', url: 'https://example.test/app.min.js', scriptId: '7', lineNumber: 1, columnNumber: 289 }, topLevelFunctionCallEvents: [{ name: 'FunctionCall' }] },
				aggregatedBottomUpData: bottomUp,
			}, sourceMaps),
			fromProfileCallByUrl: extras.paradisOriginalLocationLines({
				topLevelFunctionCallData: { topLevelFunctionCall: { functionName: '', url: 'https://example.test/app.min.js', lineNumber: 0, columnNumber: 288 }, topLevelFunctionCallEvents: [{ callFrame: {} }] },
				aggregatedBottomUpData: [],
			}, sourceMaps),
			unmapped: extras.paradisOriginalLocationLines({ aggregatedBottomUpData: [bottomUp[2]] }, sourceMaps),
			otherInsight: extras.paradisOriginalLocationLines({ insightKey: 'LCPBreakdown' }, sourceMaps),
			noSourceMaps: extras.paradisOriginalLocationLines({ aggregatedBottomUpData: bottomUp }, { byScriptId: new Map(), byUrl: new Map(), saved: [], visibleScripts: new Map() }),
			noRecording: extras.paradisOriginalLocationLines(undefined, undefined),
		}, {
			fromEventPayload: [
				header,
				' - l @ https://example.test/app.min.js:1:289 -> runWork @ https://example.test/src/app.ts:4:24',
				' - i @ https://example.test/app.min.js:0:194 -> https://example.test/src/layout.ts:10:12',
				'',
			],
			fromProfileCallByUrl: [header, ' - (anonymous) @ https://example.test/app.min.js:0:288 -> runWork @ https://example.test/src/app.ts:4:24', ''],
			unmapped: [],
			otherInsight: [],
			noSourceMaps: [],
			noRecording: [],
		});
	});

	// パッケージを更新したら当て直す（NOTES.md「vendored chrome-devtools-mcp への変更」）
	test('the vendored performance tools still carry the PARA-PATCH, and the options are arguments of performance_start_trace only', () => {
		const source = readFileSync(FileAccess.asFileUri(`${VENDORED}/build/src/tools/performance.js`).fsPath, 'utf8');
		const stopTool = source.slice(source.indexOf('export const stopTrace'), source.indexOf('export const analyzeInsight'));
		assert.deepStrictEqual({
			importsExtras: source.includes(`from '../../../paradis/paradisTraceExtras.js'`),
			startHasOptions: /includeScriptContent: zod\s+\.boolean\(\)\s+\.optional\(\)/.test(source) && /includeSourceMaps: zod\s+\.boolean\(\)\s+\.optional\(\)/.test(source),
			stopHasOptions: stopTool.includes('includeScriptContent') || stopTool.includes('includeSourceMaps'),
			addsCategories: source.includes('categories.push(...paradisExtraTraceCategories(paradisRunningSaveOptions));'),
			// 保存するのは paradisPrepareTraceSave が返したものだけ（生のバッファへ落とす経路を残さない）
			savesOnlyWhatWasPrepared: source.includes('paradisPrepareTraceSave(traceEventsBuffer, paradisSaveOptions, paradisSourceMaps)') && source.includes('if (filePath && traceEventsBuffer && paradisSave?.data) {') && !source.includes('dataToWrite = traceEventsBuffer'),
			keepsSourceMapsWithRecording: source.includes('result.paradisSourceMaps = paradisSourceMaps;'),
			addsOriginalPositions: source.includes('paradisOriginalLocationLines(paradisInsight, lastRecording.paradisSourceMaps)'),
		}, {
			importsExtras: true,
			startHasOptions: true,
			stopHasOptions: false,
			addsCategories: true,
			savesOnlyWhatWasPrepared: true,
			keepsSourceMapsWithRecording: true,
			addsOriginalPositions: true,
		});
	});

	test('Para Code passes the save options through to the vendored tool, and the descriptions say when to use them', () => {
		const properties = { reload: { type: 'boolean' }, filePath: { type: 'string' }, includeScriptContent: { type: 'boolean' }, includeSourceMaps: { type: 'boolean' } };
		const adjusted = (name: string) => paradisAdjustDevtoolsToolDescriptor({ name, description: 'upstream', inputSchema: { type: 'object', properties } });
		const args = { reload: true, filePath: '/tmp/trace.json.gz', includeScriptContent: true, includeSourceMaps: true };
		assert.deepStrictEqual({
			// tools/list（MCP と para CLI の引数の元）に 2 つの引数が残る
			listed: Object.keys((adjusted('performance_start_trace').inputSchema as { properties: object }).properties),
			called: paradisPrepareDevtoolsToolCall('performance_start_trace', args),
			start: (adjusted('performance_start_trace').description ?? '').includes('Pass includeScriptContent or includeSourceMaps with filePath only when the saved file will be opened in Chrome DevTools later or must stay readable after the page changes'),
			insight: (adjusted('performance_analyze_insight').description ?? '').includes('original source positions'),
		}, {
			listed: ['reload', 'filePath', 'includeScriptContent', 'includeSourceMaps'],
			called: { args },
			start: true,
			insight: true,
		});
	});
});
