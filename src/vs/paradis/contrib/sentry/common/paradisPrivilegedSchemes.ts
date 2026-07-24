/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export interface IParadisPrivilegedScheme {
	readonly scheme: string;
}

/**
 * `protocol.registerSchemesAsPrivileged()` の「最後の呼び出しだけが効く」性質を打ち消すための記録役。
 *
 * Electron は登録のたびに Chromium のコマンドラインスイッチ(`--secure-schemes` 等)を
 * その呼び出しのスキーム集合から作り直すため、後から登録した側が先行分を無言で消してしまう。
 * ここに通した登録をすべて覚えておき、毎回「これまでの全部」を渡し直すことで共存させる。
 *
 * 実際に踏んだ事故(paracode-68〜69): `@sentry/electron` が `Sentry.init()` の中で `sentry-ipc`
 * を登録し、それが `src/main.ts` の `vscode-file`/`vscode-webview` 登録より後に走ったため、
 * renderer が `--secure-schemes=sentry-ipc` だけで起動し、workbench が secure context でなくなり
 * `crypto.subtle` が消え、全webviewがマウント不能になった。
 */
export class ParadisPrivilegedSchemeRecorder<T extends IParadisPrivilegedScheme> {

	private readonly schemes: T[] = [];

	constructor(private readonly register: (schemes: T[]) => void) { }

	/** 登録内容を記録し、蓄積済みの全スキームで登録し直す。同名スキームは新しい定義で置き換える。 */
	add(incoming: readonly T[]): void {
		for (const scheme of incoming) {
			// 呼び出し側が後からオブジェクトを書き換えても記録が変わらないよう浅くコピーする。
			const copy = { ...scheme };
			const index = this.schemes.findIndex(candidate => candidate.scheme === scheme.scheme);
			if (index >= 0) {
				this.schemes[index] = copy;
			} else {
				this.schemes.push(copy);
			}
		}
		this.register(this.schemes.slice());
	}

	/** 記録済みスキーム(登録順)。テストと診断用。 */
	get registered(): readonly T[] {
		return this.schemes;
	}
}
