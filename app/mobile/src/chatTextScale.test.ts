// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import {
	CHAT_FONT_SIZE_KEY,
	NEUTRAL_CHAT_TEXT_SCALE,
	chatFontSizeLabel,
	chatTextScaleFor,
	loadChatFontSize,
	normalizeChatFontSize,
	saveChatFontSize,
	scaleChatSize,
	scaleChatStyle,
	scaleChatStyles,
} from './chatTextScale.js';

/** secureKeyStore の代わり（読み書きを Map に持つ）。 */
function memoryStore(initial: Record<string, string> = {}) {
	const items = new Map(Object.entries(initial));
	return {
		items,
		getItem: async (key: string) => items.get(key) ?? null,
		setItem: async (key: string, value: string) => { items.set(key, value); },
		deleteItem: async (key: string) => { items.delete(key); },
	};
}

describe('normalizeChatFontSize', () => {
	it('OS に合わせる・刻みの値はそのまま、数字の文字列も読む', () => {
		expect([
			normalizeChatFontSize('system'),
			normalizeChatFontSize(85),
			normalizeChatFontSize(150),
			normalizeChatFontSize('120'),
		]).toEqual(['system', 85, 150, 120]);
	});

	it('範囲外は端に収め、半端な値はいちばん近い刻みに寄せる', () => {
		expect([
			normalizeChatFontSize(40),
			normalizeChatFontSize(400),
			normalizeChatFontSize(117),
			normalizeChatFontSize(128),
			normalizeChatFontSize(-1),
		]).toEqual([85, 150, 120, 135, 85]);
	});

	it('壊れた値は既定（OS に合わせる）', () => {
		expect([
			normalizeChatFontSize(undefined),
			normalizeChatFontSize(null),
			normalizeChatFontSize(''),
			normalizeChatFontSize('large'),
			normalizeChatFontSize(Number.NaN),
			normalizeChatFontSize(Number.POSITIVE_INFINITY),
			normalizeChatFontSize({ scale: 120 }),
		]).toEqual(['system', 'system', 'system', 'system', 'system', 'system', 'system']);
	});

	it('呼び名', () => {
		expect([chatFontSizeLabel('system'), chatFontSizeLabel(135)]).toEqual(['OS に合わせる', '135%']);
	});
});

describe('保存の読み書き', () => {
	it('保存が無ければ既定、あれば読み直して正規化する', async () => {
		expect(await loadChatFontSize(memoryStore())).toBe('system');
		expect(await loadChatFontSize(memoryStore({ [CHAT_FONT_SIZE_KEY]: '110' }))).toBe(110);
		expect(await loadChatFontSize(memoryStore({ [CHAT_FONT_SIZE_KEY]: '999' }))).toBe(150);
		expect(await loadChatFontSize(memoryStore({ [CHAT_FONT_SIZE_KEY]: '{broken' }))).toBe('system');
	});

	it('書いた値を読み戻せる。既定に戻すと項目を消す', async () => {
		const store = memoryStore();
		await saveChatFontSize(store, 135);
		expect(store.items.get(CHAT_FONT_SIZE_KEY)).toBe('135');
		expect(await loadChatFontSize(store)).toBe(135);
		await saveChatFontSize(store, 200);
		expect(await loadChatFontSize(store)).toBe(150);
		await saveChatFontSize(store, 'system');
		expect(store.items.has(CHAT_FONT_SIZE_KEY)).toBe(false);
		expect(await loadChatFontSize(store)).toBe('system');
	});

	it('読めないとき（Keychain がロック中など）は呼び出し側へ失敗を返す', async () => {
		const store = { getItem: async () => { throw new Error('locked'); } };
		await expect(loadChatFontSize(store)).rejects.toThrow('locked');
	});
});

