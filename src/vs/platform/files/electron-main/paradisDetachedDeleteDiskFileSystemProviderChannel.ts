/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { UriComponents } from '../../../base/common/uri.js';
import { IURITransformer } from '../../../base/common/uriIpc.js';
import { INativeEnvironmentService } from '../../environment/common/environment.js';
import { ILogService } from '../../log/common/log.js';
import { IFileDeleteOptions } from '../common/files.js';
import { DiskFileSystemProvider } from '../node/diskFileSystemProvider.js';
import { ParadisDetachedDeleteDiskFileSystemProvider } from '../node/paradisDetachedDeleteDiskFileSystemProvider.js';
import { DiskFileSystemProviderChannel } from './diskFileSystemProviderServer.js';

/**
 * 手元の窓から来るファイル操作の main プロセスのチャネル。中身ごとの完全削除（ごみ箱を使わない
 * `recursive`）だけを `ParadisDetachedDeleteDiskFileSystemProvider` で消す。
 *
 * upstream の `Promises.rm(path, RimRafMode.MOVE)` は、一時フォルダへ rename した後の中身を
 * main プロセスの中で消し続ける。その間、main の libuv のスレッドプールが埋まり、窓から来る
 * stat・読み込み（スペースの切り替えなど）が消し終わるまで順番待ちになる（接続先の同じ問題は
 * `remoteFileSystemProviderServer.ts` で直してある）。
 *
 * ほかの操作と、ごみ箱への移動・中身ごとでない削除は、main の `fileService` と共有する upstream の
 * provider のまま。main の中で行う削除（保存・バックアップ・設定など）は、このチャネルを通らないので
 * 変わらない。
 */
export class ParadisDetachedDeleteDiskFileSystemProviderChannel extends DiskFileSystemProviderChannel {

	private readonly detachedDeleteProvider: ParadisDetachedDeleteDiskFileSystemProvider;

	constructor(
		provider: DiskFileSystemProvider,
		logService: ILogService,
		environmentService: INativeEnvironmentService,
	) {
		super(provider, logService, environmentService);
		this.detachedDeleteProvider = this._register(new ParadisDetachedDeleteDiskFileSystemProvider(logService, environmentService.userDataPath));
	}

	protected override delete(uriTransformer: IURITransformer, _resource: UriComponents, opts: IFileDeleteOptions): Promise<void> {
		if (opts.useTrash || !opts.recursive) {
			return super.delete(uriTransformer, _resource, opts);
		}
		return this.detachedDeleteProvider.delete(this.transformIncoming(uriTransformer, _resource), opts);
	}
}
