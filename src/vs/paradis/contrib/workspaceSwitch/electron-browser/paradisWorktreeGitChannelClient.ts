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
 * 「接続しているかどうか」ではなく「そのリポジトリがどこにあるか」で決める。
 * `ParadisWorkspaceSwitchService` は永続化時に `belongsToThisHost` で単一ホスト（今の接続先、
 * または file）に絞るため、リロード後のリポジトリ一覧は基本的に単一ホストに揃う。ただし
 * それは**保存された状態**の話で、実行時の一覧（`repositories` ゲッター）には、統合フローで
 * 「このPCを選んだ場合」や「手元のフォルダを追加した直後」など、次の保存までの短い間だけ
 * 手元のリポジトリが混ざりうる。この関数はその短命な混在を含め、常に URI 自体から判断する
 * （ウィンドウ単位で振り分けると、今度はその短命な混在ケースで手元のリポジトリが壊れる）。
 *
 * 戻り値の関数は ServicesAccessor を掴まないので、await をまたいでも使える。掴んだ接続は
 * ウィンドウの生存期間中ずっと有効（接続先はウィンドウごとに固定され、再接続は接続オブジェクトの
 * 内側で吸収される）。
 */
export function paradisWorktreeGitHostResolver(accessor: ServicesAccessor): (resource: URI) => IParadisWorktreeGitHost {
	const resolve = paradisChannelHostResolver(accessor, PARADIS_WORKTREE_GIT_CHANNEL, 'local');
	// unresolved: 'local' を指定しているので、この resolve は常に値を返す（undefined にならない）。
	return resource => resolve(resource)!;
}

/**
 * `paradisWorktreeGitHostResolver` の書き込み版。別ホストの古い登録・未接続中の vscode-remote・
 * file/vscode-remote 以外のスキームでは `undefined` を返し、呼び出し元に「このウィンドウからは
 * 実行できない」を強制する。`addWorktree`・`removeWorktree`・`runLifecycleScript`・`runGit` など、
 * 書き込みやスクリプト実行を伴う worktree git チャネル呼び出しは必ずこちらを使うこと
 * （`paradisWorktreeGitHostResolver` のまま使うと、絶対パスが一致する構成で無関係な手元の
 * リポジトリに書き込んでしまう事故が起きる）。
 */
export function paradisWorktreeGitWriteHostResolver(accessor: ServicesAccessor): (resource: URI) => IParadisWorktreeGitHost | undefined {
	return paradisChannelHostResolver(accessor, PARADIS_WORKTREE_GIT_CHANNEL, 'reject');
}

/**
 * `paradisWorktreeGitHostResolver` と同じ振り分けを、worktree git 以外のチャネルにも使えるよう
 * チャネル名を引数化した版。「そのリソースがあるマシンへ繋ぎ分ける」という判断はチャネルに
 * よらず共通なので、新しいチャネルを足すたびにこの振り分けロジックを複製しないこと。
 *
 * `unresolved` は、別ホストの古い登録・未接続中の vscode-remote・file/vscode-remote 以外の
 * スキーム（`vscode-vfs:`・`untitled:` 等）をどう扱うかの指定:
 * - `'local'`（既定）: 手元へ流す。読み取り専用の呼び出し向け。手元に同じ絶対パスが存在しない
 *   限り「そんなパスは無い」で自然に失敗するが、file スキーム同士で絶対パスが一致する構成
 *   （mac→mac の SSH、同名ユーザーの Linux→Linux 等）では**無関係な手元のリソースを読んでしまう**。
 * - `'reject'`: 解決できないリソースには `undefined` を返す。書き込みを伴う呼び出し
 *   （`git commit`・`git add`・`worktree add/remove`・任意スクリプト実行等）は必ずこちらを使うこと。
 *   `'local'` のまま書き込み系に使うと、絶対パスが一致する構成で**無関係な手元のリポジトリに
 *   書き込んでしまう**（実際に踏んだ事故）。
 */
export function paradisChannelHostResolver(accessor: ServicesAccessor, channelName: string, unresolved: 'local' | 'reject' = 'local'): (resource: URI) => IParadisWorktreeGitHost | undefined {
	const connection = accessor.get(IRemoteAgentService).getConnection();
	const local: IParadisWorktreeGitHost = {
		channel: accessor.get(ISharedProcessService).getChannel(channelName),
		path: resource => resource.fsPath
	};
	const fallback = unresolved === 'local' ? local : undefined;
	if (!connection) {
		// file 以外（vscode-remote はもちろん、vscode-vfs・untitled 等の非ファイルスキームも
		// 含む）はどのマシンのものか確証が持てないため、'reject' では素通しで local にしない。
		return resource => resource.scheme === Schemas.file ? local : fallback;
	}
	const remote: IParadisWorktreeGitHost = {
		channel: connection.getChannel(channelName),
		path: resource => resource.path
	};
	// authority まで見るのは、別のホストで作った古い登録が残っていたときに、今つないでいる
	// 接続先を相手だと思って動かさないため（手元へ流せば「そんなパスは無い」で止まる —
	// ただし読み取り専用に限る。書き込み系は unresolved: 'reject' で必ず弾くこと）
	const authority = connection.remoteAuthority.toLowerCase();
	return resource => {
		if (resource.scheme === Schemas.file) {
			return local;
		}
		if (resource.scheme !== Schemas.vscodeRemote) {
			return fallback;
		}
		return resource.authority.toLowerCase() === authority ? remote : fallback;
	};
}
