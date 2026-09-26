/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process と REH サーバーへ fork のチャネルを足すための登録口。
//
// 今までは新しいチャネルを1つ足すたびに `sharedProcessMain.ts` と `serverServices.ts`（どちらも
// upstream のファイル）へ import と登録の PARA-PATCH を1組ずつ足していた。upstream を取り込む
// たびにそこがコンフリクト面になる。
//
// ここに登録口を1つ置き、upstream のファイルからは集約ファイル
// （`paradis.sharedProcess.contribution.ts` / `paradis.server.contribution.ts`）を1回呼ぶだけにする。
// 新しいチャネルは `contrib/<feature>/node/` 側で下のレジストリへ `register` し、その集約ファイルへ
// 副作用 import を1行足せば登録される。

import { DisposableStore, IDisposable, isDisposable } from '../../base/common/lifecycle.js';
import { IPCServer } from '../../base/parts/ipc/common/ipc.js';
import { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../platform/log/common/log.js';
import { RemoteAgentConnectionContext } from '../../platform/remote/common/remoteAgentEnvironment.js';

/**
 * 登録された関数へ渡すもの。
 *
 * `accessor` は**関数が同期的に返るまでの間だけ**有効（`invokeFunction` の中から呼ぶため）。
 * `await` の後で `accessor.get` しないこと。必要なサービスは先に取り出しておく。
 */
export interface IParadisProcessContributionContext<TContext> {
	readonly server: IPCServer<TContext>;
	readonly accessor: ServicesAccessor;
}

/**
 * チャネルなどを登録する関数。後片付けが要るものは `IDisposable` を返す。
 */
export type ParadisProcessContribution<TContext> = (context: IParadisProcessContributionContext<TContext>) => IDisposable | void;

interface IParadisRegisteredProcessContribution<TContext> {
	readonly id: string;
	readonly contribution: ParadisProcessContribution<TContext>;
}

/**
 * 1つのプロセス種別（shared process / REH サーバー）ぶんの登録口。
 */
export class ParadisProcessContributionRegistry<TContext> {

	private readonly contributions: IParadisRegisteredProcessContribution<TContext>[] = [];

	constructor(private readonly processName: string) { }

	/**
	 * 登録する。モジュールの最上位で1回呼ぶ想定。
	 *
	 * 同じ id を2回登録すると例外にする。同じチャネル名を2回 `registerChannel` すると後勝ちで
	 * 黙って上書きされ、どちらが動いているのか分からなくなるため。
	 */
	register(id: string, contribution: ParadisProcessContribution<TContext>): void {
		if (this.contributions.some(entry => entry.id === id)) {
			throw new Error(`[Paradis] ${this.processName} contribution '${id}' is already registered`);
		}
		this.contributions.push({ id, contribution });
	}

	/** 登録済みの id を登録順に返す（テスト・診断用）。 */
	getIds(): readonly string[] {
		return this.contributions.map(entry => entry.id);
	}

	/**
	 * 登録済みの関数を登録順にすべて呼ぶ。
	 *
	 * 1つが例外を投げても残りは続ける。fork の1機能が壊れたせいで、その後ろに並んだ別機能の
	 * チャネルまで登録されず、プロセス全体の機能が静かに欠けるのを避けるため。
	 */
	instantiate(server: IPCServer<TContext>, accessor: ServicesAccessor, logService: ILogService): IDisposable {
		const store = new DisposableStore();
		for (const { id, contribution } of this.contributions) {
			try {
				const result = contribution({ server, accessor });
				if (isDisposable(result)) {
					store.add(result);
				}
			} catch (error) {
				logService.error(`[Paradis] failed to register ${this.processName} contribution '${id}'`, error);
			}
		}
		return store;
	}
}

/** shared process（Electron utility process）へ fork のチャネルを足す登録口。 */
export const ParadisSharedProcessContributions = new ParadisProcessContributionRegistry<string>('shared process');

/** REH サーバー（SSH 等の接続先）へ fork のチャネルを足す登録口。 */
export const ParadisServerContributions = new ParadisProcessContributionRegistry<RemoteAgentConnectionContext>('server');
