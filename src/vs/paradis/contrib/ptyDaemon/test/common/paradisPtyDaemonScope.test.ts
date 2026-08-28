/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	paradisDaemonForeignStopTitle,
	paradisDaemonLeadText,
	paradisDaemonNotRunningSub,
	paradisDaemonRestartTitle,
	paradisDaemonScopeFor,
	paradisDaemonScopeLine,
	paradisDaemonSharedHostWarning,
	paradisDaemonStatusAria,
	paradisDaemonStatusTooltip,
	paradisDaemonStopTitle,
} from '../../common/paradisPtyDaemonScope.js';
import { IParadisPtyDaemonStatus } from '../../common/paradisPtyDaemonStatus.js';

const RUNNING: IParadisPtyDaemonStatus = {
	enabled: true,
	running: true,
	pid: 1234,
	buildId: '1.135.0-8e7a25c9',
	startedAt: 0,
	terminalCount: 12,
	spaces: [],
	foreign: [],
};

const LOCAL = paradisDaemonScopeFor(undefined, undefined);
const REMOTE = paradisDaemonScopeFor('ssh-remote+box', 'box');
const UNNAMED_REMOTE = paradisDaemonScopeFor('ssh-remote+box', '   ');

suite('ParadisPtyDaemonScope', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the machine off the remote authority, not off the label', () => {
		assert.deepStrictEqual(
			{
				// 接続先が無ければこの PC。名前があってもそれだけでは接続先にしない。
				local: paradisDaemonScopeFor(undefined, 'box'),
				remote: REMOTE,
				// 名前がまだ解決していない接続先。「接続先  の常駐」にならないよう名前は捨てる。
				unnamed: UNNAMED_REMOTE,
			},
			{
				local: { isRemote: false, hostLabel: undefined },
				remote: { isRemote: true, hostLabel: 'box' },
				unnamed: { isRemote: true, hostLabel: undefined },
			},
		);
	});

	test('says which machine everywhere a stop can be triggered from', () => {
		// **どれか1つでも機械を言い忘れると、そこから取り違えたまま押せる。** 名前が取れない
		// 接続先でも「接続先」とだけは必ず言う。
		const said = [
			paradisDaemonScopeLine(REMOTE),
			paradisDaemonStatusTooltip(REMOTE, RUNNING),
			paradisDaemonStatusAria(REMOTE, RUNNING),
			paradisDaemonLeadText(REMOTE, RUNNING),
			paradisDaemonRestartTitle(REMOTE),
			paradisDaemonStopTitle(REMOTE),
			paradisDaemonForeignStopTitle(REMOTE),
			paradisDaemonRestartTitle(UNNAMED_REMOTE),
			paradisDaemonStopTitle(UNNAMED_REMOTE),
		];
		assert.deepStrictEqual(said.map(text => text?.includes('接続先')), said.map(() => true));
	});

	test('leaves this PC talking the way it always did', () => {
		// この PC の常駐は既定の状態なので、断り書きも接続先向けの注意も足さない。
		assert.deepStrictEqual(
			{
				line: paradisDaemonScopeLine(LOCAL),
				shared: paradisDaemonSharedHostWarning(LOCAL),
				mentionsRemote: [
					paradisDaemonStatusTooltip(LOCAL, RUNNING),
					paradisDaemonLeadText(LOCAL, RUNNING),
					paradisDaemonNotRunningSub(LOCAL),
					paradisDaemonStopTitle(LOCAL),
				].some(text => text.includes('接続先')),
			},
			{ line: undefined, shared: undefined, mentionsRemote: false },
		);
	});

	test('never turns "could not ask" into "nothing is running"', () => {
		// 本数が分からないときに 0 と読める文を出さない。押した先が取り返しのつかない操作なので、
		// ここで嘘をつくのが一番まずい。
		const unknown = { ...RUNNING, terminalCount: undefined };
		assert.deepStrictEqual(
			[
				paradisDaemonStatusTooltip(REMOTE, unknown),
				paradisDaemonStatusAria(REMOTE, unknown),
				paradisDaemonLeadText(REMOTE, unknown),
			].map(text => text.includes('0本') || text.includes('ありません')),
			[false, false, false],
		);
	});

	test('warns that a shared host loses other windows too', () => {
		// 接続先には他のクライアントも繋がり得る。この PC では起きない差なので、接続先でだけ足す。
		assert.strictEqual(paradisDaemonSharedHostWarning(REMOTE)?.includes('他のウィンドウ'), true);
	});
});
