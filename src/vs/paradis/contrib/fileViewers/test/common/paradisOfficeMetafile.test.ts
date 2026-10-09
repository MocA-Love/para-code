/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, rejects } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { convertParadisOfficeMetafile, sniffParadisOfficeMetafile, type ParadisOfficeMetafileResult } from '../../common/office/paradisOfficeMetafile.js';
import { convertParadisOfficeMetafileParts } from '../../common/office/paradisOfficeMetafileParts.js';
import { emfFont, emfPlusComment, emfRecord, emfStretchDib, emfText, minimalDib, minimalEmf, minimalWmf, ParadisMetafileBytes, wmfRecord } from './paradisOfficeMetafileFixture.js';

const MM_ANISOTROPIC = 8;

function words(...values: number[]): ParadisMetafileBytes {
	return new ParadisMetafileBytes().u32(...values.map(value => value >>> 0));
}

/** 結果のうち、確かめたい所だけを取り出す。 */
function summary(result: ParadisOfficeMetafileResult): unknown {
	if (!result.ok) {
		return { ok: false, reason: result.reason, detail: result.detail };
	}
	return {
		ok: true,
		format: result.format,
		size: [Math.round(result.width), Math.round(result.height)],
		elements: Array.from(result.svg.matchAll(/<(?<name>path|text|rect|clipPath|pattern|g)\b/g), match => match.groups!.name).join(' '),
	};
}

/** 論理の座標 0..200 × 0..100 を、装置の 0..80 × 0..40 に写す（frame は 20 mm × 10 mm、1 mm あたり 4 px）。 */
const MAPPING = [
	emfRecord(17, words(MM_ANISOTROPIC)),
	emfRecord(10, words(0, 0)),
	emfRecord(9, words(200, 100)),
	emfRecord(12, words(0, 0)),
	emfRecord(11, words(80, 40)),
];

