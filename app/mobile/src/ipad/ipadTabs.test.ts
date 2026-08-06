// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { SIDEBAR_TABS, activeSidebarTab, shouldReturnHomeOnSpaceChange } from './ipadTabs.js';

describe('activeSidebarTab', () => {
	test('タブ本体のパスはそのタブを選ぶ', () => {
		expect(['/', '/index', '/terminal', '/scm', '/files'].map(activeSidebarTab)).toEqual(['index', 'index', 'terminal', 'scm', 'files']);
	});

	test('ホームから開くスタック画面の間もホームを選択したままにする', () => {
		const fromHome = ['/agent', '/agent-activity', '/agent-activity-detail', '/agent-launch', '/archive', '/notifications', '/browser'];
		expect(fromHome.map(activeSidebarTab)).toEqual(fromHome.map(() => 'index'));
	});

	test('クエリ付きのパスでも判定できる', () => {
		expect(activeSidebarTab('/browser?token=abc%20def')).toBe('index');
	});

	test('タブに属さない設定・ダッシュボード類はどのタブも選ばない', () => {
		const standalone = ['/settings', '/ccusage', '/ratelimit', '/github-usage', '/system', '/changelog', '/space-note', '/pair'];
		expect(standalone.map(activeSidebarTab)).toEqual(standalone.map(() => undefined));
	});

	test('タブ定義はiPhone版の4つと同じ順序・href', () => {
		expect(SIDEBAR_TABS.map(tab => [tab.name, tab.href, tab.label])).toEqual([
			['index', '/', 'ホーム'],
			['terminal', '/terminal', 'ターミナル'],
			['scm', '/scm', 'ソース管理'],
			['files', '/files', 'ファイル'],
		]);
	});
});

describe('shouldReturnHomeOnSpaceChange', () => {
	test('スペースの中身を映しているタブからはホームへ戻す', () => {
		const inSpace = ['/terminal', '/scm', '/files'];
		expect(inSpace.map(shouldReturnHomeOnSpaceChange)).toEqual(inSpace.map(() => true));
	});

	test('ホーム配下のスタック画面（前のスペースのエージェント等）からも戻す', () => {
		const descendants = ['/agent', '/agent-activity', '/browser', '/archive'];
		expect(descendants.map(shouldReturnHomeOnSpaceChange)).toEqual(descendants.map(() => true));
	});

	test('すでにホームなら何もしない', () => {
		expect(['/', '/index'].map(shouldReturnHomeOnSpaceChange)).toEqual([false, false]);
	});

	test('スペースに属さない設定・ダッシュボード類は閉じない', () => {
		const standalone = ['/settings', '/ccusage', '/ratelimit', '/github-usage', '/system', '/changelog'];
		expect(standalone.map(shouldReturnHomeOnSpaceChange)).toEqual(standalone.map(() => false));
	});
});
