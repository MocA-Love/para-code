// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import {
	MAX_SESSION_VIEW_OVERRIDES,
	normalizeSessionViewOverrides,
	otherSessionView,
	resolveSessionView,
	sessionViewKey,
	withSessionViewOverride,
	type SessionViewOverrides,
} from './sessionViewMode.js';

describe('会話表示とターミナル表示', () => {
	test('上書きが無ければ端末ごとの既定、あればそちらを使う', () => {
		const key = sessionViewKey('pc1', 'k');
		expect(resolveSessionView('chat', {}, key)).toBe('chat');
		expect(resolveSessionView('terminal', {}, key)).toBe('terminal');
		const overrides = withSessionViewOverride({}, key, 'terminal', 'chat');
		expect(resolveSessionView('chat', overrides, key)).toBe('terminal');
		expect(resolveSessionView('chat', overrides, sessionViewKey('pc1', 'other'))).toBe('chat');
		expect(resolveSessionView('chat', overrides, undefined)).toBe('chat');
	});

	test('同じターミナルの鍵でも PC が違えば別のタブ', () => {
		expect(sessionViewKey('pc1', 'k')).not.toBe(sessionViewKey('pc2', 'k'));
	});

	test('既定と同じ値に戻したら上書きを消す（既定を後で変えたときに一緒に変わる）', () => {
		const key = sessionViewKey('pc1', 'k');
		const toggled = withSessionViewOverride({}, key, 'terminal', 'chat');
		const back = withSessionViewOverride(toggled, key, otherSessionView('terminal'), 'chat');
		expect(back).toEqual({});
		expect(resolveSessionView('terminal', back, key)).toBe('terminal');
	});

	test('上書きは上限を超えたら古いものから捨て、切り替え直したものは新しい側へ移る', () => {
		let overrides: SessionViewOverrides = {};
		for (let i = 0; i <= MAX_SESSION_VIEW_OVERRIDES; i++) {
			overrides = withSessionViewOverride(overrides, `k${i}`, 'terminal', 'chat');
		}
		const keys = Object.keys(overrides);
		expect(keys).toHaveLength(MAX_SESSION_VIEW_OVERRIDES);
		expect(keys[0]).toBe('k1');
		overrides = withSessionViewOverride(overrides, 'k1', 'terminal', 'chat');
		expect(Object.keys(overrides).at(-1)).toBe('k1');
	});

	test('保存値の読み戻し（壊れた値は捨てる）', () => {
		expect(normalizeSessionViewOverrides(undefined)).toEqual({});
		expect(normalizeSessionViewOverrides('x')).toEqual({});
		expect(normalizeSessionViewOverrides(['terminal'])).toEqual({});
		expect(normalizeSessionViewOverrides({ a: 'chat', b: 'terminal', c: 1 })).toEqual({ a: 'chat', b: 'terminal' });
	});
});
