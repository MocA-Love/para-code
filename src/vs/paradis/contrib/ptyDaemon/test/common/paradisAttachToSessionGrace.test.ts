/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisShouldReduceGraceOnAttach } from '../../common/paradisAttachToSessionGrace.js';
import { PARADIS_PTY_DAEMON_ENABLED, PARADIS_PTY_HOST_DAEMON_ENABLED } from '../../common/paradisPtyDaemonSettingKey.js';

suite('paradisShouldReduceGraceOnAttach', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function settings(values: Record<string, unknown>) {
		return { getValue: (key: string) => values[key] };
	}

	test('keeps the grace of detached terminals whenever Para Code keeps them on purpose', () => {
		const none = settings({});
		const daemon = settings({ [PARADIS_PTY_DAEMON_ENABLED]: true });
		const reattach = settings({ [PARADIS_PTY_HOST_DAEMON_ENABLED]: true });
		assert.deepStrictEqual({
			localWithoutDaemon: paradisShouldReduceGraceOnAttach(undefined, none, false),
			localDaemon: paradisShouldReduceGraceOnAttach(undefined, daemon, false),
			localReattachAcrossUpdates: paradisShouldReduceGraceOnAttach(undefined, reattach, false),
			// Windows では常駐を使わないので、設定が入っていても upstream どおり
			windowsWithSetting: paradisShouldReduceGraceOnAttach(undefined, reattach, true),
			// SSH の接続先は閉じたウィンドウのターミナルを 24 時間残す
			remote: paradisShouldReduceGraceOnAttach('ssh-remote+example', none, false),
		}, {
			localWithoutDaemon: true,
			localDaemon: false,
			localReattachAcrossUpdates: false,
			windowsWithSetting: true,
			remote: false,
		});
	});
});
