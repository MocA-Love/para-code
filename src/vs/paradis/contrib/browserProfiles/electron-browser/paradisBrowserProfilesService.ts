/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 名前付きブラウザプロファイルの renderer 側。台帳の権威であり、UI（ピル・ドロップダウン・
// モーダル）とMCPの受け口はすべてこのサービス越しに動く。
//
// 台帳が2つあるのは、寿命が違うため:
//  - プロファイル台帳（表示名・色・時刻）は APPLICATION + MACHINE。ログイン状態はマシン固有
//    なので、設定同期に載せない（別マシンに名前だけ現れてログインが無い、を作らない）。
//  - viewId → profileId の対応は WORKSPACE + MACHINE。ビューはワークスペースの working set と
//    一緒に復元されるので、寿命を揃える。
//
// なぜ viewId の台帳が要るのか（重要）:
// 「今どのプロファイルか」の権威は main 側（実際に紐付いた Electron セッション）にある。
// ただしアプリ再起動後の復元経路（browserEditorInput.ts の deserialize → getOrCreateLazy）は
// viewId と URL しか持たず、そこから main のセッションを決めるのはこちら側。よって
// 「次にこの viewId のビューを作るときはこのプロファイルで」を renderer 側で覚えておく必要が
// ある。復元後の表示は main の答えで上書きされるので、ずれても main が正になる。

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { BrowserViewStorageScope, IBrowserSessionOptions } from '../../../../platform/browserView/common/browserView.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import {
	IParadisBrowserProfilesMainService,
	IParadisBrowserProfileStats,
	IParadisViewSessionInfo,
	PARADIS_BROWSER_PROFILE_CHANNEL,
} from '../common/paradisBrowserProfileChannel.js';
import { paradisIsValidProfileId, paradisProfileIdFromUuid } from '../common/paradisBrowserProfileId.js';
import {
	IParadisBrowserProfile,
	PARADIS_BROWSER_PROFILE_COLORS,
	paradisDeserializeProfiles,
	paradisFindProfileByName,
	paradisIsDuplicateProfileName,
	paradisNormalizeProfileName,
	paradisSerializeProfiles,
} from '../common/paradisBrowserProfileModel.js';
import { paradisRegisterBrowserProfileRouter } from '../common/paradisBrowserProfileRouting.js';

/** プロファイル台帳（表示名・色・時刻）。マシン固有なので同期しない。 */
const PROFILES_STORAGE_KEY = 'paradis.browser.profiles';
/** viewId → profileId の対応。ワークスペースの working set と寿命を揃える。 */
const PROFILE_VIEWS_STORAGE_KEY = 'paradis.browser.profileViews';
/** 対応表に残す上限。閉じたビューをシャットダウン中に消さない設計なので、際限なく増やさない。 */
const MAX_VIEW_OVERRIDES = 200;

/** 名前の検証に失敗した理由（UI がそのまま出せる日本語）。 */
export type ParadisProfileNameError = string;

export const IParadisBrowserProfilesService = createDecorator<IParadisBrowserProfilesService>('paradisBrowserProfilesService');

export interface IParadisBrowserProfilesService {
	readonly _serviceBrand: undefined;

	/** 台帳・viewId 対応・解決済みキャッシュのいずれかが変わったときに発火する（UI 再描画用）。 */
	readonly onDidChangeProfiles: Event<void>;

	/** 台帳の全プロファイル（最終利用が新しい順）。 */
	list(): readonly IParadisBrowserProfile[];

	/** 表示名で引く（MCP の `open_browser_profile` 用。NFKC + caseless 一致）。 */
	findByName(name: string): IParadisBrowserProfile | undefined;

	/** 新規作成。名前が空/重複なら失敗理由を返す。 */
	create(name: string, color: string): { readonly ok: true; readonly profile: IParadisBrowserProfile } | { readonly ok: false; readonly error: ParadisProfileNameError };

