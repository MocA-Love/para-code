/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisPtyDaemonStatus,
	paradisDaemonSeverity,
	paradisFormatUptime,
	paradisGroupTerminalsBySpace,
	paradisShortBuildId,
	paradisSpacelessLabel,
} from '../../common/paradisPtyDaemonStatus.js';

const RUNNING: IParadisPtyDaemonStatus = {
	enabled: true,
	running: true,
	pid: 1234,
	buildId: '1.132.0-paracode-72',
	startedAt: 0,
	terminalCount: 7,
	spaces: [],
	foreign: [],
};

suite('ParadisPtyDaemonStatus', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('only colours the entry when leaving it alone costs something', () => {
		assert.deepStrictEqual(
			{
				// 常駐しているのは異常ではないので、平常時は色を持たない。
				normal: paradisDaemonSeverity(RUNNING),
				// 設定を切っている人には、この機能の痕跡すら出さない。
				disabled: paradisDaemonSeverity({ ...RUNNING, enabled: false, running: false }),
				// 有効なのに繋がっていない = 次に閉じたらターミナルが消える。
				notRunning: paradisDaemonSeverity({ ...RUNNING, running: false }),
				// 古い常駐が居座っている = 放っておくと見えないところでメモリを抱え続ける。
				staleBuild: paradisDaemonSeverity({ ...RUNNING, foreign: [{ pid: 9, buildId: 'old', startedAt: 0, terminalCount: undefined }] }),
			},
			{ normal: 'none', disabled: 'none', notRunning: 'error', staleBuild: 'warn' },
		);
	});

	test('says how long without making the number move every second', () => {
		assert.deepStrictEqual(
			[
				paradisFormatUptime(30_000),
				paradisFormatUptime(12 * 60_000),
				paradisFormatUptime(3 * 3_600_000),
				paradisFormatUptime(48 * 3_600_000),
				paradisFormatUptime(52 * 3_600_000),
				paradisFormatUptime(-1),
			],
			['1分未満', '12分', '3時間', '2日', '2日 4時間', '不明'],
		);
	});

	test('shortens the build enough to read, but not so far that builds collide', () => {
		assert.deepStrictEqual(
			{
				// 実運用の形。コミットは40文字あり、そのままでは桁が読めず欄が縦に伸びる。
				release: paradisShortBuildId('1.132.0-edc0d8b80de62fa58e1bcab5a153a337aaa1d7fa'),
				// 開発ビルドはコミットが無い。切る必要も無い。
				dev: paradisShortBuildId('1.132.0-dev'),
				// **切ってはいけない形。** リリース名を版として使うと `-` の後が短く、
				// 8文字で切ると paracode-72 と paracode-73 が同じ文字列に潰れる。
				// 古い常駐と新しい常駐を見分けるための表示なので、ここが潰れると用を成さない。
				tagged: paradisShortBuildId('1.132.0-paracode-72'),
				taggedNext: paradisShortBuildId('1.132.0-paracode-73'),
				noSeparator: paradisShortBuildId('1.132.0'),
				missing: paradisShortBuildId(undefined),
			},
			{
				release: '1.132.0-edc0d8b8',
				dev: '1.132.0-dev',
				tagged: '1.132.0-paracode-72',
				taggedNext: '1.132.0-paracode-73',
				noSeparator: '1.132.0',
				missing: '—',
			},
		);
	});

	test('groups terminals by space, biggest first, unattributed ones last', () => {
		const grouped = paradisGroupTerminalsBySpace([
			{ workspaceName: 'api-server' },
			{ workspaceName: 'para-code' },
			{ workspaceName: '' },
			{ workspaceName: 'para-code' },
			{ workspaceName: '   ' },
			{ workspaceName: 'para-code' },
			{ workspaceName: 'api-server' },
		]);
		// 名前を持たないものは「数が多くても上に来ても嬉しくない」ので最後に置く。
		assert.deepStrictEqual(grouped, [
			{ name: 'para-code', count: 3 },
			{ name: 'api-server', count: 2 },
			{ name: paradisSpacelessLabel(), count: 2 },
		]);
	});
});
