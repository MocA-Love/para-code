/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { StateType } from '../../../../../platform/update/common/update.js';
import { paradisPlanTerminalKeep } from '../../../../common/paradisTerminalKeepPlan.js';
import {
	IParadisUpdateHostGroup,
	IParadisUpdateTerminal,
	IParadisUpdateWindowReport,
	paradisClearUpdateQuitApproved,
	paradisIsUpdateQuitApproved,
	paradisLocalTerminalsAcrossUpdate,
	paradisMarkUpdateQuitApproved,
	paradisMergeKeptPaneTokens,
	paradisMergeUpdateReports,
	paradisNextAfterStopPhase,
	paradisParseKeptPaneTokens,
	paradisPickConfirmWindow,
	paradisShouldNoticeCancelledUpdate,
	paradisShouldStopDaemonOnQuit,
	paradisStopsRemoteForUpdate,
	paradisWorkingAgentKinds,
	paradisResolveUpdateConfirmAnswer,
	paradisSelectOwnOrphans,
	paradisShouldConfirmUpdate,
	paradisShouldNoticeReadyUpdate,
	paradisSortUpdateTerminals,
	paradisUpdateAppliesOnQuit,
	paradisUpdateHostRows,
	paradisUpdateQuitEndsTerminals,
	PARADIS_UPDATE_CONFIRM_TIMEOUT_MS,
	PARADIS_UPDATE_LOCAL_HOST_KEY,
} from '../../common/paradisUpdateTerminals.js';

function terminal(id: number, title: string, extra: Partial<IParadisUpdateTerminal> = {}): IParadisUpdateTerminal {
	return { id, title, busy: false, ...extra };
}

function remoteReport(overrides: Partial<IParadisUpdateWindowReport> = {}): IParadisUpdateWindowReport {
	return {
		hostKey: 'ssh-remote+dev',
		hostLabel: 'dev',
		isRemote: true,
		choice: 'ask',
		acrossUpdate: 'stranded',
		terminals: [terminal(1, 'zsh')],
		...overrides,
	};
}