	/** リネーム。パーティションには一切触れないのでログイン状態は残る。 */
	rename(profileId: string, name: string): { readonly ok: true } | { readonly ok: false; readonly error: ParadisProfileNameError };

	/** 識別カラーの変更。 */
	setColor(profileId: string, color: string): void;

	/**
	 * 台帳から削除し、保存されている Cookie / ストレージも main 側で消す。
	 * そのプロファイルで開いているタブは先に閉じる（開いたままだと消した直後に書き戻される）。
	 */
	remove(profileId: string): Promise<void>;

	/** 台帳には残したまま、保存されている Cookie / ストレージだけを消す（＝ログアウト）。 */
	clearProfileData(profileId: string): Promise<void>;


	/** 最終利用時刻を今にする。 */
	touch(profileId: string): void;

	/** そのビューのプロファイル（同期に分かる範囲。未解決なら undefined）。 */
	getProfileForView(viewId: string): string | undefined;

	/** そのビューのセッションの素性（同期に分かる範囲）。ピルの表示に使う。 */
	getViewSession(viewId: string): IParadisViewSessionInfo | undefined;

	/** そのビューのセッションを main へ問い合わせて確定する（結果はキャッシュされる）。 */
	resolveViewSession(viewId: string): Promise<IParadisViewSessionInfo | undefined>;

	/** 管理モーダル用の統計（Cookie 件数）。 */
	getProfileStats(profileId: string): Promise<IParadisBrowserProfileStats>;

	/**
	 * 名前付きプロファイルを使えるか。信頼していないワークスペースでは upstream が
	 * 常にエフェメラルへ倒すため（＝Cookie を保存しない）、こちらもそれを尊重して使えなくする。
	 */
	canUseProfiles(): boolean;

	/** 指定プロファイルで新しいブラウザタブを開く。 */
	openInProfile(profileId: string, url?: string, group?: IEditorGroup): Promise<BrowserEditorInput | undefined>;

	/**
	 * 開いているビューを別のプロファイル／組み込みスコープへ「切り替える」。
	 * 実体は同じ位置への差し替え（Electron セッションは差し替えられないため）。
	 */
	switchView(input: BrowserEditorInput, target: ParadisProfileTarget): Promise<BrowserEditorInput | undefined>;
}

/** ドロップダウンで選べる行が指すもの。 */
export type ParadisProfileTarget =
	| { readonly kind: 'profile'; readonly profileId: string }
	| { readonly kind: 'scope'; readonly scope: BrowserViewStorageScope };

