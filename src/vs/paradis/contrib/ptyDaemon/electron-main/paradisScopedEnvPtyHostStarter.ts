/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// pty ホストを起こす瞬間だけ、環境変数を足しておく。
//
// 常駐の置き場所（`PARADIS_PTY_HOST_STATE_DIR`）は pty ホストへ環境変数で渡す。以前は main
// プロセスの `process.env` へ入れっぱなしにしていたため、main が後から起こすもの（拡張ホスト・
// shared process・それらが起こす子）すべてが同じ値を継いでいた。そこから起動した別の
// Para Code（開発版など）が製品版の常駐へ繋ぎに行く原因になる（`paradisPtyEnvHygiene.ts`）。
//
// `ElectronPtyHostStarter.start()` は `process.env` を**その場で同期的に写して**子の環境を作る
// （`_createPtyHostConfiguration()` → `UtilityProcess.start()`）。だから `start()` の前後だけ
// 足して戻せば、pty ホストにだけ届き、main には残らない。pty ホストが落ちて起こし直すときも
// `start()` を通るので、毎回同じように届く。
//
// `start()` の後は**元の値に戻すのではなく、消した状態に戻す**。起動時に受け継いだ値が
// あっても `paradisCreatePtyHostStarter()` が先に消しているはずで、ここで「元の値」を書き
// 戻すと、消したはずの親の値が main に蘇る。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
import { IPtyHostConnection, IPtyHostStarter } from '../../../../platform/terminal/node/ptyHost.js';

/**
 * `start()` の間だけ `env` に `scopedEnv` を足す {@link IPtyHostStarter}。
 *
 * 包んだ starter はこれが dispose する。
 */
export class ParadisScopedEnvPtyHostStarter extends Disposable implements IPtyHostStarter {

	readonly onRequestConnection?: Event<void>;
	readonly onWillShutdown?: Event<void>;

	constructor(
		private readonly inner: IPtyHostStarter,
		private readonly scopedEnv: { readonly [key: string]: string },
		private readonly env: { [key: string]: string | undefined } = process.env,
	) {
		super();
		this._register(inner);
		this.onRequestConnection = inner.onRequestConnection;
		this.onWillShutdown = inner.onWillShutdown;
	}

	start(): IPtyHostConnection {
		for (const [key, value] of Object.entries(this.scopedEnv)) {
			this.env[key] = value;
		}
		try {
			return this.inner.start();
		} finally {
			for (const key of Object.keys(this.scopedEnv)) {
				delete this.env[key];
			}
		}
	}
}
