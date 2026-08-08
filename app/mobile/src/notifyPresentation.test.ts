// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { notifySubtitle } from './notifyPresentation.js';

/**
 * 副題の組み立てを固定するテスト。同じ規則を通知拡張（NotificationService.swift の
 * composeSubtitle）が Swift 側にも持っているので、ここを変えるときは向こうも直すこと。
 */
describe('notifySubtitle', () => {
	test('PC名は2台以上のときだけ足す', () => {
		expect([
			notifySubtitle('Claude', 'MacBook Pro', true),
			notifySubtitle('Claude', 'MacBook Pro', false),
		]).toEqual(['Claude · MacBook Pro', 'Claude']);
	});

	test('欠けている材料は詰めて出す（区切りだけが残らない）', () => {
		expect([
			// 副題を知らない旧PCから、PC名だけ届いた
			notifySubtitle(undefined, 'MacBook Pro', true),
			// PC名が空白しかない
			notifySubtitle('Codex', '   ', true),
			// 何も無ければ副題そのものを出さない
			notifySubtitle(undefined, undefined, true),
			notifySubtitle('  ', undefined, false),
		]).toEqual(['MacBook Pro', 'Codex', undefined, undefined]);
	});
});
