// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { unzipSync, type UnzipFileInfo } from 'fflate';

/** 展開後の合計の上限（zip 爆弾で端末の記憶を使い切らない）。 */
export const MAX_ZIP_TOTAL_BYTES = 64 * 1024 * 1024;
/** 中央ディレクトリの項目数の上限（読まない項目も数える。巨大な目次で時間を使い切らない）。 */
export const MAX_ZIP_ENTRIES = 5000;

/** 上限を超えた zip（呼び出し側は「大きすぎる」として扱う）。 */
export class ZipLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ZipLimitError';
	}
}

/**
 * zip（Office の OOXML など）から、`wanted` が真を返す名前の項目だけを展開する。
 *
 * - 項目数が {@link MAX_ZIP_ENTRIES} を超える、または展開する項目の宣言の大きさ（圧縮後と展開後の大きい方）の合計が {@link MAX_ZIP_TOTAL_BYTES} を
 *   超えるときは {@link ZipLimitError} を投げる（展開する前に弾く）。展開した後の実際の合計も確かめる
 * - 同じ名前の項目が 2 つ以上ある（重なった zip）ときは、最初の 1 つだけを読む
 * - zip として読めなければ undefined
 */
export function readZipEntries(data: Uint8Array, wanted: (name: string) => boolean): Map<string, Uint8Array> | undefined {
	let entries = 0;
	let declared = 0;
	const seen = new Set<string>();
	const filter = (file: UnzipFileInfo): boolean => {
		entries++;
		if (entries > MAX_ZIP_ENTRIES) {
			throw new ZipLimitError(`zip has more than ${MAX_ZIP_ENTRIES} entries`);
		}
		if (seen.has(file.name) || !wanted(file.name)) {
			return false;
		}
		seen.add(file.name);
		// 無圧縮（stored）の項目は fflate が圧縮後の大きさ（`size`）の分だけ写す。宣言の展開後の大きさ（`originalSize`）と
		// 食い違う項目は不正として弾き、数えるのは大きい方にする（小さな展開後の大きさを宣言した項目を同じデータに
		// たくさん重ねて、上限をすり抜けて記憶を使い切らせないため）
		if (file.compression === 0 && file.size !== file.originalSize) {
			throw new ZipLimitError('stored zip entry declares inconsistent sizes');
		}
		declared += Math.max(file.size, file.originalSize, 0);
		if (declared > MAX_ZIP_TOTAL_BYTES) {
			throw new ZipLimitError('zip expands beyond the limit');
		}
		return true;
	};
	let files: Record<string, Uint8Array>;
	try {
		files = unzipSync(data, { filter });
	} catch (error) {
		if (error instanceof ZipLimitError) {
			throw error;
		}
		return undefined;
	}
	let total = 0;
	for (const value of Object.values(files)) {
		total += value.byteLength;
	}
	if (total > MAX_ZIP_TOTAL_BYTES) {
		throw new ZipLimitError('zip expands beyond the limit');
	}
	return new Map(Object.entries(files));
}
