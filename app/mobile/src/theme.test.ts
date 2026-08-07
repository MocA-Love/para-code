// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { withAlpha } from './theme.js';

/**
 * `withAlpha` は「色に不透明度を足す唯一の口」。呼び出し側が `color + '33'` のように
 * 桁を連結していた頃は、二重に足されて `#RRGGBBAAAA` という無効色になり、RNの正規化が
 * 警告なく null を返して下地ごと消える事故が起きていた（voiceNotificationControl の
 * ガラス面が iOS 25 以下で真っ透明になっていた）。その再発を止めるためのテスト。
 */
describe('withAlpha', () => {
	test('6桁hexに不透明度を足す', () => {
		expect(withAlpha('#09AFD9', 0.2)).toBe('#09AFD933');
		expect(withAlpha('#000000', 0)).toBe('#00000000');
	});

	test('3桁hexは展開してから足す', () => {
		expect(withAlpha('#0AF', 0.2)).toBe('#00AAFF33');
	});

	test('不透明度1なら色をそのまま返す（ガラスのtintは不透明色を前提にするAPI）', () => {
		expect(withAlpha('#09AFD9', 1)).toBe('#09AFD9');
		expect(withAlpha('rgba(1,2,3,0.5)', 1)).toBe('rgba(1,2,3,0.5)');
	});

	test('既に不透明度が付いた色を渡しても二重に足さない', () => {
		expect(withAlpha('#09AFD933', 0.2)).toBeUndefined();
	});

	test('hex以外は色被せを諦める（PCから任意の文字列が届くため、不透明のまま通さない）', () => {
		expect(withAlpha('rgba(9,175,217,0.5)', 0.2)).toBeUndefined();
		expect(withAlpha('red', 0.2)).toBeUndefined();
	});

	test('範囲外の不透明度は下限で止める', () => {
		expect(withAlpha('#09AFD9', -1)).toBe('#09AFD900');
	});
});
