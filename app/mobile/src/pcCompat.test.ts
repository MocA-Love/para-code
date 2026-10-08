// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { APP_CAPABILITIES, evaluatePcCompat, pcHasCapability, stateRequestFields, updateRequiredCopy, updateRequiredLabel, updateTargetOf } from './pcCompat.js';
import { pcStatusText } from './pcStatus.js';
import type { PcSummary } from './appState.js';
import { reuseWorkspaceState } from './workspaceIdentity.js';
import type { WorkspaceState } from './store.js';

const summary: PcSummary = {
	id: 'pc1', name: 'Para Code', hue: 0, connection: 'online', pcOnline: true, pairingRejected: false,
	workspaces: 1, terminals: 1, waiting: 0, running: 0, lastOnlineAt: 1, battery: undefined,
};

describe('pcCompat', () => {
	test('State の要求は版・受け入れる PC の最低版・このアプリの機能を広告する', () => {
		expect(stateRequestFields()).toEqual({ protocolVersion: 4, minCompatiblePc: 4, capabilities: APP_CAPABILITIES });
	});

	test('PC の State から、どちらを更新すべきかを決める（版 4 のアプリは版 3 の PC とつながらない）', () => {
		expect([
			{ protocolVersion: 3 },
			{ protocolVersion: 3, minCompatibleMobile: 3 },
			{ protocolVersion: 4 },
			{ protocolVersion: 4, minCompatibleMobile: 4 },
			{ protocolVersion: 5 },
			{ protocolVersion: 5, minCompatibleMobile: 4 },
			{ protocolVersion: 5, minCompatibleMobile: 5 },
			{ protocolVersion: 2 },
			{},
		].map(state => updateTargetOf(evaluatePcCompat(state)) ?? 'ok')).toEqual(['pc', 'pc', 'ok', 'ok', 'app', 'ok', 'app', 'pc', 'pc']);
	});

	test('広告の無い PC は何も持っていない扱い', () => {
		expect([
			pcHasCapability({ capabilities: ['scm.push.v1'] }, 'scm.push.v1'),
			pcHasCapability({ capabilities: [] }, 'scm.push.v1'),
			pcHasCapability({}, 'scm.push.v1'),
			pcHasCapability(undefined, 'scm.push.v1'),
		]).toEqual([true, false, false, false]);
	});

	test('更新が必要な側を、一覧の状態と PC の画面で同じ言葉で出す', () => {
		expect({
			labels: [updateRequiredLabel('app'), updateRequiredLabel('pc')],
			status: [pcStatusText({ ...summary, updateRequired: 'app' }, true), pcStatusText({ ...summary, updateRequired: 'pc' }, false)],
			titles: [updateRequiredCopy('app', 'MacBook').title, updateRequiredCopy('pc', 'MacBook').title],
		}).toEqual({
			labels: ['アプリの更新が必要', 'PC の更新が必要'],
			status: ['アプリの更新が必要 · 使用中', 'PC の更新が必要'],
			titles: ['アプリの更新が必要です', 'PC の更新が必要です'],
		});
	});

	test('PC と共有する判定のファイルは何も import しない（アプリのバンドルへ VS Code 本体を引き込まない）', () => {
		const source = readFileSync(fileURLToPath(new URL('../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileCompat.ts', import.meta.url)), 'utf8');
		expect(source.split('\n').filter(line => /^\s*(?:import|export\s+(?:\*|\{[^}]*\})\s+from)\b|\brequire\(|\bimport\(/.test(line))).toEqual([]);
	});

	test('機能の広告と最低版が変わった State は、同じ参照を使い回さない', () => {
		const base: WorkspaceState = {
			protocolVersion: 4, minCompatibleMobile: 4, capabilities: ['term.sync.v1'], desktopEpoch: 'e', revision: 1, complete: true,
			renderers: [], activeWs: undefined, workspaces: [], terminals: [],
		};
		expect([
			reuseWorkspaceState(base, { ...base, capabilities: ['term.sync.v1'] }) === base,
			reuseWorkspaceState(base, { ...base, capabilities: ['term.sync.v1', 'scm.push.v1'] }) === base,
			reuseWorkspaceState(base, { ...base, minCompatibleMobile: 2 }) === base,
		]).toEqual([true, false, false]);
	});
});
