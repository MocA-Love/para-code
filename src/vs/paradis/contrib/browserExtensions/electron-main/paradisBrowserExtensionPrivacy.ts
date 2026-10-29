/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// chrome.privacy.network.webRTCIPHandlingPolicy（P8）の main 側。VPN やプライバシーの拡張機能が WebRTC で IP を漏らさないために使う
// 設定なので、覚えるだけにせず、その場所（プロファイル）の利用者のタブへ webContents.setWebRTCIPHandlingPolicy で本当に効かせる。
//  - 対象はその場所の利用者のタブだけ。エージェントのタブには効かせない（既定の 'default' のまま）
//  - 拡張機能が set した値は場所ごとに保存し、起動の後に開いたタブにも効かせる。最後に set した、その場所で有効な拡張機能の値を使う
//    （Chrome も、後から入れた拡張機能が優先する）。拡張機能を無効にする・外すと、その値は使わない
//  - Chrome の「シークレット」の scope は無いので断る
// ほかの chrome.privacy の設定は Para Code に同じものが無く、詰め物が not_controllable と答えて set を断る（paradisInstallPrivacy）。

import { promises as fs } from 'fs';
import { dirname } from '../../../../base/common/path.js';
import { PARADIS_SHIM_PRIVACY_NAMESPACE } from '../common/paradisBrowserExtensionShim.js';
import { IParadisExtensionApiCaller, ParadisExtensionApiError, ParadisExtensionApiHost, paradisDefineExtensionMethod } from './paradisBrowserExtensionApiHost.js';

/** Chrome の値（Electron の setWebRTCIPHandlingPolicy と同じ）。 */
export const PARADIS_WEBRTC_IP_HANDLING_POLICIES = ['default', 'default_public_and_private_interfaces', 'default_public_interface_only', 'disable_non_proxied_udp'] as const;
export type ParadisWebRtcIpHandlingPolicy = typeof PARADIS_WEBRTC_IP_HANDLING_POLICIES[number];

/** 効かせる先のタブ（テストでは偽物）。 */
export interface IParadisPrivacyTab {
	setWebRTCIPHandlingPolicy(policy: ParadisWebRtcIpHandlingPolicy): void;
}

/** その場所のタブと、拡張機能が有効かを引くもの（拡張機能の管理から渡す）。 */
export interface IParadisPrivacyEnvironment {
	/** その場所の利用者のタブ（エージェントのタブは含めない）。 */
	userTabsIn(place: string): readonly IParadisPrivacyTab[];
	isEnabledIn(place: string, extensionId: string): boolean;
}

/**
 * その場所の利用者のタブ（エージェントのタブと、場所の分からない・SSH 先のトンネルを通しているセッションのタブは含めない）。
 */
export function paradisPrivacyUserTabs<T extends { readonly webContents: { readonly session: unknown }; isAgentTab(): boolean }>(views: readonly T[], placeOfSession: (session: unknown) => string | undefined, place: string): T['webContents'][] {
	return views.filter(view => !view.isAgentTab() && placeOfSession(view.webContents.session) === place).map(view => view.webContents);
}

interface ISetting {
	readonly extensionId: string;
	readonly value: ParadisWebRtcIpHandlingPolicy;
	readonly at: number;
}

type State = Record<string, ISetting[]>;