export class ParadisBrowserProfilesService extends Disposable implements IParadisBrowserProfilesService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeProfiles = this._register(new Emitter<void>());
	readonly onDidChangeProfiles: Event<void> = this._onDidChangeProfiles.event;

	private _profiles: IParadisBrowserProfile[];
	/** 復元・切り替え用の対応表（viewId → そのビューに使うセッション）。main の答えより弱い。 */
	private readonly _viewOverrides = new Map<string, IBrowserSessionOptions>();
	/**
	 * これから作るビューに使うセッション。`getOrCreateLazy` の直前に置き、ルーターが
	 * 拾ったら消す。ここに残ったままにすると、同じ viewId が再生成されたときに古い
	 * 選択へ戻ってしまう。
	 */
	private readonly _pending = new Map<string, IBrowserSessionOptions>();
	/** main が答えた「実際のセッション」のキャッシュ。 */
	private readonly _resolved = new Map<string, IParadisViewSessionInfo | undefined>();
	private readonly _inputListeners = this._register(new DisposableMap<string>());
	private readonly _mainService: IParadisBrowserProfilesMainService;
	private _shutdownStarted = false;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@IBrowserViewWorkbenchService private readonly browserViewWorkbenchService: IBrowserViewWorkbenchService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._mainService = ProxyChannel.toService<IParadisBrowserProfilesMainService>(
			mainProcessService.getChannel(PARADIS_BROWSER_PROFILE_CHANNEL),
		);

		this._profiles = paradisDeserializeProfiles(
			this.storageService.get(PROFILES_STORAGE_KEY, StorageScope.APPLICATION),
		);
		this._restoreViewOverrides();

		// ルーターの登録は台帳の復元より後。復元前に登録すると、まだ対応を知らないまま
		// 復元中のビューへ fallback（グローバル等）を返してしまい、ログイン状態が消えたように見える。
		this._register(toDisposable(paradisRegisterBrowserProfileRouter({
			resolveSessionOptions: (viewId, fallback) => this._resolveSessionOptions(viewId, fallback),
		})));

		// 台帳は APPLICATION スコープ = 全ウィンドウで1つ。他のウィンドウが書いた分を読み直さないと、
		// 起動しっぱなしのウィンドウが古い配列で丸ごと上書きし、別ウィンドウで作ったプロファイルが
		// 台帳から消える（Cookie 入りのパーティションだけが孤児として残る）。`touch()` は開くたびに
		// 走るので、購読が無いと高確率で踏む。
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, PROFILES_STORAGE_KEY, this._store)(event => {
			if (!event.external) {
				return;
			}
			this._profiles = paradisDeserializeProfiles(this.storageService.get(PROFILES_STORAGE_KEY, StorageScope.APPLICATION));
			this._onDidChangeProfiles.fire();
		}));

		this._register(this.lifecycleService.onWillShutdown(() => this._shutdownStarted = true));
		this._register(this.browserViewWorkbenchService.onDidChangeBrowserViews(() => this._hookKnownViews()));
		this._hookKnownViews();
	}

	// #region 台帳

	list(): readonly IParadisBrowserProfile[] {
		return [...this._profiles].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
	}

	findByName(name: string): IParadisBrowserProfile | undefined {
		return paradisFindProfileByName(this._profiles, name);
	}

	create(name: string, color: string): { readonly ok: true; readonly profile: IParadisBrowserProfile } | { readonly ok: false; readonly error: ParadisProfileNameError } {
		const error = this._validateName(name);
		if (error) {
			return { ok: false, error };
		}
		const now = Date.now();
		const profile: IParadisBrowserProfile = {
			id: this._createProfileId(),
			name: paradisNormalizeProfileName(name),
			color: PARADIS_BROWSER_PROFILE_COLORS.includes(color) ? color : PARADIS_BROWSER_PROFILE_COLORS[0],
			createdAt: now,
			lastUsedAt: now,
		};
		this._profiles = [...this._profiles, profile];
		this._persistProfiles();
		return { ok: true, profile };
	}

	rename(profileId: string, name: string): { readonly ok: true } | { readonly ok: false; readonly error: ParadisProfileNameError } {
		const error = this._validateName(name, profileId);
		if (error) {
			return { ok: false, error };
		}
		this._updateProfile(profileId, profile => ({ ...profile, name: paradisNormalizeProfileName(name) }));
		return { ok: true };
	}

	setColor(profileId: string, color: string): void {
		if (!PARADIS_BROWSER_PROFILE_COLORS.includes(color)) {
			return;
		}
		this._updateProfile(profileId, profile => ({ ...profile, color }));
	}

	async remove(profileId: string): Promise<void> {
		if (!this._profiles.some(profile => profile.id === profileId)) {
			return;
		}
		// 先にタブを閉じてから消す。開いたままのページは clearData() の直後から同じ
		// パーティションへ Cookie を書き戻し、しかも台帳にはもう無いので二度と消せない孤児になる
		// （モーダルは「すべて削除されます」と言い切っているので、実態を合わせる必要がある）。
		this._closeViewsUsingProfile(profileId);

		this._profiles = this._profiles.filter(profile => profile.id !== profileId);
		// 対応表からも外す。残すと、削除したプロファイルのIDで空のパーティションが作り直される。
		for (const [viewId, options] of [...this._viewOverrides]) {
			if (options.profileId === profileId) {
				this._viewOverrides.delete(viewId);
			}
		}
		for (const [viewId, info] of [...this._resolved]) {
			if (info?.profileId === profileId) {
				this._resolved.delete(viewId);
			}
		}
		this._persistProfiles(profileId);
		this._persistViewOverrides();
		await this._clearProfileDataInMain(profileId);
	}

	async clearProfileData(profileId: string): Promise<void> {
		if (!this._profiles.some(profile => profile.id === profileId)) {
			return;
		}
		// 削除と同じ理由でタブを閉じる。消した先から書き戻されると「消えていない」ように見える。
		this._closeViewsUsingProfile(profileId);
		await this._clearProfileDataInMain(profileId);
	}

	private async _clearProfileDataInMain(profileId: string): Promise<void> {
		try {
			await this._mainService.clearProfileData(profileId);
		} catch (error) {
			// 台帳の側は既に片付いており、ユーザーから見た操作は完了している。ディスク上に
			// パーティションが残るだけなので、ここで失敗を前面に出さずログに残す。
			this.logService.warn('[ParadisBrowserProfiles] failed to clear the stored data of a profile', error);
		}
	}

	/**
	 * そのプロファイルを使っている、今開いているタブ。
	 * main が答えた実際のセッション（`_resolved`）を優先し、まだ聞けていないビューだけ
	 * こちら側の対応表で判断する。
	 */
	private _viewsUsingProfile(profileId: string): BrowserEditorInput[] {
		const inputs: BrowserEditorInput[] = [];
		for (const [viewId, input] of this.browserViewWorkbenchService.getKnownBrowserViews()) {
			const usedProfileId = this._resolved.has(viewId)
				? this._resolved.get(viewId)?.profileId
				: this._viewOverrides.get(viewId)?.profileId;
			if (usedProfileId === profileId) {
				inputs.push(input);
			}
		}
		return inputs;
	}

	private _closeViewsUsingProfile(profileId: string): void {
		for (const input of this._viewsUsingProfile(profileId)) {
			input.dispose(true);
		}
	}

	touch(profileId: string): void {
		this._updateProfile(profileId, profile => ({ ...profile, lastUsedAt: Date.now() }));
	}

	getProfileStats(profileId: string): Promise<IParadisBrowserProfileStats> {
		return this._mainService.getProfileStats(profileId).catch(() => ({ cookieCount: undefined, openViewCount: 0 }));
	}

	// #endregion

	// #region ビューとの対応

	getProfileForView(viewId: string): string | undefined {
		return this.getViewSession(viewId)?.profileId;
	}

	getViewSession(viewId: string): IParadisViewSessionInfo | undefined {
		if (this._resolved.has(viewId)) {
			return this._resolved.get(viewId);
		}
		const options = this._pending.get(viewId) ?? this._viewOverrides.get(viewId);
		return options ? { scope: options.scope, profileId: options.profileId } : undefined;
	}

	async resolveViewSession(viewId: string): Promise<IParadisViewSessionInfo | undefined> {
		let info: IParadisViewSessionInfo | undefined;
		try {
			info = await this._mainService.resolveViewSession(viewId);
		} catch (error) {
			// main へ届かないときは、こちら側の対応表の答えを使い続ける（ピルが空欄になるより良い）。
			this.logService.trace('[ParadisBrowserProfiles] could not resolve the session of a view from main', error);
			return this.getViewSession(viewId);
		}
		if (!info) {
			return this.getViewSession(viewId);
		}
		// 台帳に無いプロファイル（別ワークスペースで削除された等）は名前を出しようがないので、
		// プロファイルIDだけ落として「不明なプロファイル」として扱う。
		const profileId = info.profileId !== undefined && this._profiles.some(profile => profile.id === info?.profileId)
			? info.profileId
			: undefined;
		const known: IParadisViewSessionInfo = { scope: info.scope, profileId };
		const previous = this._resolved.get(viewId);
		const changed = !this._resolved.has(viewId) || previous?.scope !== known.scope || previous?.profileId !== known.profileId;
		this._resolved.set(viewId, known);
		if (changed) {
			this._onDidChangeProfiles.fire();
		}
		return known;
	}

	canUseProfiles(): boolean {
		return !this._isWorkspaceUntrusted();
	}

	/**
	 * upstream から渡ってくる唯一の判断点。優先順位は
	 * 「これから開くと決めたもの（pending）」→「復元用の対応表」→「upstream の既定」。
	 *
	 * 信頼していないワークスペースでは必ず fallback（upstream がエフェメラルへ倒したもの）を
	 * 返す。ここで上書きすると、信頼していないフォルダを開いているだけで Cookie が永続化
	 * されることになり、upstream の安全側の判断を黙って壊してしまう。
	 */
	private _resolveSessionOptions(viewId: string, fallback: IBrowserSessionOptions): IBrowserSessionOptions {
		const options = this._pending.get(viewId) ?? this._viewOverrides.get(viewId);
		this._pending.delete(viewId);
		if (!options || this._isWorkspaceUntrusted()) {
			return fallback;
		}
		if (options.scope === BrowserViewStorageScope.Profile) {
			return options.profileId !== undefined && this._profiles.some(profile => profile.id === options.profileId)
				? options
				: fallback;
		}
		return options;
	}

	/** upstream の `_resolveStorageScope()` と同じ判定（あちらは private なので写している）。 */
	private _isWorkspaceUntrusted(): boolean {
		return this.workspaceContextService.getWorkbenchState() !== WorkbenchState.EMPTY
			&& !this.workspaceTrustManagementService.isWorkspaceTrusted();
	}

	// #endregion

	// #region 開く / 切り替える

	async openInProfile(profileId: string, url?: string, group?: IEditorGroup): Promise<BrowserEditorInput | undefined> {
		if (!this._profiles.some(profile => profile.id === profileId) || !this.canUseProfiles()) {
			return undefined;
		}
		const viewId = this._reserveView({ scope: BrowserViewStorageScope.Profile, profileId });
		try {
			const input = this.browserViewWorkbenchService.getOrCreateLazy(viewId, url ? { url } : {});
			await this.editorService.openEditor(input, { pinned: true }, group);
			this.touch(profileId);
			return input;
		} catch (error) {
			this._releaseView(viewId);
			this.logService.error('[ParadisBrowserProfiles] failed to open a page in a named profile', error);
			return undefined;
		}
	}

	/**
	 * 開いているタブのプロファイル切り替え。
	 *
	 * Electron のセッションは `WebContentsView` の構築時に固定され、後から差し替えられない。
	 * よって「切り替え」は原理的に作り直しになる: 同じグループの同じ位置へ新しいビューを
	 * 差し込み、古いビューを閉じる。URL は引き継ぐが、ログイン状態が違うので同じページが
	 * 出るとは限らない（呼び出し側がその旨をユーザーへ知らせる）。
	 */
	async switchView(input: BrowserEditorInput, target: ParadisProfileTarget): Promise<BrowserEditorInput | undefined> {
		const options: IBrowserSessionOptions = target.kind === 'profile'
			? { scope: BrowserViewStorageScope.Profile, profileId: target.profileId }
			: { scope: target.scope };
		if (options.scope === BrowserViewStorageScope.Profile) {
			if (!this._profiles.some(profile => profile.id === options.profileId) || !this.canUseProfiles()) {
				return undefined;
			}
		}
		const group = this.editorGroupsService.groups.find(candidate => candidate.contains(input));
		if (!group) {
			return undefined;
		}
		const url = input.model?.url ?? input.serialize().url;
		const viewId = this._reserveView(options);
		try {
			const replacement = this.browserViewWorkbenchService.getOrCreateLazy(viewId, url ? { url } : {});
			// replaceEditors は同じグループの同じ位置へ差し替える（新しいタブが末尾に増えない）。
			await group.replaceEditors([{ editor: input, replacement, options: { pinned: true } }]);
			if (options.profileId !== undefined) {
				this.touch(options.profileId);
			}
			return replacement;
		} catch (error) {
			this._releaseView(viewId);
			this.logService.error('[ParadisBrowserProfiles] failed to switch a page to another browser session', error);
			return undefined;
		}
	}

	/** 新しいビューIDを取り、そのセッションを予約する（`getOrCreateLazy` を呼ぶ直前に使う）。 */
	private _reserveView(options: IBrowserSessionOptions): string {
		const viewId = generateUuid();
		this._pending.set(viewId, options);
		this._viewOverrides.set(viewId, options);
		this._persistViewOverrides();
		return viewId;
	}

	private _releaseView(viewId: string): void {
		this._pending.delete(viewId);
		this._viewOverrides.delete(viewId);
		this._persistViewOverrides();
	}

	// #endregion

	// #region 内部

	/**
	 * 開いているビューの寿命を追う。ユーザーが閉じたときだけ対応表から外す。
	 *
	 * シャットダウン中（リロード・終了）は外さない: main は WebContentsView を保持したままで、
	 * 次の renderer が同じ viewId へ re-attach する。ここで消すと復元後にプロファイルが
	 * 失われ、ログイン状態が消えたように見える（paradisBrowserScope と同じ理由・同じ形）。
	 */
	private _hookKnownViews(): void {
		for (const [viewId, input] of this.browserViewWorkbenchService.getKnownBrowserViews()) {
			if (this._inputListeners.has(viewId)) {
				continue;
			}
			this._inputListeners.set(viewId, input.onWillDispose(() => {
				this._inputListeners.deleteAndDispose(viewId);
				this._pending.delete(viewId);
				this._resolved.delete(viewId);
				if (this._shutdownStarted || this.lifecycleService.willShutdown) {
					return;
				}
				if (this._viewOverrides.delete(viewId)) {
					this._persistViewOverrides();
				}
			}));
		}
	}

	private _validateName(name: string, exceptId?: string): ParadisProfileNameError | undefined {
		const normalized = paradisNormalizeProfileName(name);
		if (normalized.length === 0) {
			return localize('paradis.browserProfiles.error.empty', "プロファイル名を入力してください。");
		}
		if (paradisIsDuplicateProfileName(this._profiles, normalized, exceptId)) {
			return localize('paradis.browserProfiles.error.duplicate', "「{0}」という名前のプロファイルは既にあります。", normalized);
		}
		return undefined;
	}

	/** 台帳の中で衝突しないIDを作る（12hex なので実際上は1回で決まる）。 */
	private _createProfileId(): string {
		for (let attempt = 0; attempt < 8; attempt++) {
			const candidate = paradisProfileIdFromUuid(generateUuid());
			if (paradisIsValidProfileId(candidate) && !this._profiles.some(profile => profile.id === candidate)) {
				return candidate;
			}
		}
		throw new Error('Could not generate a unique browser profile id');
	}

	private _updateProfile(profileId: string, update: (profile: IParadisBrowserProfile) => IParadisBrowserProfile): void {
		let changed = false;
		this._profiles = this._profiles.map(profile => {
			if (profile.id !== profileId) {
				return profile;
			}
			changed = true;
			return update(profile);
		});
		if (changed) {
			this._persistProfiles();
		}
	}

	private _restoreViewOverrides(): void {
		const raw = this.storageService.get(PROFILE_VIEWS_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return;
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				return;
			}
			for (const [viewId, value] of Object.entries(parsed as Record<string, unknown>)) {
				const options = paradisReviveSessionOptions(value);
				if (options) {
					this._viewOverrides.set(viewId, options);
				}
			}
		} catch {
			// 壊れていたら対応表を捨てる。復元されたタブは既定のスコープで開き直るだけで、
			// パーティション自体は消えないので、プロファイルを選び直せば元に戻る。
		}
	}

	/**
	 * 台帳を書き戻す。**書く直前に読み直して id 単位でマージする。**
	 *
	 * 購読（外部変更）だけでは「通知が届く前に自分が書く」数十msの窓が残り、そこで
	 * 他ウィンドウが足したプロファイルを消してしまう（`touch()` は開くたびに走るので踏みやすい）。
	 * 自分が知っている分を優先し、知らない分（＝他ウィンドウの追加）はそのまま残す。
	 *
	 * 削除の伝播には tombstone が要るのでここでは扱わない。つまり「他ウィンドウが消した直後に
	 * こちらが書くと復活しうる」はまだ残る。消えるより復活する方が安全側なので、この順序にしている。
	 */
	private _persistProfiles(removedId?: string): void {
		const latest = paradisDeserializeProfiles(this.storageService.get(PROFILES_STORAGE_KEY, StorageScope.APPLICATION));
		const mine = new Set(this._profiles.map(profile => profile.id));
		// `removedId` を除外しないと、たった今このウィンドウで消した1件が「他ウィンドウの追加」に
		// 見えて復活する（保存済みの台帳にはまだ載っているため）。削除だけは意図が明確なので通す。
		this._profiles = [
			...latest.filter(profile => !mine.has(profile.id) && profile.id !== removedId),
			...this._profiles,
		];
		this.storageService.store(
			PROFILES_STORAGE_KEY,
			paradisSerializeProfiles(this._profiles),
			StorageScope.APPLICATION,
			// ログイン状態はマシン固有。設定同期に載せると、ログインの無いマシンに名前だけ現れる。
			StorageTarget.MACHINE,
		);
		this._onDidChangeProfiles.fire();
	}

	private _persistViewOverrides(): void {
		// シャットダウン中に閉じたビューはあえて残す（次の renderer が同じ viewId へ re-attach する）。
		// その代わり無限には増やせないので、古い順に上限で刈る。Map は挿入順を保つので、
		// 残るのは直近に開かれたビュー = 復元で必要になる可能性が高いもの。
		// ただし**今開いているビューは絶対に刈らない**（刈ると、そのタブが再起動後に既定スコープへ
		// 戻ってログイン状態を失ったように見える）。
		if (this._viewOverrides.size > MAX_VIEW_OVERRIDES) {
			const open = new Set(this.browserViewWorkbenchService.getKnownBrowserViews().keys());
			let overflow = this._viewOverrides.size - MAX_VIEW_OVERRIDES;
			for (const viewId of [...this._viewOverrides.keys()]) {
				if (overflow <= 0) {
					break;
				}
				if (!open.has(viewId)) {
					this._viewOverrides.delete(viewId);
					overflow--;
				}
			}
		}
		this.storageService.store(
			PROFILE_VIEWS_STORAGE_KEY,
			JSON.stringify(Object.fromEntries(this._viewOverrides)),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);
	}

	// #endregion
}

/** 対応表から読み戻した1件を検証する。壊れた値はその1件だけ捨てる。 */
function paradisReviveSessionOptions(value: unknown): IBrowserSessionOptions | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const candidate = value as Partial<IBrowserSessionOptions>;
	const scopes: readonly string[] = Object.values(BrowserViewStorageScope);
	if (typeof candidate.scope !== 'string' || !scopes.includes(candidate.scope)) {
		return undefined;
	}
	if (candidate.scope === BrowserViewStorageScope.Profile) {
		return paradisIsValidProfileId(candidate.profileId)
			? { scope: BrowserViewStorageScope.Profile, profileId: candidate.profileId }
			: undefined;
	}
	return { scope: candidate.scope as BrowserViewStorageScope };
}
