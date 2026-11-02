/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * IPC の口（`IServerChannel.call`）が受けた引数を、位置で読んで形を確かめる。`call` の `arg` は呼ぶ側が
 * 配列で渡す約束だが、別の層から届くので型を信用しない。配列でなければ何も無いものとして読む。
 * 引数の並びは呼ぶ側と口の側で合わせる（並びを変えると、ここでは気付けない）。
 */
export class ParadisChannelArgs {

	private constructor(private readonly args: readonly unknown[]) { }

	static from(arg: unknown): ParadisChannelArgs {
		return new ParadisChannelArgs(Array.isArray(arg) ? arg : []);
	}

	/** その位置の値（形は確かめない）。 */
	at(index: number): unknown {
		return this.args[index];
	}

	/** その位置が文字列ならその値、違えば `undefined`。 */
	string(index: number): string | undefined {
		const value = this.args[index];
		return typeof value === 'string' ? value : undefined;
	}

	/** その位置が配列なら文字列だけを残したもの、配列でなければ空。 */
	strings(index: number): string[] {
		const value = this.args[index];
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
	}
}