suite('ParadisUpdateTerminals', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('whether to ask before restarting to update', () => {
		test('asks only when something kept would be ended, and never for the `never` setting or terminals that survive the update', () => {
			const ask = (reports: IParadisUpdateWindowReport[]) => paradisShouldConfirmUpdate(paradisMergeUpdateReports(reports, undefined));
			assert.deepStrictEqual([
				ask([]),
				ask([remoteReport({ terminals: [] })]),
				ask([remoteReport()]),
				ask([remoteReport({ choice: 'always' })]),
				ask([remoteReport({ choice: 'never' })]),
				ask([remoteReport({ acrossUpdate: 'survives' })]),
				// 答えが無かった接続先は、取り残される側で尋ねる（ウィンドウ側で stranded に倒して報告する）
				ask([remoteReport({ acrossUpdate: 'unknown' })]),
			], [false, false, true, true, false, false, true]);
		});

		test('counts this machine only while a per-build daemon is running', () => {
			const local: IParadisUpdateWindowReport = { hostKey: PARADIS_UPDATE_LOCAL_HOST_KEY, hostLabel: 'local', isRemote: false, choice: 'ask', acrossUpdate: 'stranded', terminals: [terminal(7, 'zsh')] };
			const daemon = { stranded: true, terminalCount: 3, choice: 'ask' as const, hostLabel: 'local' };
			assert.deepStrictEqual([
				paradisShouldConfirmUpdate(paradisMergeUpdateReports([local], undefined)),
				paradisShouldConfirmUpdate(paradisMergeUpdateReports([local], { ...daemon, stranded: false })),
				paradisShouldConfirmUpdate(paradisMergeUpdateReports([local], { ...daemon, choice: 'never' })),
				paradisMergeUpdateReports([local], daemon).groups.map(group => [group.terminals.length, group.unlistedCount]),
				// ウィンドウを全部閉じていても、常駐に残したものは数える
				paradisMergeUpdateReports([], daemon).groups.map(group => [group.terminals.length, group.unlistedCount]),
			], [false, false, false, [[1, 2]], [[0, 3]]]);
		});

		test('puts each remote in its own box, merges windows on the same remote, and lists this machine last', () => {
			const summary = paradisMergeUpdateReports([
				{ hostKey: PARADIS_UPDATE_LOCAL_HOST_KEY, hostLabel: 'local', isRemote: false, choice: 'ask', acrossUpdate: 'stranded', terminals: [terminal(9, 'local')] },
				remoteReport({ terminals: [terminal(1, 'a'), terminal(2, 'b')] }),
				remoteReport({ terminals: [terminal(2, 'b'), terminal(3, 'c')] }),
				remoteReport({ hostKey: 'ssh-remote+other', hostLabel: 'other', terminals: [terminal(1, 'x')] }),
			], { stranded: true, terminalCount: 1, choice: 'ask', hostLabel: 'local' });
			assert.deepStrictEqual(summary.groups.map(group => [group.hostLabel, group.terminals.map(t => t.title), group.unlistedCount]), [
				['dev', ['a', 'b', 'c'], 0],
				['other', ['x'], 0],
				['local', ['local'], 0],
			]);
		});
	});

	test('lists working and waiting agents first, then other agents, then busy shells, then idle ones', () => {
		const sorted = paradisSortUpdateTerminals([
			terminal(1, 'idle'),
			terminal(2, 'busy', { busy: true }),
			terminal(3, 'agent-idle', { agent: 'codex' }),
			terminal(4, 'agent-working', { agent: 'claude', agentState: 'working' }),
			terminal(5, 'agent-permission', { agent: 'claude', agentState: 'permission' }),
			terminal(6, 'agent-review', { agent: 'claude', agentState: 'review' }),
			terminal(7, 'unknown-kind-working', { agentState: 'working' }),
			terminal(8, 'busy-2', { busy: true }),
		]);
		assert.deepStrictEqual(sorted.map(t => t.title), ['agent-working', 'agent-permission', 'unknown-kind-working', 'agent-idle', 'agent-review', 'busy', 'busy-2', 'idle']);
	});

	suite('rows of a box', () => {
		function group(count: number, unlistedCount = 0): IParadisUpdateHostGroup {
			return { hostKey: 'k', hostLabel: 'h', isRemote: true, terminals: Array.from({ length: count }, (_, index) => terminal(index, `t${index}`, { busy: index < 2 })), unlistedCount };
		}

		test('shows everything that fits and folds the rest into "<name> and N more"', () => {
			const describe = (rows: ReturnType<typeof paradisUpdateHostRows>) => rows.map(row => row.kind === 'terminal' ? row.terminal.title : `rest:${row.firstTitle}:${row.otherCount}:${row.includesIdle}`);
			assert.deepStrictEqual([
				describe(paradisUpdateHostRows(group(5))),
				describe(paradisUpdateHostRows(group(6))),
				describe(paradisUpdateHostRows(group(17))),
				// 名前の無いもの（閉じたウィンドウから常駐へ残したもの）は最後にまとめる
				describe(paradisUpdateHostRows(group(2, 3))),
				describe(paradisUpdateHostRows(group(0, 4))),
			], [
				['t0', 't1', 't2', 't3', 't4'],
				['t0', 't1', 't2', 't3', 'rest:t4:1:true'],
				['t0', 't1', 't2', 't3', 'rest:t4:12:true'],
				['t0', 't1', 'rest:undefined:3:true'],
				['rest:undefined:4:true'],
			]);
		});
	});

	test('asks in a window that answered, even when another kind of window is in front', () => {
		assert.deepStrictEqual([
			paradisPickConfirmWindow([1, 2], 2, 1),
			// 前面が Agent Sessions のウィンドウ（答えない）なら、前に使っていた答えたウィンドウ
			paradisPickConfirmWindow([1, 2], 9, 1),
			paradisPickConfirmWindow([1, 2], 9, 8),
			paradisPickConfirmWindow([1, 2], undefined, undefined),
			// 答えたウィンドウが無ければ main から OS の確認を出す
			paradisPickConfirmWindow([], 9, 8),
		], [2, 1, 1, 1, undefined]);
	});

	test('notices when terminals were ended but the update then did not happen', () => {
		const run = (states: StateType[]) => states.reduce<'waiting' | 'restarting' | 'cancelled'>((phase, state) => paradisNextAfterStopPhase(phase, state), 'waiting');
		assert.deepStrictEqual([
			run([StateType.Restarting]),
			// 終了が取り消されると、quitAndInstall が Ready に戻す
			run([StateType.Restarting, StateType.Ready]),
			run([StateType.Idle]),
			run([StateType.Ready]),
			run([StateType.Idle, StateType.Restarting]),
		], ['restarting', 'cancelled', 'cancelled', 'waiting', 'cancelled']);
	});

	test('tells about a cancelled update only in a remote window that actually ended something', () => {
		const stops = (isRemote: boolean, choice: 'ask' | 'always' | 'never', acrossUpdate: 'stranded' | 'survives' | 'unknown') => paradisStopsRemoteForUpdate({ isRemote, choice, acrossUpdate });
		assert.deepStrictEqual([
			stops(true, 'ask', 'stranded'),
			stops(true, 'always', 'unknown'),
			// この PC の常駐は main が止める
			stops(false, 'ask', 'stranded'),
			stops(true, 'never', 'stranded'),
			stops(true, 'ask', 'survives'),
			paradisShouldNoticeCancelledUpdate(0),
			paradisShouldNoticeCancelledUpdate(3),
		], [true, true, false, false, false, false, true]);
	});

	test('stops the per-build daemon in the main shutdown only when the quit applies the update', () => {
		const stop = (stateType: StateType, overrides: Partial<Parameters<typeof paradisShouldStopDaemonOnQuit>[0]> = {}) =>
			paradisShouldStopDaemonOnQuit({ stateType, appliesOnQuit: true, daemonStranded: true, choice: 'ask', ...overrides });
		assert.deepStrictEqual([
			stop(StateType.Restarting),
			stop(StateType.Ready),
			stop(StateType.Ready, { appliesOnQuit: false }),
			stop(StateType.Idle),
			stop(StateType.Restarting, { choice: 'never' }),
			stop(StateType.Restarting, { daemonStranded: false }),
		], [true, true, false, false, false, false]);
	});

	test('names how to resume only for the kinds of agents that are working', () => {
		const summary = (terminals: IParadisUpdateTerminal[]) => ({ groups: [{ hostKey: 'k', hostLabel: 'h', isRemote: true, terminals, unlistedCount: 0 }] });
		assert.deepStrictEqual([
			paradisWorkingAgentKinds(summary([terminal(1, 'a', { agent: 'claude', agentState: 'working' }), terminal(2, 'b', { agent: 'codex' })])),
			paradisWorkingAgentKinds(summary([terminal(1, 'a', { agent: 'codex', agentState: 'permission' }), terminal(2, 'b', { agentState: 'working' })])),
		], [
			{ claude: true, codex: false, unknown: false },
			{ claude: false, codex: true, unknown: true },
		]);
	});

	test('treats no answer within 30 seconds as "later", never as "update"', () => {
		assert.deepStrictEqual([
			PARADIS_UPDATE_CONFIRM_TIMEOUT_MS,
			paradisResolveUpdateConfirmAnswer(undefined),
			paradisResolveUpdateConfirmAnswer('later'),
			paradisResolveUpdateConfirmAnswer('update'),
		], [30_000, 'later', 'later', 'update']);
	});

	suite('quitting with an update', () => {
		test('ends kept terminals only when the update replaces where they are kept', () => {
			const ends = (stateType: StateType, approved: boolean, acrossUpdate: 'stranded' | 'survives' | 'unknown', appliesOnQuit = true) =>
				paradisUpdateQuitEndsTerminals({ stateType, appliesOnQuit, approved, acrossUpdate });
			assert.deepStrictEqual([
				ends(StateType.Idle, false, 'stranded'),
				ends(StateType.Ready, false, 'stranded'),
				ends(StateType.Ready, false, 'stranded', false),
				ends(StateType.Restarting, false, 'stranded'),
				ends(StateType.Ready, false, 'unknown'),
				ends(StateType.Ready, false, 'survives'),
				ends(StateType.Idle, true, 'unknown'),
				ends(StateType.Idle, true, 'survives'),
			], [false, true, false, true, false, false, true, false]);
		});

		test('the keep plan ends instead of keeping or asking when the quit applies an update', () => {
			const plan = (isQuit: boolean, isUpdateQuit: boolean, choice: 'ask' | 'always' | 'never') =>
				paradisPlanTerminalKeep({ canOutliveWindow: true, isReload: false, isQuit, isUpdateQuit, choice, persistentTerminalCount: 2 });
			assert.deepStrictEqual([
				plan(true, false, 'ask'),
				plan(true, true, 'ask'),
				plan(true, true, 'always'),
				// 窓を1つ閉じるだけなら更新は当たらない。今までどおり
				plan(false, true, 'ask'),
				plan(false, true, 'always'),
			], ['keep', 'end', 'end', 'ask', 'keep']);
		});

		test('only macOS applies a ready update on a normal quit', () => {
			assert.deepStrictEqual(['darwin', 'win32', 'linux'].map(paradisUpdateAppliesOnQuit), [true, false, false]);
		});

		test('the per-build daemon is stranded by an update; the one that reattaches across updates is not', () => {
			assert.deepStrictEqual([
				paradisLocalTerminalsAcrossUpdate(false, false),
				paradisLocalTerminalsAcrossUpdate(true, false),
				paradisLocalTerminalsAcrossUpdate(false, true),
				paradisLocalTerminalsAcrossUpdate(true, true),
			], ['survives', 'stranded', 'survives', 'survives']);
		});

		test('the approval from "end and update" expires and can be withdrawn', () => {
			paradisMarkUpdateQuitApproved(1_000);
			const fresh = paradisIsUpdateQuitApproved(2_000);
			const stale = paradisIsUpdateQuitApproved(1_000 + 3 * 60 * 1000);
			paradisClearUpdateQuitApproved();
			assert.deepStrictEqual([fresh, stale, paradisIsUpdateQuitApproved(2_000)], [true, false, false]);
		});
	});

	test('tells about a ready update once per version, and only when something would end', () => {
		const notice = (overrides: Partial<Parameters<typeof paradisShouldNoticeReadyUpdate>[0]> = {}) => paradisShouldNoticeReadyUpdate({
			stateType: StateType.Ready,
			appliesOnQuit: true,
			choice: 'ask',
			acrossUpdate: 'stranded',
			terminalCount: 17,
			updateVersion: 'abc',
			noticedVersion: undefined,
			...overrides,
		});
		assert.deepStrictEqual([
			notice(),
			notice({ noticedVersion: 'abc' }),
			notice({ noticedVersion: 'old' }),
			notice({ terminalCount: 0 }),
			notice({ choice: 'never' }),
			notice({ acrossUpdate: 'survives' }),
			notice({ acrossUpdate: 'unknown' }),
			notice({ appliesOnQuit: false }),
			notice({ stateType: StateType.Downloaded }),
		], [true, false, true, false, false, false, false, false, false]);
	});

	suite('only what this machine left', () => {
		test('picks orphans by the pane tokens recorded here, and never the ones another machine left', () => {
			const processes = [
				{ id: 1, paradisPaneToken: 'mine' },
				{ id: 2, paradisPaneToken: 'theirs' },
				{ id: 3 },
				{ id: 4, paradisPaneToken: 'mine-live' },
				{ id: 5, paradisPaneToken: '' },
			];
			assert.deepStrictEqual(paradisSelectOwnOrphans(processes, new Set(['mine', 'mine-live']), new Set([4])).map(process => process.id), [1]);
		});

		test('keeps the recorded tokens bounded and newest last', () => {
			assert.deepStrictEqual([
				paradisParseKeptPaneTokens(undefined),
				paradisParseKeptPaneTokens('not json'),
				paradisParseKeptPaneTokens('["a", 1, "", "b"]'),
				paradisMergeKeptPaneTokens(['a', 'b', 'c'], ['b', 'd'], 3),
			], [[], [], ['a', 'b'], ['c', 'b', 'd']]);
		});
	});
});
