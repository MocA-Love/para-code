// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { strFromU8, strToU8, zipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { MAX_ZIP_ENTRIES, ZipLimitError, readZipEntries } from '../src/zipEntries.js';
import { zipForTest } from '../src/zipFixtures.js';

/** バイト列の中の `from` をすべて `to`（同じ長さ）に置き換える（zip の名前を書き換えて、同名の項目を 2 つ作る）。 */
function replaceAll(data: Uint8Array, from: string, to: string): Uint8Array {
	const a = strToU8(from);
	const b = strToU8(to);
	const out = data.slice();
	for (let i = 0; i + a.length <= out.length; i++) {
		if (a.every((byte, k) => out[i + k] === byte)) {
			out.set(b, i);
		}
	}
	return out;
}

const text = (map: Map<string, Uint8Array> | undefined) => map === undefined ? undefined : Object.fromEntries([...map].map(([name, value]) => [name, strFromU8(value)]));

/**
 * 1 つの無圧縮（stored）のデータを、名前の違う `count` 個の項目から指す zip を手で組み立てる。中央ディレクトリには
 * 圧縮後の大きさ `compressed`、展開後の大きさ `original` を書く（展開後を小さく偽った重ね zip）。
 */
function overlappingStoredZip(count: number, dataLength: number, compressed: number, original: number): Uint8Array {
	const name = strToU8('a');
	const local = new Uint8Array(30 + name.length + dataLength);
	const view = new DataView(local.buffer);
	view.setUint32(0, 0x04034b50, true);
	view.setUint16(4, 20, true);
	view.setUint16(8, 0, true); // stored
	view.setUint32(18, compressed, true);
	view.setUint32(22, original, true);
	view.setUint16(26, name.length, true);
	local.set(name, 30);
	const centrals: Uint8Array[] = [];
	for (let index = 0; index < count; index++) {
		const entryName = strToU8(`word/e${index}.xml`);
		const central = new Uint8Array(46 + entryName.length);
		const cv = new DataView(central.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint16(10, 0, true); // stored
		cv.setUint32(20, compressed, true);
		cv.setUint32(24, original, true);
		cv.setUint16(28, entryName.length, true);
		cv.setUint32(42, 0, true); // すべて同じ local header を指す
		central.set(entryName, 46);
		centrals.push(central);
	}
	const centralLength = centrals.reduce((sum, item) => sum + item.length, 0);
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, count, true);
	ev.setUint16(10, count, true);
	ev.setUint32(12, centralLength, true);
	ev.setUint32(16, local.length, true);
	const out = new Uint8Array(local.length + centralLength + end.length);
	out.set(local, 0);
	let at = local.length;
	for (const central of centrals) {
		out.set(central, at);
		at += central.length;
	}
	out.set(end, at);
	return out;
}

const limitError = (run: () => unknown) => { try { run(); return 'read'; } catch (e) { return e instanceof ZipLimitError; } };

describe('readZipEntries', () => {
	test('無圧縮の項目で展開後の大きさを偽った重ね zip は、写す前に弾く', () => {
		const mib = 1024 * 1024;
		expect([
			// 展開後 0 と偽り、1MiB のデータを 100 個の名前で指す（そのまま展開すると 100MiB 写される）
			limitError(() => readZipEntries(overlappingStoredZip(100, mib, mib, 0), () => true)),
			// 大きさが正直でも、重ねた合計が上限を超えれば弾く
			limitError(() => readZipEntries(overlappingStoredZip(100, mib, mib, mib), () => true)),
			// 正直で上限に収まるものは読める
			readZipEntries(overlappingStoredZip(3, 4, 4, 4), () => true)?.size,
		]).toEqual([true, true, 3]);
	});

	test('欲しい項目だけを展開し、同名の 2 つ目以降は読まない', () => {
		const overlapped = replaceAll(zipForTest({ 'word/a.xml': 'first', 'word/b.xml': 'second', 'other.txt': 'x' }), 'word/b.xml', 'word/a.xml');
		expect({
			plain: text(readZipEntries(zipForTest({ 'word/a.xml': 'A', 'other.txt': 'x' }), name => name.startsWith('word/'))),
			overlapped: text(readZipEntries(overlapped, name => name.startsWith('word/'))),
			broken: readZipEntries(new Uint8Array([1, 2, 3]), () => true),
		}).toEqual({
			plain: { 'word/a.xml': 'A' },
			overlapped: { 'word/a.xml': 'first' },
			broken: undefined,
		});
	});

	test('展開の合計と項目数の上限を超えたら、展開する前に弾く', () => {
		// 64MiB を少し超える 0 の並び（deflate でとても小さくなる）
		const bomb = zipSync({ 'big.xml': new Uint8Array(64 * 1024 * 1024 + 1) }, { level: 9 });
		const many = zipForTest(Object.fromEntries(Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, index) => [`e${index}`, ''])));
		expect([
			(() => { try { readZipEntries(bomb, () => true); return 'read'; } catch (e) { return e instanceof ZipLimitError; } })(),
			(() => { try { readZipEntries(many, () => false); return 'read'; } catch (e) { return e instanceof ZipLimitError; } })(),
			// 欲しくない項目は大きくても数えない
			readZipEntries(bomb, () => false)?.size,
		]).toEqual([true, true, 0]);
	});
});
