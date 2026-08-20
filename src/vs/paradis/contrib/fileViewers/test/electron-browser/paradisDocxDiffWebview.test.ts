/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// webview の中で動く本体（paradisDocxDiffWebviewMain）の検証。
//
// 実際の docx-preview も本物の DOM も使わず、host を差し替えて
//   .docx のバイト列 → 概要の抽出 → 注釈の注入 → 描画に渡る AST
// の一連を確かめる。ここは差分機能で一番込み入っていて（run の分割・ゴーストの差し込み）、
// かつブラウザの中でしか動かないと再現も切り分けもできない部分なので、必ず押さえておく。

import { deepStrictEqual, ok, strictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisDocxAnnotation,
	IParadisDocxFiller,
	IParadisDocxOutline,
	PARADIS_DOCX_ERROR_LIBRARY_MISSING,
	ParadisDocxHostMessage,
} from '../../common/paradisDocx.js';
import {
	IParadisDocxAstDocument,
	IParadisDocxAstNode,
	IParadisDocxDiffPane,
	IParadisDocxDiffWebviewHost,
	IParadisDocxPreviewApi,
	buildParadisDocxDiffContext,
	paradisDocxDiffWebviewMain,
} from '../../electron-browser/paradisDocxDiffWebview.js';

// ── AST の組み立て ──────────────────────────────────────────────────────

function text(value: string): IParadisDocxAstNode {
	return { type: 'text', text: value };
}

function run(children: IParadisDocxAstNode[], cssStyle?: Record<string, string>): IParadisDocxAstNode {
	return cssStyle ? { type: 'run', children, cssStyle } : { type: 'run', children };
}

function paragraph(children: IParadisDocxAstNode[], extra: Partial<IParadisDocxAstNode> = {}): IParadisDocxAstNode {
	return { type: 'paragraph', children, ...extra };
}

/** テキストだけの段落。 */
function simple(value: string): IParadisDocxAstNode {
	return paragraph([run([text(value)])]);
}

function document(children: IParadisDocxAstNode[], rels?: { id: string; target: string }[]): IParadisDocxAstDocument {
	return { documentPart: { body: { type: 'document', children }, rels } };
}

/** 段落の描画結果を「印つきのテキスト」に直して読みやすくする。 */
function renderToText(node: IParadisDocxAstNode, attrs: { seg: string; diff: string; ghost: string }): string {
	if (node.type === 'text') {
		return node.text ?? '';
	}
	let inner = '';
	for (const child of node.children ?? []) {
		inner += renderToText(child, attrs);
	}
	const style = node.cssStyle;
	if (node.type === 'run' && style && style['$' + attrs.seg]) {
		return `[${style['$' + attrs.seg]}:${inner}]`;
	}
	if (node.type === 'paragraph' && style && style['$' + attrs.ghost]) {
		return `<ghost:${style['$' + attrs.ghost]}:${inner}>`;
	}
	if (node.type === 'paragraph' && style && style['$' + attrs.diff]) {
		return `<${style['$' + attrs.diff]}:${inner}>`;
	}
	return inner;
}

// ── host の差し替え ─────────────────────────────────────────────────────

interface IHarness {
	readonly host: IParadisDocxDiffWebviewHost;
	readonly posted: unknown[];
	/** renderDocument に渡された描画オプション（左右の順）。 */
	readonly renderOptions: Record<string, unknown>[];
	send(message: ParadisDocxHostMessage): void;
	/** 描画に渡された AST（renderDocument が受け取ったもの）。 */
	rendered(side: 'original' | 'modified'): IParadisDocxAstDocument | undefined;
	/** 描画された本文段落を「印つきテキスト」の配列にする。 */
	lines(side: 'original' | 'modified'): string[];
	/** 溜まっているタイマーを実行する。 */
	runTimers(): void;
	/** パースを失敗させる。 */
	failParse(error: Error): void;
	/** vendored ライブラリが読み込めていない状態にする。 */
	dropLibrary(): void;
}

/**
 * webview 本体を、差し替えた host の上で動かす。
 *
 * host が注入できるように作ってあるので、fake も**型に沿って**書ける（any キャストで
 * ねじ込まない）。DOM もライブラリも要らないので、ここでの検証はブラウザ無しで完結する。
 */
