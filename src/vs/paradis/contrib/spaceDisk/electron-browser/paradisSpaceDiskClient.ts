/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スペース(リポジトリ/worktree)の容量を shared process へ問い合わせる renderer 側の窓口。
// 「どのスペースがあるか」を知っているのは renderer だけなので、パスの解決はここで行う。

import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Schemas } from '../../../../base/common/network.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisWorktreeStateKey } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import {
	IParadisSpaceDiskResult,
	IParadisSpaceDiskService,
	IParadisSpaceDiskTarget,
	IParadisSpaceDiskWorktree,
	PARADIS_SPACE_DISK_CHANNEL,
} from '../common/paradisSpaceDisk.js';

export class ParadisSpaceDiskClient {

	private readonly service: IParadisSpaceDiskService;

	constructor(
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@ISharedProcessService sharedProcessService: ISharedProcessService,
	) {
		this.service = ProxyChannel.toService<IParadisSpaceDiskService>(sharedProcessService.getChannel(PARADIS_SPACE_DISK_CHANNEL));
	}

	/**
	 * 登録済みスペースの容量を返す。
	 * 既定ではキャッシュ済みの値が即座に返り、`bypassCache` のときだけ測り直す。
	 */
	async measure(bypassCache = false): Promise<IParadisSpaceDiskResult> {
		// worktree の一覧は起動直後まだ空。待たずに測ると worktree を親から除外できず、
		// 二重計上した過大な値になる上に18倍遅くなり、その誤った結果がTTLぶん居座る。
		await this.worktreeService.initializationBarrier.catch(() => { /* 一覧が取れなくても本体は測る */ });
		return this.service.measure(this.collectTargets(), bypassCache);
	}

	/**
	 * 計測対象。リポジトリと、それぞれが持つ worktree のパスを集める。
	 *
	 * **worktree の場所は決め打ちしない**。`IParadisWorktreeService` が返す実際の URI を
	 * そのまま渡し、親の中にあるかどうかの判定は計測側に任せる。親の中に置く人・外に置く人・
	 * WSL の UNC パスの人がいて、どれも同じ経路で扱える必要があるため。
	 *
	 * リモート(SSH/WSLのremote拡張経由)のスペースは、この shared process からは
	 * ファイルとして見えないので対象から外す。見えないものを測ろうとして毎回失敗するより、
	 * 一覧に出さないほうが正直になる。
	 */
	private collectTargets(): IParadisSpaceDiskTarget[] {
		const targets: IParadisSpaceDiskTarget[] = [];
		for (const repository of this.workspaceSwitchService.repositories) {
			if (repository.uri.scheme !== Schemas.file) {
				continue;
			}
			const worktrees: IParadisSpaceDiskWorktree[] = [];
			for (const worktree of this.worktreeService.getWorktrees(repository.id)) {
				// `isMainCheckout` はリポジトリ本体を一覧の1行として見せるための合成エントリで、
				// 実体は repository と同じフォルダ。worktree として数えると本体を二重に数える。
				if (worktree.isMainCheckout || worktree.missing || worktree.uri.scheme !== Schemas.file) {
					continue;
				}
				worktrees.push({
					stateKey: paradisWorktreeStateKey(worktree.uri),
					name: worktree.name,
					path: worktree.uri.fsPath,
				});
			}
			targets.push({
				stateKey: repository.id,
				name: repository.name,
				path: repository.uri.fsPath,
				worktrees,
			});
		}
		return targets;
	}
}
