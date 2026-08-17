/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// worktree git チャネル (paradisWorktreeGitChannel) を「そのリポジトリがあるマシン」へ繋ぎ分ける。
//
// git を動かす先を間違えると、存在しないパスへ cd しようとして
// `cannot change to '<相手側のパス>': No such file or directory` で必ず失敗する。振り分けを
// ここ1箇所に集めてあるので、新しい呼び出しもこのファイル経由にすること。

import { Schemas } from '../../../../base/common/network.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { URI } from '../../../../base/common/uri.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { PARADIS_WORKTREE_GIT_CHANNEL } from '../common/paradisWorktreeCreate.js';

/** git を動かすマシンと、そのマシンへ渡すパスの書き方。 */
export interface IParadisWorktreeGitHost {
	readonly channel: IChannel;
	/**
	 * チャネルの向こう側へ渡すパス文字列。
	 *
	 * 接続先へ `fsPath` を渡してはいけない。`fsPath` は**このウィンドウが動いている OS** を見て
	 * 区切りを付け替えるため、Windows から Linux の接続先へ繋いでいると
	 * `/home/u/repo` が `\home\u\repo` に化けて、接続先の git が受け取れなくなる。
	 */
	path(resource: URI): string;
}

/**
 * リポジトリ（や作業ツリー）の URI から、git を動かすマシンを決める関数を作る。
 *
 * 「接続しているかどうか」ではなく「そのリポジトリがどこにあるか」で決める。接続中のウィンドウでも
 * リポジトリ一覧には手元のものが混ざりうるため（統合フローの「どこにクローンしますか」で
 * このPCを選んだ場合や、手元のフォルダを追加した場合）、ウィンドウ単位で振り分けると
 * 今度は手元のリポジトリが同じ理由で壊れる。
 *
 * 戻り値の関数は ServicesAccessor を掴まないので、await をまたいでも使える。掴んだ接続は
 * ウィンドウの生存期間中ずっと有効（接続先はウィンドウごとに固定され、再接続は接続オブジェクトの
 * 内側で吸収される）。
 */
export function paradisWorktreeGitHostResolver(accessor: ServicesAccessor): (resource: URI) => IParadisWorktreeGitHost {
	const connection = accessor.get(IRemoteAgentService).getConnection();
	const local: IParadisWorktreeGitHost = {
		channel: accessor.get(ISharedProcessService).getChannel(PARADIS_WORKTREE_GIT_CHANNEL),
		path: resource => resource.fsPath
	};
	if (!connection) {
		return () => local;
	}
	const remote: IParadisWorktreeGitHost = {
		channel: connection.getChannel(PARADIS_WORKTREE_GIT_CHANNEL),
		path: resource => resource.path
	};
	// authority まで見るのは、別のホストで作った古い登録が残っていたときに、今つないでいる
	// 接続先を相手だと思って git を動かさないため（手元へ流せば「そんなパスは無い」で止まる）
	const authority = connection.remoteAuthority.toLowerCase();
	return resource => resource.scheme === Schemas.vscodeRemote && resource.authority.toLowerCase() === authority
		? remote
		: local;
}
