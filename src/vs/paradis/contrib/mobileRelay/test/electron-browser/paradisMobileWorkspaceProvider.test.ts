/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisResolveLocalAgentPaneCwd, paradisScreenShowsMarker } from '../../electron-browser/paradisMobileWorkspaceProvider.js';

suite('ParadisMobileWorkspaceProvider', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses shell-integration cwd when available', async () => {
		assert.strictEqual(await paradisResolveLocalAgentPaneCwd({
			remoteAuthority: undefined,
			getCwdResource: async () => URI.file('/workspace/detected'),
			getSpeculativeCwd: async () => '/workspace/speculative',
		}), URI.file('/workspace/detected').fsPath);
	});

	test('falls back to speculative cwd for a local terminal without shell integration', async () => {
		assert.strictEqual(await paradisResolveLocalAgentPaneCwd({
			remoteAuthority: undefined,
			getCwdResource: async () => undefined,
			getSpeculativeCwd: async () => '/workspace/naive',
		}), '/workspace/naive');
	});

	test('does not report a local path for a remote terminal', async () => {
		let speculativeCalls = 0;
		assert.strictEqual(await paradisResolveLocalAgentPaneCwd({
			remoteAuthority: 'ssh-remote+host',
			getCwdResource: async () => undefined,
			getSpeculativeCwd: async () => { speculativeCalls++; return '/remote/workspace'; },
		}), undefined);
		assert.strictEqual(speculativeCalls, 0);
	});

	suite('質問が描かれたかの照合', () => {
		test('折り返しの改行と空白を無視して目印を探す', () => {
			// ターミナルは幅で折り返し、境目に改行が入る。Para Code は2Dグリッドで狭いペインが
			// 常態なので、素朴な部分一致だと日本語ラベルはほぼ必ず外れる。
			assert.deepStrictEqual({
				wrapped: paradisScreenShowsMarker('❯ 1. キャッシュ\nを使う\n  2. 作り直す', 'キャッシュを使う'),
				spaced: paradisScreenShowsMarker('❯ 1. Use the cached build', 'Usethecached'),
				absent: paradisScreenShowsMarker('❯ 1. まったく別の選択肢', 'キャッシュを使う'),
				empty: paradisScreenShowsMarker('', 'Alpha'),
			}, {
				wrapped: true,
				spaced: true,
				absent: false,
				empty: false,
			});
		});
	});
});
