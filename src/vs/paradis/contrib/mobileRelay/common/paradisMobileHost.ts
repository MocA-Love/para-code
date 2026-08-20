/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * モバイルの「接続先セグメント」機能が使う、1ウィンドウぶんの接続先識別子。
 *
 * 1台のPCで複数のウィンドウ（ローカルのworkspaceを開いたものとSSHリモート先を開いたもの等）を
 * 同時に起動している場合、rtk/ccusage/rate limit の各値は「そのウィンドウが繋がっている先の
 * ホスト」でCLIを実行して取得するため、ウィンドウごとに値が異なりうる。モバイル側がどのホストの
 * 値を見ているかを表示・選択できるように、このホスト識別子を desktop state に載せて配信する。
 */
export interface IParadisMobileWindowHost {
	/** ローカル（このPC自身）か、SSHリモート等の接続先か。 */
	readonly kind: 'local' | 'remote';
	/** 同一ホストを束ねるための安定キー。local は常に 'local'、remote は authority を小文字化したもの。 */
	readonly id: string;
	/** remote のときだけ付与する表示名（ローカルはモバイル側で「ローカル」とローカライズする）。 */
	readonly label?: string;
}

/**
 * ウィンドウの remoteAuthority から接続先ホストを決める。
 *
 * `remoteAuthority` は `ssh-remote+myserver` のような形式で、対応する拡張機能（open-remote-ssh 等）が
 * 起動後にラベルフォーマッタを登録するまでは `hostLabel` が渡らない。フォーマッタ未到着の間は
 * authority をそのまま `label` に使う（先頭の `xxx-remote+` を落として読みやすくする）。
 */
export function paradisResolveMobileWindowHost(remoteAuthority: string | undefined, hostLabel: string | undefined): IParadisMobileWindowHost {
	if (remoteAuthority === undefined) {
		return { kind: 'local', id: 'local' };
	}
	const id = remoteAuthority.toLowerCase();
	const label = hostLabel ?? remoteAuthority.replace(/^[a-z0-9-]+\+/i, '');
	return { kind: 'remote', id, label };
}
