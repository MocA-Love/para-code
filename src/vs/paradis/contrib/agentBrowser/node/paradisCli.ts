/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `para` コマンドの入口。ランチャー（`resources/paradis/cli/para`・`para.cmd`）が
// `node out/vs/paradis/contrib/agentBrowser/node/paradisCli.js <引数...>` として単体で実行する
// （手元では Para Code 自身を ELECTRON_RUN_AS_NODE=1 で、SSH の接続先ではサーバーの node で）。
// サービスや DI への依存は禁止（配布版では 1 ファイルに束ねられ、dev では out/ の相対 import で動く）。中身は paradisCliCore.ts。

import { homedir } from 'os';
import { paradisRunCli } from './paradisCliCore.js';

paradisRunCli({
	env: process.env,
	cwd: process.cwd(),
	home: homedir(),
	argv: process.argv.slice(2),
	stdout: text => { process.stdout.write(text); },
	stderr: text => { process.stderr.write(text); },
}).then(code => {
	process.exitCode = code;
}, error => {
	process.stderr.write(`para: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
