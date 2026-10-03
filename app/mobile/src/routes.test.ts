// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { encodeSessionTab, firstParam, parseSessionTab, routes } from './routes.js';

describe('セッションのタブのクエリ', () => {
	test('ターミナルのタブは terminalKey を、ブラウザは固定の語を載せる', () => {
		expect(encodeSessionTab({ kind: 'terminal', terminalKey: 'key-a' })).toBe('terminal:key-a');
		expect(encodeSessionTab({ kind: 'browser' })).toBe('browser');
	});

	test('載せた値はそのまま読み戻せる（terminalKey に区切り文字が入っていても）', () => {
		for (const terminalKey of ['key-a', 'a:b:c', 'terminal:x', '日本語のキー']) {
			expect(parseSessionTab(encodeSessionTab({ kind: 'terminal', terminalKey }))).toEqual({ kind: 'terminal', terminalKey });
		}
		expect(parseSessionTab('browser')).toEqual({ kind: 'browser' });
	});

	test('形の違う値・空は「指定なし」として扱う', () => {
		expect(parseSessionTab(undefined)).toBeUndefined();
		expect(parseSessionTab('')).toBeUndefined();
		expect(parseSessionTab('terminal:')).toBeUndefined();
		expect(parseSessionTab('agent')).toBeUndefined();
	});

	test('同じ名前のクエリが複数あれば先頭を使う', () => {
		expect(parseSessionTab(['browser', 'terminal:x'])).toEqual({ kind: 'browser' });
		expect(firstParam(['a', 'b'])).toBe('a');
		expect(firstParam([])).toBeUndefined();
	});
});

describe('routes', () => {
	test('PC とスペースの ID はパスに直接つながず params で渡す（expo-router に符号化させる）', () => {
		expect(routes.pc('pc-1')).toEqual({ pathname: '/pc/[pcId]', params: { pcId: 'pc-1' } });
		expect(routes.session('pc-1', '1:w1')).toEqual({
			pathname: '/pc/[pcId]/session/[spaceId]',
			params: { pcId: 'pc-1', spaceId: '1:w1' },
		});
	});

	test('セッションはタブと「新しく開いた」印をクエリで受ける', () => {
		expect(routes.session('pc-1', '1:w1', { tab: { kind: 'terminal', terminalKey: 'k' }, latest: 'tok' })).toEqual({
			pathname: '/pc/[pcId]/session/[spaceId]',
			params: { pcId: 'pc-1', spaceId: '1:w1', tab: 'terminal:k', latest: 'tok' },
		});
	});

	test('ソース管理・差分・ファイルはスペースの下', () => {
		expect(routes.sourceControl('p', 's')).toEqual({ pathname: '/pc/[pcId]/source-control/[spaceId]', params: { pcId: 'p', spaceId: 's' } });
		expect(routes.review('p', 's', 'src/a.ts')).toEqual({ pathname: '/pc/[pcId]/review/[spaceId]', params: { pcId: 'p', spaceId: 's', path: 'src/a.ts' } });
		expect(routes.files('p', 's')).toEqual({ pathname: '/pc/[pcId]/files/[spaceId]', params: { pcId: 'p', spaceId: 's' } });
	});

	test('メモはスペースの下、サブエージェントはセッションの下（ターミナルと会話のセッションはクエリ）', () => {
		expect(routes.note('p', 's')).toEqual({ pathname: '/pc/[pcId]/note/[spaceId]', params: { pcId: 'p', spaceId: 's' } });
		expect(routes.activity('p', 's', 'k', 'e1')).toEqual({
			pathname: '/pc/[pcId]/session/[spaceId]/activity',
			params: { pcId: 'p', spaceId: 's', terminal: 'k', epoch: 'e1' },
		});
		expect(routes.activity('p', 's', 'k')).toEqual({
			pathname: '/pc/[pcId]/session/[spaceId]/activity',
			params: { pcId: 'p', spaceId: 's', terminal: 'k' },
		});
		expect(routes.activityAgent('p', 's', 'k', 'a1', 'e1')).toEqual({
			pathname: '/pc/[pcId]/session/[spaceId]/activity/[agentId]',
			params: { pcId: 'p', spaceId: 's', agentId: 'a1', terminal: 'k', epoch: 'e1' },
		});
		expect(routes.activityAdvisor('p', 's', 'k', 'srvtoolu_1', 'e1')).toEqual({
			pathname: '/pc/[pcId]/session/[spaceId]/activity/advisor/[advisorId]',
			params: { pcId: 'p', spaceId: 's', advisorId: 'srvtoolu_1', terminal: 'k', epoch: 'e1' },
		});
	});

	test('根の画面', () => {
		expect(routes.home()).toBe('/');
		expect(routes.notifications()).toBe('/notifications');
		expect(routes.settings()).toBe('/settings');
		expect(routes.settings('usage')).toBe('/settings/usage');
		expect(routes.pair()).toBe('/pair');
		expect(routes.onboarding()).toBe('/onboarding');
	});
});
