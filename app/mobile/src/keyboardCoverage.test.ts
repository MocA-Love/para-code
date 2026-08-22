// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { keyboardCoverage } from './keyboardCoverage.js';

const IPHONE_HEIGHT = 852;
const IPAD_HEIGHT = 834;

describe('keyboardCoverage', () => {
	test('iPhoneの通常キーボードは覆っている高さを返す', () => {
		expect(keyboardCoverage({ screenY: 516, height: 336 }, IPHONE_HEIGHT)).toBe(336);
	});

	test('ハードウェアキーボードのショートカットバーは覆っていない扱い', () => {
		expect(keyboardCoverage({ screenY: 797, height: 55 }, IPHONE_HEIGHT)).toBe(0);
	});

	test('画面外へ退避したキーボードは0', () => {
		expect(keyboardCoverage({ screenY: 852, height: 336 }, IPHONE_HEIGHT)).toBe(0);
	});

	test('幅が狭くても下端に接していれば覆っている扱いにする（日本語の片手用キーボード）', () => {
		// 幅で弾くと入力欄がキーボードに隠れるため、幅は判定に使わない。
		expect(keyboardCoverage({ screenY: 516, height: 336 }, IPHONE_HEIGHT)).toBe(336);
	});

	test('iPadのドックされたキーボードは覆っている高さを返す', () => {
		expect(keyboardCoverage({ screenY: 481, height: 353 }, IPAD_HEIGHT)).toBe(353);
	});

	test('iPadのフローティングキーボードは画面の中ほどにあると0（シートが画面外へ飛ぶのを防ぐ）', () => {
		// 高さ255のキーボードを画面中央に浮かせた状態。素朴に windowHeight - screenY で
		// 計算すると634ptも覆っていることになってしまう。
		expect(keyboardCoverage({ screenY: 200, height: 255 }, IPAD_HEIGHT)).toBe(0);
	});

	test('端数の丸め誤差では取りこぼさない', () => {
		expect(keyboardCoverage({ screenY: 480.5, height: 353 }, IPAD_HEIGHT)).toBeCloseTo(353.5);
	});

	test('「クロスフェードトランジションを優先」でscreenY=0と報告されても高さぶんを覆っている扱いにする', () => {
		// iOSがこの設定で位置を0で返す既知の挙動。素直に windowHeight - screenY を使うと
		// 852pt（画面全体）を覆っている扱いになり、シートが画面外へ飛ぶ。
		expect(keyboardCoverage({ screenY: 0, height: 336 }, IPHONE_HEIGHT)).toBe(336);
	});

	test('screenY=0でもショートカットバー程度の高さなら覆っていない', () => {
		expect(keyboardCoverage({ screenY: 0, height: 55 }, IPHONE_HEIGHT)).toBe(0);
	});

	test('elementTopを渡しても通常の接地キーボードの判定は従来どおり', () => {
		// 入力バー（上端y=700）が分かっていても、戻り値は「下端からの隠れ量」のまま。
		expect(keyboardCoverage({ screenY: 516, height: 336 }, IPHONE_HEIGHT, 700)).toBe(336);
	});

	test('iPadのフローティングキーボードでも入力バーへ食い込むぶんは覆っている扱いにする', () => {
		// 下端から4pt浮いた高さ230のキーボード（下端=830）。入力バーの上端（y=718）へ
		// 届いているため、elementTop未指定の従来判定では0だったのが持ち上げ量を返す。
		expect(keyboardCoverage({ screenY: 600, height: 230 }, IPAD_HEIGHT, 718)).toBe(234);
	});

	test('入力バーへ届かない位置に浮いたフローティングキーボードはelementTop指定でも0', () => {
		// 画面中央に浮いたキーボード（下端=455）は入力バー（上端y=718）に届かない。
		expect(keyboardCoverage({ screenY: 200, height: 255 }, IPAD_HEIGHT, 718)).toBe(0);
	});

	test('キーボードの下端が入力バーの上端とちょうど接している場合は覆っていない', () => {
		// 食い込みは「下端 > 上端」で判定する。接しているだけなら隠れていない。
		expect(keyboardCoverage({ screenY: 604, height: 114 }, IPAD_HEIGHT, 718)).toBe(0);
	});
});