function harness(original: IParadisDocxAstDocument, modified: IParadisDocxAstDocument): IHarness {
	const posted: unknown[] = [];
	const renderOptions: Record<string, unknown>[] = [];
	const rendered = new Map<string, IParadisDocxAstDocument>();
	const timers: (() => void)[] = [];
	let handler: ((message: ParadisDocxHostMessage) => void) | undefined;
	let parseError: Error | undefined;
	let hasZip = true;
	const parsed = new Map<number, IParadisDocxAstDocument>([[1, original], [2, modified]]);

	const makePane = (): IParadisDocxDiffPane => ({
		scroller: { scrollTop: 0, clientHeight: 400, scrollHeight: 1200, top: () => 0, find: () => [] },
		content: {},
		styles: {},
		zoom: { style: { transform: '' }, scrollHeight: 1000, scrollWidth: 800 },
		sizer: { style: { height: '', width: '' } },
	});
	const panes = { original: makePane(), modified: makePane() };

	const docx: IParadisDocxPreviewApi = {
		// .docx のバイト列は使わず、先頭バイトの目印で旧版/新版を見分ける。
		parseAsync: async data => {
			if (parseError) {
				throw parseError;
			}
			return parsed.get(new Uint8Array(data)[0])!;
		},
		renderDocument: async (wordDocument, content, _styles, options) => {
			rendered.set(content === panes.original.content ? 'original' : 'modified', wordDocument);
			renderOptions.push(options);
			return undefined;
		},
	};

	const host: IParadisDocxDiffWebviewHost = {
		docx,
		get hasZip() { return hasZip; },
		panes,
		post: message => posted.push(message),
		onMessage: next => { handler = next; },
		onScroll: () => { },
		setStatus: () => { },
		setShowFormatChanges: () => { },
		setTimeout: callback => { timers.push(callback); return timers.length; },
		clearTimeout: () => { },
	};

	paradisDocxDiffWebviewMain(buildParadisDocxDiffContext('loading'), host);

	const attrs = { seg: 'data-paradis-seg', diff: 'data-paradis-diff', ghost: 'data-paradis-ghost' };
	return {
		host,
		posted,
		renderOptions,
		send: message => handler?.(message),
		rendered: side => rendered.get(side),
		lines: side => {
			const body = rendered.get(side)?.documentPart?.body;
			return (body?.children ?? []).map(child => renderToText(child, attrs));
		},
		runTimers: () => {
			for (const callback of timers.splice(0, timers.length)) {
				callback();
			}
		},
		failParse: error => { parseError = error; },
		dropLibrary: () => { hasZip = false; },
	};
}

function bytes(marker: number): ArrayBuffer {
	const buffer = new ArrayBuffer(1);
	new Uint8Array(buffer)[0] = marker;
	return buffer;
}

/** load を送って outline が返るまで進める。 */
async function load(test: IHarness): Promise<{ original: IParadisDocxOutline; modified: IParadisDocxOutline }> {
	test.send({ type: 'load', generation: 1, original: bytes(1), modified: bytes(2) });
	await new Promise(resolve => setTimeout(resolve, 0));
	const message = test.posted.find(entry => (entry as { type: string }).type === 'outline') as {
		original: IParadisDocxOutline;
		modified: IParadisDocxOutline;
	};
	return message;
}

async function annotate(test: IHarness, annotations: IParadisDocxAnnotation[], fillers: IParadisDocxFiller[] = []): Promise<void> {
	test.send({ type: 'annotate', annotations, fillers });
	await new Promise(resolve => setTimeout(resolve, 0));
}

