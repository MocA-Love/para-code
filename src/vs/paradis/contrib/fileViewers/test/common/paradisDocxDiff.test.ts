/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, ok, strictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisDocxBlock,
	IParadisDocxOutline,
	IParadisDocxRun,
	PARADIS_DOCX_ALIGN_CELL_BUDGET,
} from '../../common/paradisDocx.js';
import { buildDocxDiff } from '../../common/paradisDocxDiff.js';

function run(text: string, fmt = '', special?: IParadisDocxRun['special']): IParadisDocxRun {
	return special ? { text, fmt, special } : { text, fmt };
}

/** テキストだけの段落。書式やリストを指定したいときは extra で足す。 */
function block(index: number, text: string, extra: Partial<IParadisDocxBlock> = {}): IParadisDocxBlock {
	const runs = extra.runs ?? [run(text)];
	let joined = '';
	for (const entry of runs) {
		joined += entry.text;
	}
	return { index, kind: 'paragraph', text: joined, depth: 0, runs, ...extra };
}

function outline(blocks: readonly IParadisDocxBlock[], extra: Partial<IParadisDocxOutline> = {}): IParadisDocxOutline {
	return { blocks, formats: {}, ...extra };
}

/** テキストの配列から素直な outline を作る。 */
function textOutline(...texts: readonly string[]): IParadisDocxOutline {
	return outline(texts.map((text, index) => block(index, text)));
}

/** 変更を「種別:旧index/新index」の読みやすい形に落とす。 */
function summarize(result: ReturnType<typeof buildDocxDiff>): string[] {
	return result.changes.map(change => `${change.status}:${change.originalIndex ?? '-'}/${change.modifiedIndex ?? '-'}`);
}

