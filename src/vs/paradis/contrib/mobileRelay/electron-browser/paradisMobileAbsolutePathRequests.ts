/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイルの「絶対パスをコピー」の口（fs.absolute-path.v1。Q548）。取り決めは `../common/paradisMobileAbsolutePath.ts`。
//
// - ファイル一覧・ソース管理などの行の長押しのメニューで「絶対パスをコピー」を押したときだけ、アプリが 1 回問い合わせる
//   （state に常に載せると、アプリの端末の控えに PC のパスが残りやすいため）
// - 手元のスペースは `URI.fsPath`（この PC の OS の区切り）。SSH などの接続先のスペースは、接続先の OS で通用するパス
//   （`paradisRemoteAbsolutePath`。Windows の接続先なら `\` 区切り）。接続先の OS を確かめられなければ手元のパスに
//   落とさず `remote` のエラーにする（添付の置き場 `paradisMobileUploadHome.ts` と同じ考え方）
// - スペースの外を指す・シンボリックリンクで外へ出るパスは `resolvePath` が断る（`missing`）

import { Schemas } from '../../../../base/common/network.js';
import { OperatingSystem, isWindows } from '../../../../base/common/platform.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { PARADIS_MOBILE_ABSOLUTE_PATH_KIND, paradisIsMobileAbsolutePathRequestPath, paradisMobileAbsolutePathReply, type ParadisMobileAbsolutePathErrorCode } from '../common/paradisMobileAbsolutePath.js';
import { paradisRemoteAbsolutePath } from '../common/paradisMobileRemotePath.js';
import { paradisRequireMobileWorkspace, registerParadisMobileRequestHandler } from './paradisMobileRequestHandlers.js';

function failure(error: string, code: ParadisMobileAbsolutePathErrorCode): object {
	return { error, code };
}

registerParadisMobileRequestHandler('fs', PARADIS_MOBILE_ABSOLUTE_PATH_KIND, {
	handle(accessor, request, context) {
		// accessor は await の前にだけ使える
		const remoteAgentService = accessor.get(IRemoteAgentService);
		const { path } = request;
		if (!paradisIsMobileAbsolutePathRequestPath(path)) {
			context.reply(failure('invalid absolute path request', 'invalid'));
			return;
		}
		if (paradisRequireMobileWorkspace(request, context) === undefined) {
			return;
		}
		return (async () => {
			const uri = await context.resolvePath(path);
			if (uri === undefined) {
				context.reply(failure('file not found in the space', 'missing'));
				return;
			}
			if (uri.scheme === Schemas.file) {
				context.reply(paradisMobileAbsolutePathReply(uri.fsPath, false, isWindows));
				return;
			}
			if (uri.scheme === Schemas.vscodeRemote) {
				const environment = await remoteAgentService.getEnvironment();
				if (environment === null) {
					context.reply(failure('the remote host is not reachable', 'remote'));
					return;
				}
				context.reply(paradisMobileAbsolutePathReply(paradisRemoteAbsolutePath(uri, environment.os), true, environment.os === OperatingSystem.Windows));
				return;
			}
			context.reply(failure(`unsupported file location: ${uri.scheme}`, 'missing'));
		})();
	},
});