suite('Paradis Word diff webview', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('起動したら ready を送る', () => {
		const test = harness(document([]), document([]));
		deepStrictEqual(test.posted, [{ type: 'ready' }]);
	});

	test('本文の段落を順に並べた概要を返す', async () => {
		const test = harness(
			document([simple('見出し'), simple('本文です')]),
			document([simple('見出し')])
		);
		const outline = await load(test);
		deepStrictEqual(outline.original.blocks.map(b => ({ index: b.index, text: b.text, depth: b.depth })), [
			{ index: 0, text: '見出し', depth: 0 },
			{ index: 1, text: '本文です', depth: 0 },
		]);
	});

	test('表の中の段落は深さ1として拾い、表そのものは飛ばす', async () => {
		const table: IParadisDocxAstNode = {
			type: 'table',
			children: [{ type: 'row', children: [{ type: 'cell', children: [simple('セルの中')] }] }],
		};
		const test = harness(document([simple('本文'), table]), document([]));
		const outline = await load(test);
		deepStrictEqual(outline.original.blocks.map(b => ({ text: b.text, depth: b.depth })), [
			{ text: '本文', depth: 0 },
			{ text: 'セルの中', depth: 1 },
		]);
	});

	test('w:del の中身は描画されないので概要にも入れない', async () => {
		const withRevisions = paragraph([
			run([text('残る')]),
			{ type: 'inserted', children: [run([text('挿入')])] },
			{ type: 'deleted', children: [run([{ type: 'deletedText', text: '消えた' }])] },
		]);
		const test = harness(document([withRevisions]), document([]));
		const outline = await load(test);
		// w:ins の中身は描画されるので入る。w:del は丸ごと入らない。
		strictEqual(outline.original.blocks[0].text, '残る挿入');
		strictEqual(outline.original.blocks[0].runs.length, 2);
	});

	test('ハイパーリンクの中の run も拾う', async () => {
		const link = paragraph([
			run([text('詳しくは')]),
			{ type: 'hyperlink', children: [run([text('こちら')])] },
		]);
		const test = harness(document([link]), document([]));
		const outline = await load(test);
		strictEqual(outline.original.blocks[0].text, '詳しくはこちら');
		strictEqual(outline.original.blocks[0].runs.length, 2);
	});

	test('タブ・改行・画像は文字数1つ分として数える', async () => {
		const objectChar = String.fromCharCode(0xFFFC);
		const mixed = paragraph([
			run([text('前'), { type: 'tab' }, text('後')]),
			run([{ type: 'drawing', children: [{ type: 'image', src: 'rId7', cssStyle: { width: '10px', height: '20px' } }] }]),
		]);
		const test = harness(document([mixed], [{ id: 'rId7', target: 'media/image1.png' }]), document([]));
		const outline = await load(test);
		const blockData = outline.original.blocks[0];
		strictEqual(blockData.text, '前\t後' + objectChar);
		// 画像だけの run は途中で切らせない印が付く。
		strictEqual(blockData.runs[1].special, 'object');
		deepStrictEqual(blockData.objects, ['img:media/image1.png:10pxx20px']);
	});

	test('run の書式は cssStyle から拾い、重複は表にまとめる', async () => {
		const styled = paragraph([
			run([text('太字')], { 'font-weight': 'bold' }),
			run([text('普通')]),
			run([text('また太字')], { 'font-weight': 'bold' }),
		]);
		const test = harness(document([styled]), document([]));
		const outline = await load(test);
		deepStrictEqual(outline.original.blocks[0].runs.map(r => r.fmt), ['font-weight=bold', '', 'font-weight=bold']);
		deepStrictEqual(outline.original.formats['font-weight=bold'], { 'font-weight': 'bold' });
	});

	test('段落に印を付けると cssStyle に属性が入る', async () => {
		const test = harness(document([simple('変わった段落')]), document([simple('変わった段落')]));
		await load(test);
		await annotate(test, [
			{ side: 'original', index: 0, status: 'removed', changeId: 7 },
		]);
		const node = test.rendered('original')!.documentPart!.body!.children![0];
		deepStrictEqual(node.cssStyle, {
			'$data-paradis-diff': 'removed',
			'$data-paradis-change': '7',
		});
	});

	test('run の一部だけに印を付けると run が3つに割れる', async () => {
		const test = harness(document([simple('前ここ後')]), document([simple('前ここ後')]));
		await load(test);
		await annotate(test, [
			{ side: 'original', index: 0, status: 'modified', changeId: 1, segments: [{ run: 0, start: 1, end: 3, type: 'removed' }] },
		]);
		deepStrictEqual(test.lines('original'), ['<modified:前[removed:ここ]後>']);
		const runs = test.rendered('original')!.documentPart!.body!.children![0].children!;
		strictEqual(runs.length, 3);
		// 分割した破片は元の run の書式を引き継ぐ。
		strictEqual(runs[0].type, 'run');
	});

	test('分割した破片は元の書式を引き継ぐ', async () => {
		const test = harness(
			document([paragraph([run([text('前ここ後')], { 'font-weight': 'bold', color: '#ff0000' })])]),
			document([])
		);
		await load(test);
		await annotate(test, [
			{ side: 'original', index: 0, status: 'modified', changeId: 1, segments: [{ run: 0, start: 1, end: 3, type: 'added' }] },
		]);
		const runs = test.rendered('original')!.documentPart!.body!.children![0].children!;
		deepStrictEqual(runs.map(r => r.cssStyle), [
			{ 'font-weight': 'bold', color: '#ff0000' },
			{ 'font-weight': 'bold', color: '#ff0000', '$data-paradis-seg': 'added' },
			{ 'font-weight': 'bold', color: '#ff0000' },
		]);
	});

	test('タブや画像は途中で切らず、まるごと1つの破片になる', async () => {
		const test = harness(
			document([paragraph([run([text('前'), { type: 'tab' }, text('後')])])]),
			document([])
		);
		await load(test);
		// タブ(1文字)の途中に掛かる範囲を渡しても、タブは割れない。
		await annotate(test, [
			{ side: 'original', index: 0, status: 'modified', changeId: 1, segments: [{ run: 0, start: 1, end: 2, type: 'removed' }] },
		]);
		const runs = test.rendered('original')!.documentPart!.body!.children![0].children!;
		// 前 / タブ(印つき) / 後 の3つ。タブのノードは複製されず1回だけ現れる。
		strictEqual(runs.length, 3);
		strictEqual(runs[1].cssStyle!['$data-paradis-seg'], 'removed');
		strictEqual(runs[1].children!.length, 1);
		strictEqual(runs[1].children![0].type, 'tab');
	});

	test('書式変更の印にはツールチップ本文が乗る', async () => {
		const test = harness(document([simple('本文です')]), document([]));
		await load(test);
		await annotate(test, [
			{
				side: 'original', index: 0, status: 'formatChanged', changeId: 3,
				segments: [{ run: 0, start: 0, end: 2, type: 'format', detail: '太字になりました' }],
			},
		]);
		const runs = test.rendered('original')!.documentPart!.body!.children![0].children!;
		// 属性が `title` であること自体に意味がある（ブラウザ標準のツールチップがそのまま出る）。
		strictEqual(runs[0].cssStyle!['$title'], '太字になりました');
	});

	test('文字を持たない run には run 自体に印を付ける', async () => {
		const test = harness(
			document([paragraph([run([{ type: 'commentReference', id: '1' }])])]),
			document([])
		);
		await load(test);
		await annotate(test, [
			{ side: 'original', index: 0, status: 'modified', changeId: 1, segments: [{ run: 0, start: 0, end: 1, type: 'removed' }] },
		]);
		const runs = test.rendered('original')!.documentPart!.body!.children![0].children!;
		strictEqual(runs.length, 1);
		strictEqual(runs[0].cssStyle!['$data-paradis-seg'], 'removed');
	});

	test('ゴーストは指定した段落の直後に入る', async () => {
		const test = harness(document([simple('1つめ'), simple('2つめ')]), document([simple('1つめ'), simple('2つめ')]));
		await load(test);
		await annotate(test, [], [
			{ side: 'modified', afterIndex: 0, text: '消えた段落', kind: 'removed', changeId: 5 },
		]);
		deepStrictEqual(test.lines('modified'), ['1つめ', '<ghost:removed:消えた段落>', '2つめ']);
	});

	test('afterIndex -1 のゴーストは本文の先頭に入る', async () => {
		const test = harness(document([simple('本文')]), document([simple('本文')]));
		await load(test);
		await annotate(test, [], [
			{ side: 'original', afterIndex: -1, text: '足された見出し', kind: 'added', changeId: 2 },
		]);
		deepStrictEqual(test.lines('original'), ['<ghost:added:足された見出し>', '本文']);
	});

	test('同じ位置に複数のゴーストを入れても順番が保たれる', async () => {
		const test = harness(document([simple('先頭')]), document([simple('先頭')]));
		await load(test);
		await annotate(test, [], [
			{ side: 'original', afterIndex: 0, text: '1件め', kind: 'added', changeId: 1 },
			{ side: 'original', afterIndex: 0, text: '2件め', kind: 'added', changeId: 2 },
		]);
		deepStrictEqual(test.lines('original'), ['先頭', '<ghost:added:1件め>', '<ghost:added:2件め>']);
	});

	test('複数の位置へのゴーストが互いの位置をずらさない', async () => {
		const test = harness(
			document([simple('A'), simple('B'), simple('C')]),
			document([simple('A'), simple('B'), simple('C')])
		);
		await load(test);
		await annotate(test, [], [
			{ side: 'original', afterIndex: 0, text: 'Aの後', kind: 'added', changeId: 1 },
			{ side: 'original', afterIndex: 2, text: 'Cの後', kind: 'added', changeId: 2 },
		]);
		deepStrictEqual(test.lines('original'), ['A', '<ghost:added:Aの後>', 'B', 'C', '<ghost:added:Cの後>']);
	});

	test('表の中の段落を指したゴーストは、その表の直後に入る', async () => {
		const table: IParadisDocxAstNode = {
			type: 'table',
			children: [{ type: 'row', children: [{ type: 'cell', children: [simple('セル')] }] }],
		};
		const test = harness(document([simple('本文'), table]), document([simple('本文'), table]));
		await load(test);
		// index 1 は表の中の段落。ゴーストはセルの中ではなく表の後ろへ。
		await annotate(test, [], [
			{ side: 'original', afterIndex: 1, text: '表の後ろ', kind: 'added', changeId: 1 },
		]);
		const children = test.rendered('original')!.documentPart!.body!.children!;
		deepStrictEqual(children.map(child => child.type), ['paragraph', 'table', 'paragraph']);
		strictEqual(children[2].cssStyle!['$data-paradis-ghost'], 'added');
	});

	test('左右で別の className を使って描く（CSS と番号の衝突を避ける）', async () => {
		const test = harness(document([simple('本文')]), document([simple('本文')]));
		await load(test);
		await annotate(test, []);
		deepStrictEqual(test.renderOptions.map(options => options.className), ['docx-l', 'docx-r']);
		// 差分では左右の段落を縦に揃えたいので、ページ割りはしない。
		ok(test.renderOptions.every(options => options.breakPages === false && options.renderChanges === false));
	});

	test('描画が終わったら rendered を送る', async () => {
		const test = harness(document([simple('本文')]), document([simple('本文')]));
		await load(test);
		await annotate(test, []);
		ok(test.posted.some(entry => (entry as { type: string }).type === 'rendered'));
	});

	test('ズームは左右のペインに同じ倍率を当て、footprint も更新する', async () => {
		const test = harness(document([]), document([]));
		test.send({ type: 'zoom', scale: 1.5 });
		strictEqual(test.host.panes.original.zoom.style.transform, 'scale(1.5)');
		strictEqual(test.host.panes.modified.zoom.style.transform, 'scale(1.5)');
		// scrollHeight 1000 * 1.5 を切り上げた値。
		strictEqual(test.host.panes.original.sizer.style.height, '1500px');
	});

	test('ライブラリが読み込めていなければエラーコードを返す', async () => {
		const test = harness(document([]), document([]));
		test.dropLibrary();
		test.send({ type: 'load', generation: 1, original: bytes(1), modified: bytes(2) });
		await new Promise(resolve => setTimeout(resolve, 0));
		const error = test.posted.find(entry => (entry as { type: string }).type === 'error') as { message: string };
		// 文言は renderer 側で付けるので、ここではコードだけを返す。
		strictEqual(error.message, PARADIS_DOCX_ERROR_LIBRARY_MISSING);
		ok(!test.posted.some(entry => (entry as { type: string }).type === 'outline'));
	});

	test('パースに失敗した側を添えてエラーを返す', async () => {
		const test = harness(document([]), document([]));
		test.failParse(new Error('broken zip'));
		test.send({ type: 'load', generation: 1, original: bytes(1), modified: bytes(2) });
		await new Promise(resolve => setTimeout(resolve, 0));
		const error = test.posted.find(entry => (entry as { type: string }).type === 'error') as { side: string; message: string };
		deepStrictEqual({ side: error.side, message: error.message }, { side: 'original', message: 'broken zip' });
	});

	test('注釈を二度送っても AST を二重に書き換えない', async () => {
		const test = harness(document([simple('本文')]), document([simple('本文')]));
		await load(test);
		const filler: IParadisDocxFiller = { side: 'original', afterIndex: 0, text: 'ゴースト', kind: 'added', changeId: 1 };
		await annotate(test, [], [filler]);
		await annotate(test, [], [filler]);
		// 注入は冪等ではないので、2回通すとゴーストが二重に入ってしまう。
		deepStrictEqual(test.lines('original'), ['本文', '<ghost:added:ゴースト>']);
	});

	test('文字列化して実行しても動く（外側の識別子に依存していない）', async () => {
		// この方式の唯一の不変条件は「関数が自己完結していること」。関数を直接呼ぶだけの
		// テストでは、うっかりモジュールスコープを参照しても緑のままで、実機の webview だけが
		// ReferenceError で死ぬ。ここだけは本番と同じ「文字列化してから実行」で確かめる。
		const test = harness(document([simple('本文')]), document([simple('本文')]));
		const source = `return (${paradisDocxDiffWebviewMain.toString()});`;
		const revived = new Function(source)() as typeof paradisDocxDiffWebviewMain;
		const posted: unknown[] = [];
		let handler: ((message: ParadisDocxHostMessage) => void) | undefined;
		const host: IParadisDocxDiffWebviewHost = {
			...test.host,
			post: message => posted.push(message),
			onMessage: next => { handler = next; },
		};
		revived(buildParadisDocxDiffContext('loading'), host);
		deepStrictEqual(posted, [{ type: 'ready' }]);
		handler!({ type: 'load', generation: 9, original: bytes(1), modified: bytes(2) });
		await new Promise(resolve => setTimeout(resolve, 0));
		const outline = posted.find(entry => (entry as { type: string }).type === 'outline') as unknown as { generation: number };
		strictEqual(outline.generation, 9);
	});
});