describe('chatTextScaleFor', () => {
	it('OS に合わせるときは何もかけない（OS の倍率は React Native がかける）', () => {
		expect(chatTextScaleFor('system', 1.5)).toBe(NEUTRAL_CHAT_TEXT_SCALE);
	});

	it('OS が標準なら、文字も見た目も割合そのまま', () => {
		expect(chatTextScaleFor(100, 1)).toBe(NEUTRAL_CHAT_TEXT_SCALE);
		expect(chatTextScaleFor(150, 1)).toEqual({ font: 1.5, layout: 1.5 });
		expect(chatTextScaleFor(85, 1)).toEqual({ font: 0.85, layout: 0.85 });
	});

	it('OS の文字サイズを大きくしていても二重にかけない（文字は OS の倍率で割り戻す）', () => {
		const scale = chatTextScaleFor(120, 1.5);
		expect(scale.layout).toBe(1.2);
		// OS が後でかける 1.5 倍と合わせて、ちょうど 1.2 倍になる
		expect(scale.font * 1.5).toBeCloseTo(1.2, 10);
		expect(chatTextScaleFor(100, 1.25).font * 1.25).toBeCloseTo(1, 10);
	});

	it('OS の倍率が取れないときは 1 とみなし、範囲外の割合は端に収める', () => {
		expect(chatTextScaleFor(150, 0)).toEqual({ font: 1.5, layout: 1.5 });
		expect(chatTextScaleFor(150, Number.NaN)).toEqual({ font: 1.5, layout: 1.5 });
		expect(chatTextScaleFor(300, 1)).toEqual({ font: 1.5, layout: 1.5 });
	});
});

describe('scaleChatStyles', () => {
	const base = {
		body: { fontSize: 14, lineHeight: 20, color: '#fff' },
		row: { paddingVertical: 8, paddingHorizontal: 16, gap: 4, minHeight: 44, width: 32, maxHeight: 200 },
		label: { fontSize: 10, letterSpacing: 0.8, fontWeight: '800' as const },
	};

	it('文字は割合どおり、縦の余白は半分の割合。横の余白・幅・最小と最大の高さは変えない', () => {
		expect(scaleChatStyles(base, chatTextScaleFor(150, 1))).toEqual({
			body: { fontSize: 21, lineHeight: 30, color: '#fff' },
			row: { paddingVertical: 10, paddingHorizontal: 16, gap: 5, minHeight: 44, width: 32, maxHeight: 200 },
			label: { fontSize: 15, letterSpacing: 1.2, fontWeight: '800' },
		});
	});

	it('縮めるときも同じ規則（押せる大きさの minHeight は割らない）', () => {
		expect(scaleChatStyles(base, chatTextScaleFor(85, 1))).toEqual({
			body: { fontSize: 11.9, lineHeight: 17, color: '#fff' },
			row: { paddingVertical: 7.5, paddingHorizontal: 16, gap: 3.5, minHeight: 44, width: 32, maxHeight: 200 },
			label: { fontSize: 8.5, letterSpacing: 0.68, fontWeight: '800' },
		});
	});

	it('無変化なら元の表をそのまま返し、同じ倍率では同じ写しを使い回す', () => {
		expect(scaleChatStyles(base, NEUTRAL_CHAT_TEXT_SCALE)).toBe(base);
		const scale = chatTextScaleFor(120, 1);
		expect(scaleChatStyles(base, scale)).toBe(scaleChatStyles(base, { ...scale }));
		expect(scaleChatStyles(base, scale)).not.toBe(scaleChatStyles(base, chatTextScaleFor(135, 1)));
	});

	it('OS がかける fontSize・lineHeight だけ割り戻し、OS がかけない letterSpacing は割合をそのままかける', () => {
		expect(scaleChatStyle({ fontSize: 14, lineHeight: 20, letterSpacing: 0.8 }, chatTextScaleFor(100, 2))).toEqual({ fontSize: 7, lineHeight: 10, letterSpacing: 0.8 });
		expect(scaleChatStyle({ fontSize: 14, letterSpacing: 0.8 }, chatTextScaleFor(150, 2))).toEqual({ fontSize: 10.5, letterSpacing: 1.2 });
	});

	it('四方まとめた padding は縦の余白と同じく半分の割合', () => {
		expect(scaleChatStyle({ padding: 8, paddingHorizontal: 10 }, chatTextScaleFor(150, 1))).toEqual({ padding: 10, paddingHorizontal: 10 });
	});

	it('アイコンの大きさは見た目の割合をそのままかける', () => {
		expect([
			scaleChatSize(16, chatTextScaleFor(150, 1)),
			scaleChatSize(16, chatTextScaleFor(150, 2)),
			scaleChatSize(15, chatTextScaleFor(85, 1)),
			scaleChatSize(15, NEUTRAL_CHAT_TEXT_SCALE),
		]).toEqual([24, 24, 13, 15]);
	});
});