function isPolicy(value: unknown): value is ParadisWebRtcIpHandlingPolicy {
	return typeof value === 'string' && (PARADIS_WEBRTC_IP_HANDLING_POLICIES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class ParadisBrowserExtensionPrivacy {

	private _state: State = {};
	private _saving: Promise<void> = Promise.resolve();
	private _now = 0;

	constructor(
		private readonly _host: ParadisExtensionApiHost,
		private readonly _path: string,
		private readonly _logService: { warn(message: string, ...args: unknown[]): void },
		private readonly _environment: IParadisPrivacyEnvironment,
	) {
		this._register();
	}

	async load(): Promise<void> {
		try {
			const raw: unknown = JSON.parse(await fs.readFile(this._path, 'utf8'));
			const state: State = {};
			if (isRecord(raw)) {
				for (const [place, list] of Object.entries(raw)) {
					if (Array.isArray(list)) {
						state[place] = list.filter((entry): entry is ISetting => isRecord(entry) && typeof entry.extensionId === 'string' && isPolicy(entry.value) && typeof entry.at === 'number');
					}
				}
			}
			this._state = state;
			this._now = Math.max(0, ...Object.values(state).flat().map(entry => entry.at));
		} catch {
			this._state = {};
		}
	}

	/** その場所で効いている値（その場所で有効な拡張機能が最後に set したもの。無ければ 'default'）と、それを決めた拡張機能。 */
	effective(place: string): { readonly value: ParadisWebRtcIpHandlingPolicy; readonly extensionId?: string } {
		const winner = (this._state[place] ?? []).filter(entry => this._environment.isEnabledIn(place, entry.extensionId)).sort((a, b) => b.at - a.at)[0];
		return winner ? { value: winner.value, extensionId: winner.extensionId } : { value: 'default' };
	}

	/** その場所の利用者のタブへ効かせる（設定が変わった・拡張機能を有効にした・無効にした・外したとき）。 */
	apply(place: string): void {
		const { value } = this.effective(place);
		for (const tab of this._environment.userTabsIn(place)) {
			this.applyTo(tab, place, value);
		}
	}

	/** 1 つのタブへ効かせる（タブを開いたとき）。 */
	applyTo(tab: IParadisPrivacyTab, place: string, value: ParadisWebRtcIpHandlingPolicy = this.effective(place).value): void {
		try {
			tab.setWebRTCIPHandlingPolicy(value);
		} catch (error) {
			this._logService.warn('[paradis] could not apply the WebRTC IP handling policy to a tab', error);
		}
	}

	/** 拡張機能を外した: その値を忘れ、効かせ直す。 */
	async forgetExtension(extensionId: string): Promise<void> {
		let changed = false;
		for (const [place, list] of Object.entries(this._state)) {
			const next = list.filter(entry => entry.extensionId !== extensionId);
			if (next.length !== list.length) {
				this._state[place] = next;
				changed = true;
				this.apply(place);
			}
		}
		if (changed) {
			await this._save();
		}
	}

	private _levelOfControl(caller: IParadisExtensionApiCaller): string {
		const { extensionId } = this.effective(caller.place);
		return extensionId === caller.extension.id ? 'controlled_by_this_extension' : extensionId !== undefined ? 'controlled_by_other_extensions' : 'controllable_by_this_extension';
	}

	private _changed(caller: IParadisExtensionApiCaller, before: ParadisWebRtcIpHandlingPolicy): void {
		const after = this.effective(caller.place).value;
		this.apply(caller.place);
		if (after !== before) {
			this._host.emit({ session: caller.session, extensionId: caller.extension.id }, PARADIS_SHIM_PRIVACY_NAMESPACE, 'onChange', [{ value: after, levelOfControl: this._levelOfControl(caller) }]);
		}
	}

	private _register(): void {
		const scopeOf = (details: unknown): unknown => isRecord(details) ? details.scope : undefined;
		const refuseScope = (details: unknown) => {
			const scope = scopeOf(details);
			if (scope !== undefined && scope !== 'regular') {
				throw new ParadisExtensionApiError('Para Code has no incognito windows, so only the regular scope can be set');
			}
		};
		this._host.registerNamespace(PARADIS_SHIM_PRIVACY_NAMESPACE, {
			permission: 'privacy',
			methods: {
				get: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, caller => ({ value: this.effective(caller.place).value, levelOfControl: this._levelOfControl(caller) })),
				set: paradisDefineExtensionMethod(args => args.length === 1 && isRecord(args[0]) ? [args[0]] as [Record<string, unknown>] : undefined, async (caller, details) => {
					refuseScope(details);
					if (!isPolicy(details.value)) {
						throw new ParadisExtensionApiError(`Invalid value for webRTCIPHandlingPolicy: ${String(details.value)}`);
					}
					const before = this.effective(caller.place).value;
					const list = (this._state[caller.place] ?? []).filter(entry => entry.extensionId !== caller.extension.id);
					list.push({ extensionId: caller.extension.id, value: details.value, at: ++this._now });
					this._state[caller.place] = list;
					await this._save();
					this._changed(caller, before);
				}),
				clear: paradisDefineExtensionMethod(args => args.length === 1 && isRecord(args[0]) ? [args[0]] as [Record<string, unknown>] : undefined, async (caller, details) => {
					refuseScope(details);
					const before = this.effective(caller.place).value;
					this._state[caller.place] = (this._state[caller.place] ?? []).filter(entry => entry.extensionId !== caller.extension.id);
					await this._save();
					this._changed(caller, before);
				}),
			},
			events: ['onChange'],
		});
	}

	private _save(): Promise<void> {
		const state = JSON.stringify(this._state);
		this._saving = this._saving.then(async () => {
			await fs.mkdir(dirname(this._path), { recursive: true });
			await fs.writeFile(`${this._path}.tmp`, state);
			await fs.rename(`${this._path}.tmp`, this._path);
		}).catch(error => this._logService.warn('[paradis] could not save the browser extension privacy settings', error));
		return this._saving;
	}
}
