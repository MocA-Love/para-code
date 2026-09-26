// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import {
	TERMINAL_KIND,
	defaultLaunchTarget,
	defaultNewSpaceRepo,
	encodeLaunchTarget,
	launchBlockedReason,
	launchSpaceOptions,
	launchableAgents,
	parseLaunchTarget,
	pcSupportsLaunchIntoSpace,
} from './launchForm.js';

const spaces = [{ id: '1:w1', name: 'alpha', branch: 'main' }, { id: '1:w2', name: 'beta', parent: '1:w1' }];
const repos = [{ id: '1:w1', name: 'alpha' }, { id: '1:r2', name: 'other' }];

describe('起動先', () => {
	test('値は区切り文字を含む ID でも読み戻せる', () => {
		expect(parseLaunchTarget(encodeLaunchTarget({ kind: 'space', spaceId: '1:w1' }))).toEqual({ kind: 'space', spaceId: '1:w1' });
		expect(parseLaunchTarget(encodeLaunchTarget({ kind: 'new', repoId: 'a:b' }))).toEqual({ kind: 'new', repoId: 'a:b' });
		expect(parseLaunchTarget('space:')).toBeUndefined();
		expect(parseLaunchTarget(undefined)).toBeUndefined();
	});

	test('選択肢は既存のスペース → リポジトリごとの新しいスペース', () => {
		const options = launchSpaceOptions(spaces, repos);
		expect(options.map(option => option.label)).toEqual(['alpha', 'beta', '新しいスペース（alpha）', '新しいスペース（other）']);
		expect(options[0]?.hint).toBe('main');
		expect(options.filter(option => option.isNew)).toHaveLength(2);
	});

	test('既定は指定 → PC で開いているスペース → 先頭 → 新しいスペース', () => {
		expect(defaultLaunchTarget({ kind: 'space', spaceId: '1:w2' }, spaces, repos, '1:w1')).toEqual({ kind: 'space', spaceId: '1:w2' });
		expect(defaultLaunchTarget({ kind: 'space', spaceId: 'gone' }, spaces, repos, '1:w2')).toEqual({ kind: 'space', spaceId: '1:w2' });
		expect(defaultLaunchTarget(undefined, spaces, repos, undefined)).toEqual({ kind: 'space', spaceId: '1:w1' });
		expect(defaultLaunchTarget({ kind: 'new', repoId: '1:r2' }, spaces, repos, undefined)).toEqual({ kind: 'new', repoId: '1:r2' });
		expect(defaultLaunchTarget(undefined, [], repos, undefined)).toEqual({ kind: 'new', repoId: '1:w1' });
		expect(defaultLaunchTarget(undefined, [], [], undefined)).toBeUndefined();
	});

	test('新しいスペースの既定のリポジトリはスペースの親', () => {
		expect(defaultNewSpaceRepo(repos, { id: '1:w2', parent: '1:w1' })).toBe('1:w1');
		expect(defaultNewSpaceRepo(repos, { id: '1:r2' })).toBe('1:r2');
		expect(defaultNewSpaceRepo(repos, undefined)).toBe('1:w1');
	});
});

describe('起動できるか', () => {
	const agents = [{ id: 'claude', label: 'Claude', command: 'claude' }, { id: 'gemini', label: 'Gemini' }];
	const base = { live: true, kind: 'claude', target: { kind: 'space' as const, spaceId: '1:w1' }, agents, supportsLaunchIntoSpace: true };

	test('モバイルでは出さないエージェントを除く', () => {
		expect(launchableAgents({ agents }).map(agent => agent.id)).toEqual(['claude']);
		expect(pcSupportsLaunchIntoSpace({ agents })).toBe(true);
		expect(pcSupportsLaunchIntoSpace({ agents: [{ id: 'claude', label: 'Claude' }] })).toBe(false);
	});

	test('押せないときは理由を返す', () => {
		expect(launchBlockedReason(base)).toBeUndefined();
		expect(launchBlockedReason({ ...base, live: false })).toBe('PC に接続すると起動できます。');
		expect(launchBlockedReason({ ...base, target: undefined })).toBe('スペースを選んでください。');
		expect(launchBlockedReason({ ...base, kind: 'unknown' })).toBe('このエージェントは PC に登録されていません。');
		expect(launchBlockedReason({ ...base, supportsLaunchIntoSpace: false })).toMatch(/対応していません/);
	});

	test('旧 PC でも、新しいスペースへの起動とターミナルは押せる', () => {
		expect(launchBlockedReason({ ...base, supportsLaunchIntoSpace: false, target: { kind: 'new', repoId: '1:w1' } })).toBeUndefined();
		expect(launchBlockedReason({ ...base, supportsLaunchIntoSpace: false, kind: TERMINAL_KIND })).toBeUndefined();
	});
});
