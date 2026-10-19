/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 使用量パネルの「メールを番号に」（スクリーンショット用）。メールアドレスを「Claude 1」のような番号に置き換える。
//
// パネルだけでなく、パネルから出す確認ダイアログ・通知、アカウント追加のダイアログ、Codex の切り替えの通知も
// 同じ決まりで名前を出すので、切り替えの状態と番号の元になる一覧をここ1か所に持つ。保存しないので、
// 起動し直すと表示に戻る。

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IParadisLimitsAccount, IParadisLimitsSnapshot, paradisLimitsAccountNumber, ParadisLimitsProvider } from '../common/paradisLimitsMonitor.js';

export const IParadisLimitsEmailMaskService = createDecorator<IParadisLimitsEmailMaskService>('paradisLimitsEmailMaskService');

export interface IParadisLimitsEmailMaskService {
	readonly _serviceBrand: undefined;
	/** 番号に置き換えているかが変わった。 */
	readonly onDidChange: Event<void>;
	readonly masked: boolean;
	toggle(): void;
	/** 番号の元になる一覧（使用量のウィジェットが最新の値を渡す）。 */
	setSnapshot(snapshot: IParadisLimitsSnapshot): void;
	/** 画面に出すアカウントの名前。 */
	displayName(account: IParadisLimitsAccount): string;
	/** 通知などに出すメールの代わりの名前（一覧に無いメールは番号を付けずに伏せる）。 */
	displayNameForEmail(provider: ParadisLimitsProvider, email: string): string;
}

class ParadisLimitsEmailMaskService extends Disposable implements IParadisLimitsEmailMaskService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _masked = false;
	private snapshot: IParadisLimitsSnapshot | undefined;

	get masked(): boolean {
		return this._masked;
	}

	toggle(): void {
		this._masked = !this._masked;
		this._onDidChange.fire();
	}

	setSnapshot(snapshot: IParadisLimitsSnapshot): void {
		this.snapshot = snapshot;
	}

	displayName(account: IParadisLimitsAccount): string {
		if (this._masked && account.email !== undefined) {
			return this.maskedName(account.provider, paradisLimitsAccountNumber(account, this.accounts(account.provider)));
		}
		return account.email ?? account.homeLabel ?? account.id;
	}

	displayNameForEmail(provider: ParadisLimitsProvider, email: string): string {
		if (!this._masked) {
			return email;
		}
		const accounts = this.accounts(provider);
		const account = accounts.find(candidate => candidate.email?.toLowerCase() === email.toLowerCase());
		return this.maskedName(provider, account ? paradisLimitsAccountNumber(account, accounts) : undefined);
	}

	private accounts(provider: ParadisLimitsProvider): readonly IParadisLimitsAccount[] {
		return (provider === 'claude' ? this.snapshot?.claude.accounts : this.snapshot?.codex.accounts) ?? [];
	}

	private maskedName(provider: ParadisLimitsProvider, accountNumber: number | undefined): string {
		if (accountNumber === undefined) {
			return localize('paradis.limitsMonitor.maskedOtherAccount', "（メールアドレスを伏せています）");
		}
		return provider === 'claude'
			? localize('paradis.limitsMonitor.maskedClaudeAccount', "Claude {0}", accountNumber)
			: localize('paradis.limitsMonitor.maskedCodexAccount', "Codex {0}", accountNumber);
	}
}

registerSingleton(IParadisLimitsEmailMaskService, ParadisLimitsEmailMaskService, InstantiationType.Delayed);
