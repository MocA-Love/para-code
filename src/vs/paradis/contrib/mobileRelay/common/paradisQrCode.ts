/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 依存ゼロの QR コード生成器（byte モード / 誤り訂正レベル M / バージョン自動選択）。
// アルゴリズムは Project Nayuki の QR Code generator (MIT) を参考にした標準実装の移植。
// ペアリング URI (paracode-mobile://pair?...) を PC 画面に QR 表示するために使う。

/** QRコードのモジュール行列（true=黒）を返す。データはISO-8859-1系バイト列として扱う。 */
export function encodeQrCode(text: string): boolean[][] {
	const data = new TextEncoder().encode(text);
	// バージョン自動選択（ECC M）: データが収まる最小バージョンを探す
	for (let version = 1; version <= 40; version++) {
		const capacityBits = getNumDataCodewords(version, EccM) * 8;
		const neededBits = 4 + charCountBits(version) + data.length * 8;
		if (neededBits <= capacityBits) {
			return buildQr(data, version);
		}
	}
	throw new Error('paradisQrCode: data too long for QR code');
}

/** モジュール行列を SVG 文字列にする（quiet zone 4モジュール付き）。 */
export function qrToSvg(modules: boolean[][], moduleSizePx: number = 6): string {
	const n = modules.length;
	const quiet = 4;
	const size = (n + quiet * 2) * moduleSizePx;
	const parts: string[] = [];
	parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`);
	parts.push(`<rect width="${size}" height="${size}" fill="#ffffff"/>`);
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) {
			if (modules[y][x]) {
				parts.push(`<rect x="${(x + quiet) * moduleSizePx}" y="${(y + quiet) * moduleSizePx}" width="${moduleSizePx}" height="${moduleSizePx}" fill="#000000"/>`);
			}
		}
	}
	parts.push('</svg>');
	return parts.join('');
}

// ---- 内部実装 ---------------------------------------------------------------

const EccM = 0; // ECC_CODEWORDS_PER_BLOCK / NUM_ERROR_CORRECTION_BLOCKS のインデックス（M）

// ECC M の各バージョンのブロックあたりECC符号語数（version 1..40）
const ECC_CODEWORDS_M = [
	10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
	26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];
// ECC M のブロック数（version 1..40）
const NUM_BLOCKS_M = [
	1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
	17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];

function charCountBits(version: number): number {
	// byteモードの文字数インジケータ幅
	return version <= 9 ? 8 : 16;
}

function getNumRawDataModules(version: number): number {
	let result = (16 * version + 128) * version + 64;
	if (version >= 2) {
		const numAlign = Math.floor(version / 7) + 2;
		result -= (25 * numAlign - 10) * numAlign - 55;
		if (version >= 7) {
			result -= 36;
		}
	}
	return result;
}

function getNumDataCodewords(version: number, _ecc: number): number {
	return Math.floor(getNumRawDataModules(version) / 8) - ECC_CODEWORDS_M[version - 1] * NUM_BLOCKS_M[version - 1];
}

function buildQr(data: Uint8Array, version: number): boolean[][] {
	// --- ビット列を組み立て（byteモード） ---
	const bits: number[] = [];
	appendBits(0b0100, 4, bits); // byte mode
	appendBits(data.length, charCountBits(version), bits);
	for (const b of data) {
		appendBits(b, 8, bits);
	}
	const capacityBits = getNumDataCodewords(version, EccM) * 8;
	// ターミネータ + バイト境界パディング
	appendBits(0, Math.min(4, capacityBits - bits.length), bits);
	appendBits(0, (8 - bits.length % 8) % 8, bits);
	// パディングバイト 0xEC/0x11 交互
	for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) {
		appendBits(pad, 8, bits);
	}
	const dataCodewords = new Uint8Array(bits.length / 8);
	bits.forEach((bit, i) => { dataCodewords[i >> 3] |= bit << (7 - (i & 7)); });

	// --- Reed-Solomon ECC をブロックごとに付加してインターリーブ ---
	const allCodewords = addEccAndInterleave(dataCodewords, version);

	// --- モジュール配置 ---
	const size = version * 4 + 17;
	const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
	const isFunction: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

	drawFunctionPatterns(modules, isFunction, version, size);
	drawCodewords(modules, isFunction, allCodewords, size);

	// --- マスク選択（ペナルティ最小） ---
	let bestMask = 0;
	let minPenalty = Infinity;
	for (let mask = 0; mask < 8; mask++) {
		applyMask(modules, isFunction, mask, size);
		drawFormatBits(modules, isFunction, mask, size);
		const penalty = getPenaltyScore(modules, size);
		if (penalty < minPenalty) {
			minPenalty = penalty;
			bestMask = mask;
		}
		applyMask(modules, isFunction, mask, size); // XOR なので再適用で元に戻る
	}
	applyMask(modules, isFunction, bestMask, size);
	drawFormatBits(modules, isFunction, bestMask, size);
	return modules;
}

function appendBits(value: number, length: number, bits: number[]): void {
	for (let i = length - 1; i >= 0; i--) {
		bits.push((value >>> i) & 1);
	}
}

function addEccAndInterleave(data: Uint8Array, version: number): Uint8Array {
	const numBlocks = NUM_BLOCKS_M[version - 1];
	const blockEccLen = ECC_CODEWORDS_M[version - 1];
	const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
	const numShortBlocks = numBlocks - rawCodewords % numBlocks;
	const shortBlockLen = Math.floor(rawCodewords / numBlocks);

	const blocks: Uint8Array[] = [];
	const rsDiv = reedSolomonComputeDivisor(blockEccLen);
	for (let i = 0, k = 0; i < numBlocks; i++) {
		const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
		k += dat.length;
		const ecc = reedSolomonComputeRemainder(dat, rsDiv);
		const block = new Uint8Array(shortBlockLen + 1);
		block.set(dat, 0);
		block.set(ecc, shortBlockLen + 1 - blockEccLen);
		blocks.push(block);
	}

	const result = new Uint8Array(rawCodewords);
	let idx = 0;
	for (let i = 0; i < blocks[0].length; i++) {
		for (let j = 0; j < blocks.length; j++) {
			// 短いブロックはデータ末尾1バイト分の位置をスキップ
			if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
				result[idx++] = blocks[j][i];
			}
		}
	}
	return result;
}

function reedSolomonComputeDivisor(degree: number): Uint8Array {
	const result = new Uint8Array(degree);
	result[degree - 1] = 1;
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < degree; j++) {
			result[j] = reedSolomonMultiply(result[j], root);
			if (j + 1 < degree) {
				result[j] ^= result[j + 1];
			}
		}
		root = reedSolomonMultiply(root, 0x02);
	}
	return result;
}

function reedSolomonComputeRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
	const result = new Uint8Array(divisor.length);
	for (const b of data) {
		const factor = b ^ result[0];
		result.copyWithin(0, 1);
		result[result.length - 1] = 0;
		for (let i = 0; i < result.length; i++) {
			result[i] ^= reedSolomonMultiply(divisor[i], factor);
		}
	}
	return result;
}

function reedSolomonMultiply(x: number, y: number): number {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z;
}

function drawFunctionPatterns(modules: boolean[][], isFunction: boolean[][], version: number, size: number): void {
	// タイミングパターン
	for (let i = 0; i < size; i++) {
		setFunctionModule(modules, isFunction, 6, i, i % 2 === 0);
		setFunctionModule(modules, isFunction, i, 6, i % 2 === 0);
	}
	// 位置検出パターン（3隅）
	drawFinderPattern(modules, isFunction, 3, 3, size);
	drawFinderPattern(modules, isFunction, size - 4, 3, size);
	drawFinderPattern(modules, isFunction, 3, size - 4, size);
	// 位置合わせパターン
	const alignPos = getAlignmentPatternPositions(version);
	const numAlign = alignPos.length;
	for (let i = 0; i < numAlign; i++) {
		for (let j = 0; j < numAlign; j++) {
			if (!(i === 0 && j === 0 || i === 0 && j === numAlign - 1 || i === numAlign - 1 && j === 0)) {
				drawAlignmentPattern(modules, isFunction, alignPos[i], alignPos[j]);
			}
		}
	}
	// フォーマット情報の領域を予約（後で drawFormatBits が上書き）
	drawFormatBits(modules, isFunction, 0, size);
	// バージョン情報（v7+）
	if (version >= 7) {
		let rem = version;
		for (let i = 0; i < 12; i++) {
			rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
		}
		const bits = version << 12 | rem;
		for (let i = 0; i < 18; i++) {
			const bit = ((bits >>> i) & 1) !== 0;
			const a = size - 11 + i % 3;
			const b = Math.floor(i / 3);
			setFunctionModule(modules, isFunction, a, b, bit);
			setFunctionModule(modules, isFunction, b, a, bit);
		}
	}
}

function drawFinderPattern(modules: boolean[][], isFunction: boolean[][], cx: number, cy: number, size: number): void {
	for (let dy = -4; dy <= 4; dy++) {
		for (let dx = -4; dx <= 4; dx++) {
			const dist = Math.max(Math.abs(dx), Math.abs(dy));
			const x = cx + dx;
			const y = cy + dy;
			if (x >= 0 && x < size && y >= 0 && y < size) {
				setFunctionModule(modules, isFunction, x, y, dist !== 2 && dist !== 4);
			}
		}
	}
}

function drawAlignmentPattern(modules: boolean[][], isFunction: boolean[][], cx: number, cy: number): void {
	for (let dy = -2; dy <= 2; dy++) {
		for (let dx = -2; dx <= 2; dx++) {
			setFunctionModule(modules, isFunction, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
		}
	}
}

function getAlignmentPatternPositions(version: number): number[] {
	if (version === 1) {
		return [];
	}
	const numAlign = Math.floor(version / 7) + 2;
	const size = version * 4 + 17;
	const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
	const result = [6];
	for (let pos = size - 7; result.length < numAlign; pos -= step) {
		result.splice(1, 0, pos);
	}
	return result;
}

function setFunctionModule(modules: boolean[][], isFunction: boolean[][], x: number, y: number, isDark: boolean): void {
	modules[y][x] = isDark;
	isFunction[y][x] = true;
}

function drawCodewords(modules: boolean[][], isFunction: boolean[][], data: Uint8Array, size: number): void {
	let i = 0;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) {
			right = 5;
		}
		for (let vert = 0; vert < size; vert++) {
			for (let j = 0; j < 2; j++) {
				const x = right - j;
				const upward = ((right + 1) & 2) === 0;
				const y = upward ? size - 1 - vert : vert;
				if (!isFunction[y][x] && i < data.length * 8) {
					modules[y][x] = ((data[i >> 3] >>> (7 - (i & 7))) & 1) !== 0;
					i++;
				}
			}
		}
	}
}

function applyMask(modules: boolean[][], isFunction: boolean[][], mask: number, size: number): void {
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			let invert: boolean;
			switch (mask) {
				case 0: invert = (x + y) % 2 === 0; break;
				case 1: invert = y % 2 === 0; break;
				case 2: invert = x % 3 === 0; break;
				case 3: invert = (x + y) % 3 === 0; break;
				case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
				case 5: invert = x * y % 2 + x * y % 3 === 0; break;
				case 6: invert = (x * y % 2 + x * y % 3) % 2 === 0; break;
				default: invert = ((x + y) % 2 + x * y % 3) % 2 === 0; break;
			}
			if (!isFunction[y][x] && invert) {
				modules[y][x] = !modules[y][x];
			}
		}
	}
}

function drawFormatBits(modules: boolean[][], isFunction: boolean[][], mask: number, size: number): void {
	// ECC M = 0b00
	const dataBits = 0b00 << 3 | mask;
	let rem = dataBits;
	for (let i = 0; i < 10; i++) {
		rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
	}
	const bits = (dataBits << 10 | rem) ^ 0x5412;

	for (let i = 0; i <= 5; i++) {
		setFunctionModule(modules, isFunction, 8, i, ((bits >>> i) & 1) !== 0);
	}
	setFunctionModule(modules, isFunction, 8, 7, ((bits >>> 6) & 1) !== 0);
	setFunctionModule(modules, isFunction, 8, 8, ((bits >>> 7) & 1) !== 0);
	setFunctionModule(modules, isFunction, 7, 8, ((bits >>> 8) & 1) !== 0);
	for (let i = 9; i < 15; i++) {
		setFunctionModule(modules, isFunction, 14 - i, 8, ((bits >>> i) & 1) !== 0);
	}
	for (let i = 0; i < 8; i++) {
		setFunctionModule(modules, isFunction, size - 1 - i, 8, ((bits >>> i) & 1) !== 0);
	}
	for (let i = 8; i < 15; i++) {
		setFunctionModule(modules, isFunction, 8, size - 15 + i, ((bits >>> i) & 1) !== 0);
	}
	setFunctionModule(modules, isFunction, 8, size - 8, true); // 固定黒モジュール
}

function getPenaltyScore(modules: boolean[][], size: number): number {
	let result = 0;
	// 横方向の連続
	for (let y = 0; y < size; y++) {
		let runColor = false;
		let runX = 0;
		const runHistory = [0, 0, 0, 0, 0, 0, 0];
		for (let x = 0; x < size; x++) {
			if (modules[y][x] === runColor) {
				runX++;
				if (runX === 5) {
					result += 3;
				} else if (runX > 5) {
					result++;
				}
			} else {
				finderPenaltyAddHistory(runX, runHistory, size);
				if (!runColor) {
					result += finderPenaltyCountPatterns(runHistory) * 40;
				}
				runColor = modules[y][x];
				runX = 1;
			}
		}
		result += finderPenaltyTerminateAndCount(runColor, runX, runHistory, size) * 40;
	}
	// 縦方向の連続
	for (let x = 0; x < size; x++) {
		let runColor = false;
		let runY = 0;
		const runHistory = [0, 0, 0, 0, 0, 0, 0];
		for (let y = 0; y < size; y++) {
			if (modules[y][x] === runColor) {
				runY++;
				if (runY === 5) {
					result += 3;
				} else if (runY > 5) {
					result++;
				}
			} else {
				finderPenaltyAddHistory(runY, runHistory, size);
				if (!runColor) {
					result += finderPenaltyCountPatterns(runHistory) * 40;
				}
				runColor = modules[y][x];
				runY = 1;
			}
		}
		result += finderPenaltyTerminateAndCount(runColor, runY, runHistory, size) * 40;
	}
	// 2x2 ブロック
	for (let y = 0; y < size - 1; y++) {
		for (let x = 0; x < size - 1; x++) {
			const color = modules[y][x];
			if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) {
				result += 3;
			}
		}
	}
	// 黒モジュール比率
	let dark = 0;
	for (const row of modules) {
		dark = row.reduce((sum, color) => sum + (color ? 1 : 0), dark);
	}
	const total = size * size;
	const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
	result += k * 10;
	return result;
}

function finderPenaltyCountPatterns(runHistory: number[]): number {
	const n = runHistory[1];
	const core = n > 0 && runHistory[2] === n && runHistory[3] === n * 3 && runHistory[4] === n && runHistory[5] === n;
	return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0)
		+ (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0);
}

function finderPenaltyTerminateAndCount(currentRunColor: boolean, currentRunLength: number, runHistory: number[], size: number): number {
	if (currentRunColor) {
		finderPenaltyAddHistory(currentRunLength, runHistory, size);
		currentRunLength = 0;
	}
	currentRunLength += size;
	finderPenaltyAddHistory(currentRunLength, runHistory, size);
	return finderPenaltyCountPatterns(runHistory);
}

function finderPenaltyAddHistory(currentRunLength: number, runHistory: number[], size: number): void {
	if (runHistory[0] === 0) {
		currentRunLength += size;
	}
	runHistory.pop();
	runHistory.unshift(currentRunLength);
}
