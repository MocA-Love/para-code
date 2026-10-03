/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Schemas } from '../../../../base/common/network.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import { dirname as uriDirname } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';

/** 添付の置き場の親（userData）と、そこへ置いたファイルを接続先の OS の綴りで書くための OS。 */
export interface IParadisMobileUploadHome {
	readonly userData: URI;
	/** 接続先に置くときだけ。手元なら undefined（`URI.fsPath` で足りる）。 */
	readonly remoteOs?: OperatingSystem;
}

/**
 * モバイルからの添付の置き場の親（userData）を決める。アップロード（provider の `upload`）と読み取り
 * （`fs.attachment.v1`）が同じ場所を指すよう、判断はここに一本化する。
 *
 * 添付を読むのはこのウィンドウのペインで動くエージェントなので、SSH 接続中は接続先へ置く。
 * 接続先の userData は環境が持つ globalStorageHome の親。
 *
 * 接続中なのに置き場が接続先を指していないときは、手元へ落とさず例外にする。
 * `getEnvironment()` は失敗を握り潰して null を返すので、そこで手元へ落とすと
 * 「接続先のつもりで手元に書き、しかも成功として返す」ことになる（同種の事故は
 * `agentBrowser/common/paradisRemoteUserHome.ts` に記録がある）。判断は「接続中かどうか」ではなく
 * 「今この置き場が接続先を指しているか」で行う。
 */
export async function paradisResolveMobileUploadHome(environmentService: Pick<IEnvironmentService, 'userRoamingDataHome'>, remoteAgentService: Pick<IRemoteAgentService, 'getConnection' | 'getEnvironment'> | undefined): Promise<IParadisMobileUploadHome> {
	const connection = remoteAgentService?.getConnection();
	if (connection) {
		const environment = await remoteAgentService?.getEnvironment();
		// 接続先の環境は、こちらが送った authority を焼き込んだ URI で返ってくる。別物なら接続先ではない
		const userData = environment ? uriDirname(environment.globalStorageHome) : undefined;
		if (!environment || userData === undefined
			|| userData.scheme !== Schemas.vscodeRemote
			|| userData.authority.toLowerCase() !== connection.remoteAuthority.toLowerCase()
		) {
			// allow-any-unicode-next-line
			throw new Error(localize('paradis.mobile.uploadRemoteUnavailable', "接続先（{0}）の保存先が確認できないため、添付を送れませんでした。接続が復帰してからやり直してください。", connection.remoteAuthority));
		}
		return { userData, remoteOs: environment.os };
	}
	return { userData: environmentService.userRoamingDataHome };
}