suite('Paradis Word diff', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('同じ文書なら変更なし', () => {
		const document = textOutline('はじめに', '本文です', 'おわりに');
		const result = buildDocxDiff(document, textOutline('はじめに', '本文です', 'おわりに'));
		deepStrictEqual(summarize(result), []);
		deepStrictEqual(result.annotations, []);
		deepStrictEqual(result.fillers, []);
		strictEqual(result.degraded, undefined);
	});

	test('段落の追加・削除・変更を見分ける', () => {
		const result = buildDocxDiff(
			textOutline('見出し', '消える段落', '変わる前の文です'),
			textOutline('見出し', '変わる後の文です', '足された段落')
		);
		deepStrictEqual(summarize(result), ['removed:1/-', 'modified:2/1', 'added:-/2']);
	});

	test('段落が1つ挿入されても以降がズレない（位置ペアリングだと全部変更になる）', () => {
		// 旧: A B C D  →  新: A X B C D
		// 位置で対応付けると B/C/D がすべて「変更」になる。LCS で骨組みを固めれば追加1件で済む。
		const result = buildDocxDiff(
			textOutline('A段落', 'B段落', 'C段落', 'D段落'),
			textOutline('A段落', 'X段落', 'B段落', 'C段落', 'D段落')
		);
		deepStrictEqual(summarize(result), ['added:-/1']);
	});

	test('似ている段落は「変更」として対応付ける', () => {
		const result = buildDocxDiff(
			textOutline('交通費は自己負担とする。'),
			textOutline('交通費は会社負担とする。')
		);
		deepStrictEqual(summarize(result), ['modified:0/0']);
		const original = result.annotations.find(a => a.side === 'original');
		const modified = result.annotations.find(a => a.side === 'modified');
		ok(original?.segments?.some(s => s.type === 'removed'));
		ok(modified?.segments?.some(s => s.type === 'added'));
	});

	test('長い段落のわずかな修正も「変更」として対応付ける', () => {
		// 実務の日本語文書は1段落が40文字を優に超える。ここが「削除+追加」に落ちると
		// 段落内の差分がまったく出なくなり、この機能の意味が無くなる。
		const original = '第3条 交通費は原則として自己負担とするが、事前に申請があった場合はこの限りではない。';
		const modified = '第3条 交通費は原則として会社負担とするが、事前に申請があった場合はこの限りではない。';
		ok(original.length > 40, '40文字を超える段落であること');
		const result = buildDocxDiff(textOutline(original), textOutline(modified));
		deepStrictEqual(summarize(result), ['modified:0/0']);
		const added = result.annotations.find(a => a.side === 'modified')?.segments?.filter(s => s.type === 'added') ?? [];
		strictEqual(added.length, 1);
		strictEqual(modified.substring(added[0].start, added[0].end), '会社');
	});

	test('段落がとても長くても対応付けが壊れない', () => {
		// 類似度の計算は上限で打ち切るが、打ち切っても「対応付けるか」の判定は変わらない。
		const body = 'あ'.repeat(5000);
		const result = buildDocxDiff(textOutline(body + '旧'), textOutline(body + '新'));
		deepStrictEqual(summarize(result), ['modified:0/0']);
	});

	test('サロゲートペアを途中で切らない', () => {
		// 絵文字や SIP 漢字は UTF-16 で2コードユニット。LcsDiff はコードユニット単位で
		// 比べるので、素直に切ると片割れだけが run に残って文字化けする。
		const original = 'A\u{1F600}B';
		const modified = 'A\u{1F601}B';
		const result = buildDocxDiff(textOutline(original), textOutline(modified));
		const segments = result.annotations.find(a => a.side === 'modified')?.segments ?? [];
		strictEqual(segments.length, 1);
		const sliced = modified.substring(segments[0].start, segments[0].end);
		// 切り出した範囲が、単独で正しい文字列になっていること。
		strictEqual(sliced, '\u{1F601}');
		ok(![...sliced].some(ch => ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdfff && [...sliced].length !== 1));
	});

	test('似ていない段落は変更ではなく削除+追加にする', () => {
		const result = buildDocxDiff(
			textOutline('本日は晴天なり。'),
			textOutline('明細書の提出期限は月末です。')
		);
		deepStrictEqual(summarize(result), ['removed:0/-', 'added:-/0']);
	});

	test('日本語は文字単位で差分を取る', () => {
		const result = buildDocxDiff(
			textOutline('短期間で集中的に進める'),
			textOutline('合宿形式で集中的に進める')
		);
		const modified = result.annotations.find(a => a.side === 'modified');
		const added = modified?.segments?.filter(s => s.type === 'added') ?? [];
		strictEqual(added.length, 1);
		// 変わったのは先頭の「短期間」→「合宿形式」だけで、共通部分は印が付かない。
		strictEqual(added[0].start, 0);
		strictEqual(added[0].end, 4);
	});

	test('ラテン文字は単語境界まで広げる', () => {
		const result = buildDocxDiff(textOutline('the colour of it'), textOutline('the color of it'));
		const modified = result.annotations.find(a => a.side === 'modified');
		const added = modified?.segments?.filter(s => s.type === 'added') ?? [];
		strictEqual(added.length, 1);
		// "u" の1文字ではなく "color" という単語まるごとが印になる。
		strictEqual('the color of it'.substring(added[0].start, added[0].end), 'color');
	});

	test('空白だけの変更で両隣の単語を巻き込まない', () => {
		const result = buildDocxDiff(textOutline('foo bar'), textOutline('foo  bar'));
		const modified = result.annotations.find(a => a.side === 'modified');
		const added = modified?.segments?.filter(s => s.type === 'added') ?? [];
		strictEqual(added.length, 1);
		strictEqual(added[0].end - added[0].start, 1);
	});

	test('段落の移動を検出し、旧側と新側が同じ変更として結ばれる', () => {
		const original = textOutline('第1章の内容', '注意事項の本文', '第2章の内容');
		const modified = textOutline('第1章の内容', '第2章の内容', '注意事項の本文');
		const result = buildDocxDiff(original, modified);
		// 「注意事項が下がった」とも「第2章が上がった」とも読めるので、どちらが動いたかは問わない。
		// 大事なのは (1) 移動1件だけであること (2) 旧側と新側が同じ内容を指していること。
		strictEqual(result.changes.length, 1);
		const change = result.changes[0];
		strictEqual(change.status, 'moved');
		strictEqual(
			original.blocks[change.originalIndex!].text,
			modified.blocks[change.modifiedIndex!].text
		);
		const moved = result.annotations.filter(a => a.status === 'moved');
		strictEqual(moved.length, 2);
		strictEqual(moved[0].changeId, moved[1].changeId);
		strictEqual(change.id, moved[0].changeId);
		// 左右の縦位置が崩れないよう、移動元・移動先の両方にゴーストが立つ。
		strictEqual(result.fillers.length, 2);
		ok(result.fillers.every(filler => filler.kind === 'moved' && filler.changeId === change.id));
	});

	test('短い段落が偶然一致しても移動にしない', () => {
		// 「はい」が両側に複数あるので、どれとどれが対応するか決められない。
		const result = buildDocxDiff(
			textOutline('はい', '質問1', 'はい'),
			textOutline('質問1', 'はい', 'はい')
		);
		ok(!result.changes.some(change => change.status === 'moved'));
	});

	test('片側にしかない段落の分だけ、反対側にゴーストを置く', () => {
		const result = buildDocxDiff(
			textOutline('前の段落', '消える段落'),
			textOutline('前の段落', '足された段落')
		);
		// 削除の分は新側へ、追加の分は旧側へ置く。位置は「その時点で最後に置いた実段落の直後」。
		//   旧側: 前の段落 / 消える段落 / [ゴースト:足された段落]
		//   新側: 前の段落 / [ゴースト:消える段落] / 足された段落
		// これで両側とも3段落になり、消える段落とそのゴーストが同じ高さに並ぶ。
		// 追加側のゴーストを 0 の直後に置くと、この対応が1段ずれる。
		const removedFiller = result.fillers.find(filler => filler.kind === 'removed');
		const addedFiller = result.fillers.find(filler => filler.kind === 'added');
		deepStrictEqual(
			{ side: removedFiller?.side, afterIndex: removedFiller?.afterIndex, text: removedFiller?.text },
			{ side: 'modified', afterIndex: 0, text: '消える段落' }
		);
		deepStrictEqual(
			{ side: addedFiller?.side, afterIndex: addedFiller?.afterIndex, text: addedFiller?.text },
			{ side: 'original', afterIndex: 1, text: '足された段落' }
		);
	});

	test('文書の先頭に足された段落のゴーストは afterIndex -1 になる', () => {
		const result = buildDocxDiff(textOutline('本文'), textOutline('新しい見出し', '本文'));
		const filler = result.fillers[0];
		deepStrictEqual({ side: filler.side, afterIndex: filler.afterIndex }, { side: 'original', afterIndex: -1 });
	});

	test('表の中の段落にはゴーストを作らない', () => {
		// 対応するセルが相手側に無いことがあり、無理に差し込むと表の構造を壊すため。
		const original = outline([block(0, '本文'), block(1, 'セルの中', { depth: 1 })]);
		const modified = outline([block(0, '本文')]);
		const result = buildDocxDiff(original, modified);
		deepStrictEqual(summarize(result), ['removed:1/-']);
		deepStrictEqual(result.fillers, []);
	});

	test('表の中と本文で、似ているだけの段落を対応付けない', () => {
		// 深さが違うものは「変更」として結ばない。中身がそっくりでも別物として扱う。
		const original = outline([block(0, '交通費は自己負担とする。', { depth: 0 })]);
		const modified = outline([block(0, '交通費は会社負担とする。', { depth: 1 })]);
		const result = buildDocxDiff(original, modified);
		deepStrictEqual(summarize(result), ['removed:0/-', 'added:-/0']);
	});

	test('本文から表の中へ丸ごと動いた段落は移動として出る', () => {
		// テキストが完全に一致する場合だけは、深さが違っても「動いた」と読むのが自然。
		const original = outline([block(0, '注意事項の本文です', { depth: 0 })]);
		const modified = outline([block(0, '注意事項の本文です', { depth: 1 })]);
		const result = buildDocxDiff(original, modified);
		deepStrictEqual(summarize(result), ['moved:0/0']);
	});

	test('テキストが同じでも書式が違えば formatChanged になる', () => {
		const original = outline([block(0, '重要', { runs: [run('重要', 'font-weight=normal')] })]);
		const modified = outline([block(0, '重要', { runs: [run('重要', 'font-weight=bold')] })]);
		const result = buildDocxDiff(original, modified);
		deepStrictEqual(summarize(result), ['formatChanged:0/0']);
		const segment = result.annotations[0].segments?.[0];
		deepStrictEqual(
			{ type: segment?.type, format: segment?.format },
			{ type: 'format', format: [{ property: 'font-weight', original: 'normal', modified: 'bold' }] }
		);
	});

	test('段落自身の書式変更（配置など）も拾う', () => {
		const original = outline([block(0, '本文', { fmt: 'text-align=left' })]);
		const modified = outline([block(0, '本文', { fmt: 'text-align=center' })]);
		const result = buildDocxDiff(original, modified);
		deepStrictEqual(summarize(result), ['formatChanged:0/0']);
		deepStrictEqual(result.annotations[0].blockFormat, [{ property: 'text-align', original: 'left', modified: 'center' }]);
	});

	test('書式が変わった範囲だけに印が付く', () => {
		const original = outline([block(0, '', { runs: [run('通常', ''), run('ここだけ', ''), run('末尾', '')] })]);
		const modified = outline([block(0, '', { runs: [run('通常', ''), run('ここだけ', 'font-weight=bold'), run('末尾', '')] })]);
		const result = buildDocxDiff(original, modified);
		const segments = result.annotations.find(a => a.side === 'modified')?.segments ?? [];
		deepStrictEqual(segments.map(s => ({ run: s.run, start: s.start, end: s.end, type: s.type })), [
			{ run: 1, start: 0, end: 4, type: 'format' },
		]);
	});

	test('画像だけの run は途中で切らず、run まるごとに印を付ける', () => {
		const objectChar = String.fromCharCode(0xFFFC);
		const original = outline([block(0, '', { runs: [run('前', ''), run(objectChar, '', 'object'), run('後', '')] })]);
		const modified = outline([block(0, '', { runs: [run('前', ''), run('後', '')] })]);
		const result = buildDocxDiff(original, modified);
		const removed = result.annotations.find(a => a.side === 'original')?.segments?.filter(s => s.type === 'removed') ?? [];
		deepStrictEqual(removed.map(s => ({ run: s.run, start: s.start, end: s.end })), [{ run: 1, start: 0, end: 1 }]);
	});

	test('画像の差し替えは段落の変更として現れる', () => {
		const original = outline([block(0, '図', { objects: ['img:media/image1.png:100x100'] })]);
		const modified = outline([block(0, '図', { objects: ['img:media/image2.png:100x100'] })]);
		const result = buildDocxDiff(original, modified);
		strictEqual(result.changes.length, 1);
		strictEqual(result.changes[0].status, 'modified');
	});

	test('見出しレベルの変更は書式の変更として出る', () => {
		const original = outline([block(0, '目的', { styleName: 'Heading1' })]);
		const modified = outline([block(0, '目的', { styleName: 'Heading2' })]);
		const result = buildDocxDiff(original, modified);
		// 指紋は一致しないが、テキストが同じなので類似度で対応が付き、段落スタイルの差として出る。
		deepStrictEqual(summarize(result), ['formatChanged:0/0']);
		deepStrictEqual(result.annotations[0].blockFormat, [{ property: '_pstyle', original: 'Heading1', modified: 'Heading2' }]);
	});

	test('箇条書きになった段落も書式の変更として出る', () => {
		const original = outline([block(0, '項目です')]);
		const modified = outline([block(0, '項目です', { listKey: '3:0' })]);
		const result = buildDocxDiff(original, modified);
		deepStrictEqual(summarize(result), ['formatChanged:0/0']);
		deepStrictEqual(result.annotations[0].blockFormat, [{ property: '_list', original: undefined, modified: '3:0' }]);
	});

	test('打ち切られた文書は degraded を返す', () => {
		const result = buildDocxDiff(outline([block(0, '本文')], { truncated: true }), textOutline('本文'));
		deepStrictEqual(result.degraded, ['blocks']);
	});

	test('変更領域が大きすぎるときは簡易表示に落ちる', () => {
		// DP の予算を超える大きさの「両側とも総入れ替え」を作る。
		const size = Math.ceil(Math.sqrt(PARADIS_DOCX_ALIGN_CELL_BUDGET)) + 2;
		const originals: IParadisDocxBlock[] = [];
		const modifieds: IParadisDocxBlock[] = [];
		for (let i = 0; i < size; i++) {
			originals.push(block(i, `旧しい段落の本文 ${i}`));
			modifieds.push(block(i, `新しい段落の本文 ${i}`));
		}
		const result = buildDocxDiff(outline(originals), outline(modifieds));
		ok(result.degraded?.includes('align'));
		// 位置ペアリングでも、内容が似ていれば「変更」として対応が付く。
		strictEqual(result.changes.length, size);
		ok(result.changes.every(change => change.status === 'modified'));
	});

	test('変更は文書内の並び順で返る', () => {
		const result = buildDocxDiff(
			textOutline('A段落', '消える1', 'B段落', '消える2', 'C段落'),
			textOutline('A段落', 'B段落', '足された', 'C段落')
		);
		deepStrictEqual(summarize(result), ['removed:1/-', 'removed:3/-', 'added:-/2']);
	});

	test('空の文書との比較', () => {
		const added = buildDocxDiff(outline([]), textOutline('本文1', '本文2'));
		deepStrictEqual(summarize(added), ['added:-/0', 'added:-/1']);
		const removed = buildDocxDiff(textOutline('本文1', '本文2'), outline([]));
		deepStrictEqual(summarize(removed), ['removed:0/-', 'removed:1/-']);
	});
});