suite('ParadisOfficeMetafile', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('draws shapes, text and a bitmap from an EMF, escaping document text', async () => {
		const dib = minimalDib(2, 2, [0xff0000, 0x00ff00, 0x0000ff, 0xffffff]);
		const emf = minimalEmf([
			...MAPPING,
			emfRecord(39, words(1, 0, 0x0000ff, 0)), // CREATEBRUSHINDIRECT 赤（COLORREF は BGR）
			emfRecord(37, words(1)),
			emfRecord(43, words(10, 10, 50, 30)), // RECTANGLE
			emfFont(2, -20, 'Sample Sans'),
			emfRecord(37, words(2)),
			emfRecord(22, words(24)), // TA_BASELINE
			emfText(20, 80, '<b>&"x', [10, 10, 10, 10, 10, 10]),
			emfStretchDib([100, 10, 40, 40], dib, 2, 2),
		]);
		const result = await convertParadisOfficeMetafile(emf);
		deepStrictEqual({
			summary: summary(result),
			rectangle: result.ok && /<path d="M4 4L20 4L20 12L4 12Z" fill="#ff0000" fill-rule="evenodd"\/>/.test(result.svg),
			text: result.ok && result.svg.includes('>&lt;b&gt;&amp;&quot;x</text>') && !result.svg.includes('<b>'),
			positions: result.ok && result.svg.includes('x="8 12 16 20 24 28"'),
			font: result.ok && result.svg.includes('font-family="Sample Sans, sans-serif" font-size="8"'),
		}, {
			summary: { ok: true, format: 'emf', size: [76, 38], elements: 'pattern g rect rect rect rect path path path text rect' },
			rectangle: true,
			text: true,
			positions: true,
			font: true,
		});
	});

	test('clips to a selected path and resets the clip with an empty region', async () => {
		const emf = minimalEmf([
			...MAPPING,
			emfRecord(59), // BEGINPATH
			emfRecord(27, words(0, 0)),
			emfRecord(89, new ParadisMetafileBytes().u32(0, 0, 0, 0, 3).u16(100, 0, 100, 100, 0, 100)), // POLYLINETO16
			emfRecord(61), // CLOSEFIGURE
			emfRecord(60), // ENDPATH
			emfRecord(67, words(5)), // SELECTCLIPPATH RGN_COPY
			emfRecord(37, words(0x80000004)), // 黒のブラシ
			emfRecord(43, words(0, 0, 200, 100)),
			emfRecord(75, words(0, 5)), // EXTSELECTCLIPRGN で外す
			emfRecord(43, words(0, 0, 20, 20)),
		]);
		const result = await convertParadisOfficeMetafile(emf);
		deepStrictEqual(summary(result), { ok: true, format: 'emf', size: [76, 38], elements: 'clipPath path g path path path path' });
	});

	test('draws the GDI records of a dual EMF+ file and refuses EMF+ only drawings, unsupported records, and broken input', async () => {
		const results = await Promise.all([
			convertParadisOfficeMetafile(minimalEmf([emfPlusComment(1, [0x4014]), ...MAPPING, emfRecord(43, words(0, 0, 10, 10))])),
			convertParadisOfficeMetafile(minimalEmf([emfPlusComment(0, [0x4014])])),
			convertParadisOfficeMetafile(minimalEmf([emfRecord(45, words(0, 0, 10, 10, 0, 0, 10, 10))])), // ARC
			convertParadisOfficeMetafile(minimalEmf([emfRecord(37, words(7))], { handles: 4 })),
			convertParadisOfficeMetafile(minimalEmf([emfRecord(33), emfRecord(33)]), { limits: { saveDepth: 1 } }),
			convertParadisOfficeMetafile(minimalEmf([emfRecord(43, words(0, 0, 10, 10))]), { limits: { records: 2 } }),
			convertParadisOfficeMetafile(minimalEmf([emfStretchDib([0, 0, 10, 10], minimalDib(3, 3, new Array(9).fill(0)), 3, 3)]), { limits: { bitmapPixels: 4 } }),
			convertParadisOfficeMetafile(minimalEmf([emfRecord(43, words(0, 0, 0x7fffffff, 10))])),
			convertParadisOfficeMetafile(minimalEmf([]).slice(0, 120)),
			convertParadisOfficeMetafile(new Uint8Array([1, 2, 3])),
		]);
		deepStrictEqual(results.map(summary), [
			{ ok: true, format: 'emf', size: [76, 38], elements: 'path path' },
			{ ok: false, reason: 'unsupported', detail: 'emfPlusOnly' },
			{ ok: false, reason: 'unsupported', detail: 'EMR_ARC' },
			{ ok: false, reason: 'malformed', detail: 'objectIndex' },
			{ ok: false, reason: 'limitExceeded', detail: 'saveDepth' },
			{ ok: false, reason: 'limitExceeded', detail: 'records' },
			{ ok: false, reason: 'limitExceeded', detail: 'bitmapPixels' },
			{ ok: false, reason: 'limitExceeded', detail: 'coordinate' },
			{ ok: false, reason: 'malformed', detail: 'recordSize' },
			{ ok: false, reason: 'notMetafile', detail: 'signature' },
		]);
	});

	test('draws a placeable WMF with a window, a polygon and ANSI text', async () => {
		const wmf = minimalWmf([
			wmfRecord(0x020b, [0, 0]), // SETWINDOWORG
			wmfRecord(0x020c, [500, 1000]), // SETWINDOWEXT（y, x）
			wmfRecord(0x02fc, [0, 0xff00, 0, 0]), // CREATEBRUSHINDIRECT 緑
			wmfRecord(0x012d, [0]),
			wmfRecord(0x0324, [3, 0, 0, 1000, 0, 500, 500]), // POLYGON
			wmfRecord(0x02fb, [100, 0, 0, 0, 400, 0, 0, 0, 0], new TextEncoder().encode('Sample\0')), // CREATEFONTINDIRECT
			wmfRecord(0x012d, [1]),
			wmfRecord(0x0521, [2], new ParadisMetafileBytes().u8(0x48, 0x69).u16(300, 100).toBytes()), // TEXTOUT "Hi"
		]);
		deepStrictEqual({ sniffed: sniffParadisOfficeMetafile(wmf), summary: summary(await convertParadisOfficeMetafile(wmf)) }, {
			sniffed: 'wmf',
			summary: { ok: true, format: 'wmf', size: [96, 48], elements: 'path path text' },
		});
	});

	test('converts package parts whose declared type matches their signature, within the document budget', async () => {
		const emf = minimalEmf([...MAPPING, emfRecord(43, words(0, 0, 10, 10))]);
		const arc = minimalEmf([emfRecord(45, words(0, 0, 10, 10, 0, 0, 10, 10))]);
		const single = await convertParadisOfficeMetafile(emf);
		// 合計の上限は 1 枚ぶんだけにして、2 枚目が入らないことを確かめる。
		const budget = single.ok ? new TextEncoder().encode(single.svg).byteLength : 0;
		const converted = await convertParadisOfficeMetafileParts([
			{ name: 'word/media/image1.emf', bytes: emf, contentType: 'image/x-emf' },
			{ name: 'word/media/image2.wmf', bytes: emf, contentType: 'image/x-wmf' },
			{ name: 'word/media/image3.emf', bytes: arc, contentType: 'image/x-emf' },
			{ name: 'word/media/image4.emf', bytes: emf, contentType: 'IMAGE/EMF' },
		], { documentBytes: budget });
		const late = await convertParadisOfficeMetafileParts([{ name: 'word/media/image1.emf', bytes: emf, contentType: 'image/x-emf' }], { deadline: Date.now() - 1 });
		deepStrictEqual({ converted: [...converted.keys()], late: late.size }, { converted: ['word/media/image1.emf'], late: 0 });
	});

	test('folds rectangle clips, bounds the clip chain, and reuses the lowest free WMF object slot', async () => {
		const rects = Array.from({ length: 10_000 }, (_, index) => emfRecord(30, words(index % 50, 0, 200, 100))); // INTERSECTCLIPRECT
		const started = Date.now();
		const folded = await convertParadisOfficeMetafile(minimalEmf([...MAPPING, ...rects, emfRecord(43, words(0, 0, 200, 100))]));
		const elapsed = Date.now() - started;
		const path = [emfRecord(59), emfRecord(27, words(0, 0)), emfRecord(54, words(10, 10)), emfRecord(54, words(0, 10)), emfRecord(60), emfRecord(67, words(1))];
		const deep = await convertParadisOfficeMetafile(minimalEmf(Array.from({ length: 33 }, () => path).flat()));
		const slots = minimalWmf([
			wmfRecord(0x02fa, [0, 1, 0, 0, 0]), // pen → 0
			wmfRecord(0x02fc, [0, 0x00ff, 0, 0]), // 赤のブラシ → 1
			wmfRecord(0x02fc, [0, 0xff00, 0, 0]), // 緑のブラシ → 2
			wmfRecord(0x01f0, [1]), // 1 を空ける
			wmfRecord(0x02fc, [0, 0, 0x00ff, 0]), // 青のブラシ → 空いた 1
			wmfRecord(0x012d, [1]),
			wmfRecord(0x0324, [3, 0, 0, 1000, 0, 500, 500]),
		], [0, 0, 1000, 500], 3);
		const blue = await convertParadisOfficeMetafile(slots);
		const unplaced = await convertParadisOfficeMetafile(minimalWmf([wmfRecord(0x041b, [500, 1000, 0, 0])]).slice(22));
		deepStrictEqual({
			folded: summary(folded),
			fast: elapsed < 5_000,
			deep: summary(deep),
			blue: blue.ok && blue.svg.includes('fill="#0000ff"'),
			unplaced: summary(unplaced),
		}, {
			folded: { ok: true, format: 'emf', size: [76, 38], elements: 'clipPath path g path path' },
			fast: true,
			deep: { ok: false, reason: 'limitExceeded', detail: 'clipDepth' },
			blue: true,
			unplaced: { ok: false, reason: 'unsupported', detail: 'wmfExtent' },
		});
	});

	test('stops converting a document once its input bytes or records are used up, counting images it could not draw', async () => {
		const arc = minimalEmf([emfRecord(45, words(0, 0, 10, 10, 0, 0, 10, 10))]);
		const emf = minimalEmf([...MAPPING, emfRecord(43, words(0, 0, 10, 10))]);
		const parts = [
			{ name: 'word/media/image1.emf', bytes: arc, contentType: 'image/x-emf' },
			{ name: 'word/media/image2.emf', bytes: emf, contentType: 'image/x-emf' },
		];
		const [byBytes, byRecords, enough] = await Promise.all([
			convertParadisOfficeMetafileParts(parts, { inputBytes: arc.byteLength }),
			convertParadisOfficeMetafileParts(parts, { records: 2 }),
			convertParadisOfficeMetafileParts(parts),
		]);
		deepStrictEqual([byBytes.size, byRecords.size, [...enough.keys()]], [0, 0, ['word/media/image2.emf']]);
	});

	test('yields to the caller while drawing and stops when the caller throws', async () => {
		const many = Array.from({ length: 2100 }, () => emfRecord(18, words(1))); // SETBKMODE
		let calls = 0;
		const drawn = await convertParadisOfficeMetafile(minimalEmf(many), { checkpoint: () => { calls++; } });
		await rejects(convertParadisOfficeMetafile(minimalEmf(many), { checkpoint: () => { throw new Error('cancelled'); } }), /cancelled/);
		deepStrictEqual({ ok: drawn.ok, calls }, { ok: true, calls: 2 });
	});
});
