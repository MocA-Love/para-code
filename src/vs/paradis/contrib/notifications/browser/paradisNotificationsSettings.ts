/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知サウンド + Aivis読み上げ設定の永続化サービス（IStorageService、APPLICATIONスコープ）。
// キーは `paradis.notifications.*` プレフィックスで統一する。APIキー等の機微情報を含むため
// StorageTarget.MACHINE を使い、Settings Sync による同期対象から外す。
// 読み上げの API キー（Aivis・ElevenLabs）は ISecretStorageService に置く。secret storage が
// 暗号化して保存できない環境（in-memory にしかならない場合）だけ、今までどおり JSON に残す。

import { raceTimeout, RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import {
	DEFAULT_RINGTONE_ID,
	IParadisAivisModelPreset,
	PARADIS_AIVIS_DEFAULT_FORMAT,
	PARADIS_AIVIS_DEFAULT_FORMAT_PERMISSION,
} from '../common/paradisNotifications.js';
import {
	paradisClampElevenLabsSpeed,
	paradisIsApiKeyLost,
	paradisNormalizeVoiceEngine,
	paradisPlanApiKeyMigration,
	ParadisVoiceEngine,
	PARADIS_ELEVENLABS_DEFAULT_MODEL_ID,
	PARADIS_ELEVENLABS_SPEED_DEFAULT,
} from '../common/paradisElevenLabs.js';

/**
 * 音声報告（読み上げ）の設定。名前は Aivis 専用だった頃のままだが、ElevenLabs の設定も同じ JSON に持つ。
 * 有効化・音量・文面は2つのエンジンで共通。API キーと声はエンジンごとに別々に覚え、切り替えても消えない。
 */
export interface IParadisAivisSettings {
	enabled: boolean;
	apiKey: string;
	modelUuid: string;
	userDictionaryUuid: string;
	format: string;
	formatPermission: string;
	/** 0-100 */
	volume: number;
	/** 0.5-2.0 */
	speakingRate: number;
	/** 読み上げエンジン。既定は Aivis。 */
	engine: ParadisVoiceEngine;
	elevenLabsApiKey: string;
	elevenLabsVoiceId: string;
	elevenLabsModelId: string;
	/** 0.7-1.2（ElevenLabs の voice_settings.speed） */
	elevenLabsSpeed: number;
	/** 適用する ElevenLabs の発音辞書の ID。空なら辞書なし。 */
	elevenLabsDictionaryId: string;
}

const DEFAULT_AIVIS_SETTINGS: IParadisAivisSettings = Object.freeze({
	enabled: false,
	apiKey: '',
	modelUuid: '',
	userDictionaryUuid: '',
	format: PARADIS_AIVIS_DEFAULT_FORMAT,
	formatPermission: PARADIS_AIVIS_DEFAULT_FORMAT_PERMISSION,
	volume: 100,
	speakingRate: 1.0,
	engine: 'aivis',
	elevenLabsApiKey: '',
	elevenLabsVoiceId: '',
	elevenLabsModelId: PARADIS_ELEVENLABS_DEFAULT_MODEL_ID,
	elevenLabsSpeed: PARADIS_ELEVENLABS_SPEED_DEFAULT,
	elevenLabsDictionaryId: '',
});

/** API キーを入れる設定のフィールド。secret storage のキーと対にする。 */
export type ParadisApiKeyField = 'apiKey' | 'elevenLabsApiKey';

const API_KEY_SECRETS: Readonly<Record<ParadisApiKeyField, string>> = Object.freeze({
	apiKey: 'paradis.notifications.aivis.apiKey',
	elevenLabsApiKey: 'paradis.notifications.elevenLabs.apiKey',
});

const API_KEY_FIELDS: readonly ParadisApiKeyField[] = ['apiKey', 'elevenLabsApiKey'];

/**
 * JSON に残す「このキーは secret storage に置いた」印（キー本体ではない）。印があるのに secret から
 * 読めなければ、復号の失敗などで消えたと分かる。
 */
const SECRET_MARKER_FIELD = 'secretApiKeys';

type IParadisStoredAivisSettings = Partial<IParadisAivisSettings> & { [SECRET_MARKER_FIELD]?: unknown };

function paradisStoredSecretMarkers(stored: IParadisStoredAivisSettings): ParadisApiKeyField[] {
	const raw = stored[SECRET_MARKER_FIELD];
	return Array.isArray(raw) ? API_KEY_FIELDS.filter(field => raw.includes(field)) : [];
}

/**
 * 読み上げの直前に API キーの読み込みを待つ。secret storage が応答しなくても読み上げ全体が
 * 止まらないよう、`timeoutMs` で打ち切る。読み終えたら true。
 */
export async function paradisWaitForApiKeys(service: Pick<IParadisNotificationsSettingsService, 'whenApiKeysLoaded' | 'areApiKeysLoaded'>, timeoutMs: number): Promise<boolean> {
	if (service.areApiKeysLoaded()) {
		return true;
	}
	return raceTimeout(service.whenApiKeysLoaded().then(() => true), timeoutMs, undefined).then(result => result === true);
}

/** おやすみモードの状態。`until` は解除予定時刻（epoch ms、undefined は「自分でオフにするまで」）。 */
export interface IParadisDoNotDisturbState {
	readonly enabled: boolean;
	readonly until: number | undefined;
}

/** おやすみモードの変更元。external は別window等からのAPPLICATION storage変更を表す。 */
export interface IParadisDoNotDisturbChangeEvent {
	readonly external: boolean;
}

export const IParadisNotificationsSettingsService = createDecorator<IParadisNotificationsSettingsService>('paradisNotificationsSettingsService');

/**
 * `onDidChange` が通知する変更範囲。設定ダイアログの各セクションは自分に関係しないスコープの
 * 変更まで購読すると、無関係な操作のたびに自身のDOMを丸ごと再構築してしまう
 * （着信音リスト等の非同期再フェッチによるスクロール位置のズレ・ちらつきの原因になっていた）。
 * そのため「通知サウンド関連」と「Aivis関連」を分けて通知し、各セクションが自分のスコープの
 * 変更だけを購読できるようにする。
 */
export type ParadisNotificationsChangeScope = 'notifications' | 'aivis' | 'dnd';

/**
 * 通知サウンド + Aivis読み上げ設定の読み書きサービス。トリガー・再生ロジック（electron-browser）と
 * 設定UI（electron-browser の自前ダイアログ）の両方から参照される。
 */
export interface IParadisNotificationsSettingsService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<ParadisNotificationsChangeScope>;
	readonly onDidChangeDoNotDisturb: Event<IParadisDoNotDisturbChangeEvent>;

	getSelectedRingtoneId(): string;
	setSelectedRingtoneId(id: string): void;

	getSoundsMuted(): boolean;
	setSoundsMuted(muted: boolean): void;

	/** 0-100 */
	getVolume(): number;
	setVolume(volume: number): void;

	/** OS（デスクトップ）通知を出すか。既定 true。 */
	getOsNotificationsEnabled(): boolean;
	setOsNotificationsEnabled(enabled: boolean): void;

	/** 対応待ち（permission）遷移で OS 通知を出すか。既定 true。 */
	getOsNotifyOnPermission(): boolean;
	setOsNotifyOnPermission(enabled: boolean): void;

	/** 作業完了（review）遷移で OS 通知を出すか。既定 true。 */
	getOsNotifyOnReview(): boolean;
	setOsNotifyOnReview(enabled: boolean): void;

	/**
	 * アクティブスペースを見ている（ウィンドウがフォーカス中）ときも通知するか。既定 false。
	 * false の場合、いま見ているスペースのイベントはフォーカス中は通知されない（音・OS通知・Aivis すべて）。
	 */
	getNotifyWhileFocused(): boolean;
	setNotifyWhileFocused(enabled: boolean): void;

	/**
	 * おやすみモードの状態。音・OS通知・Aivis読み上げを一括で抑制する。
	 * `until` を過ぎている場合はこの getter 自身が保存済みの状態を破棄して解除後の値を返すため、
	 * 失効を監視する専用のタイマーは不要（読み取り時に失効させる）。
	 */
	getDoNotDisturb(): IParadisDoNotDisturbState;
	setDoNotDisturb(enabled: boolean, until: number | undefined): void;

	getAivisSettings(): IParadisAivisSettings;
	setAivisSettings(patch: Partial<IParadisAivisSettings>): void;

	/**
	 * API キーを secret storage から読み終えたら解決する。起動直後の通知で読み上げのキーが
	 * まだ空に見えるのを避けるため、読み上げの直前に待つ。読み込みに失敗しても解決する。
	 */
	whenApiKeysLoaded(): Promise<void>;

	/** API キーを読み終えたか。読み終えるまで設定画面のキー欄は触れないようにする。 */
	areApiKeysLoaded(): boolean;

	/**
	 * secret storage に置いたはずのキーが読み出せなかったか（復号の失敗などで消えた）。
	 * 設定画面のキー欄に再入力を促すのに使う。新しいキーを入れると解消する。
	 */
	isApiKeyLost(field: ParadisApiKeyField): boolean;

	/** ユーザーが追加したAivisモデルプリセット（ビルトイン9種とは別に保持）。 */
	getCustomAivisModelPresets(): readonly IParadisAivisModelPreset[];
	addCustomAivisModelPreset(preset: IParadisAivisModelPreset): void;
	removeCustomAivisModelPreset(uuid: string): void;
}

const KEY_RINGTONE_ID = 'paradis.notifications.selectedRingtoneId';
const KEY_MUTED = 'paradis.notifications.soundsMuted';
const KEY_VOLUME = 'paradis.notifications.volume';
const KEY_OS_ENABLED = 'paradis.notifications.osNotificationsEnabled';
const KEY_OS_PERMISSION = 'paradis.notifications.osNotifyOnPermission';
const KEY_OS_REVIEW = 'paradis.notifications.osNotifyOnReview';
const KEY_NOTIFY_FOCUSED = 'paradis.notifications.notifyWhileFocused';
const KEY_DO_NOT_DISTURB = 'paradis.notifications.doNotDisturb';
const KEY_DO_NOT_DISTURB_UNTIL = 'paradis.notifications.doNotDisturbUntil';
const KEY_AIVIS = 'paradis.notifications.aivis';
const KEY_AIVIS_CUSTOM_PRESETS = 'paradis.notifications.aivisCustomModelPresets';

/**
 * 既にpendingな0ms windowのdeadlineを動かさず、次のexternal DND通知を予約する。
 */
export function paradisScheduleDoNotDisturbExternalChange(scheduler: { isScheduled(): boolean; schedule(): void }): void {
	if (!scheduler.isScheduled()) {
		scheduler.schedule();
	}
}

/** 通知サウンドとAivis、おやすみモード設定のAPPLICATION storage実装。 */
export class ParadisNotificationsSettingsService extends Disposable implements IParadisNotificationsSettingsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<ParadisNotificationsChangeScope>());
	readonly onDidChange: Event<ParadisNotificationsChangeScope> = this._onDidChange.event;
	private readonly _onDidChangeDoNotDisturb = this._register(new Emitter<IParadisDoNotDisturbChangeEvent>());
	readonly onDidChangeDoNotDisturb: Event<IParadisDoNotDisturbChangeEvent> = this._onDidChangeDoNotDisturb.event;

	private readonly _doNotDisturbExternalChangeScheduler = this._register(new RunOnceScheduler(
		() => this._onDidChangeDoNotDisturb.fire({ external: true }),
		0,
	));

	/** secret storage から読んだ（または画面で入れた）API キー。JSON の値より優先する。 */
	private readonly _apiKeyOverrides = new Map<ParadisApiKeyField, string>();
	/** secret storage が暗号化して保存できるか。読み込みが終わるまでは undefined。 */
	private _secretsPersisted: boolean | undefined;
	/** secret storage へ移せず、JSON に置いたままにしているキー。JSON から消さない。 */
	private readonly _apiKeysKeptInJson = new Set<ParadisApiKeyField>();
	/** 移したはずなのに secret storage から読めなかったキー。 */
	private readonly _lostApiKeys = new Set<ParadisApiKeyField>();
	private readonly _apiKeysLoaded: Promise<void>;
	private _apiKeysLoadedDone = false;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
	) {
		super();

		this._apiKeysLoaded = this._loadApiKeys()
			.catch(() => { /* 読めなければ JSON の値のまま動く */ })
			.finally(() => { this._apiKeysLoadedDone = true; });
		this._register(this.secretStorageService.onDidChangeSecret(key => {
			const field = API_KEY_FIELDS.find(candidate => API_KEY_SECRETS[candidate] === key);
			if (field && this._secretsPersisted) {
				void this._reloadApiKey(field);
			}
		}));

		for (const key of [KEY_DO_NOT_DISTURB, KEY_DO_NOT_DISTURB_UNTIL]) {
			this.storageService.onDidChangeValue(StorageScope.APPLICATION, key, this._store)(event => {
				if (event.external !== true) {
					return;
				}
				paradisScheduleDoNotDisturbExternalChange(this._doNotDisturbExternalChangeScheduler);
			}, undefined, this._store);
		}
	}

	getSelectedRingtoneId(): string {
		return this.storageService.get(KEY_RINGTONE_ID, StorageScope.APPLICATION, DEFAULT_RINGTONE_ID);
	}

	setSelectedRingtoneId(id: string): void {
		this.storageService.store(KEY_RINGTONE_ID, id, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._onDidChange.fire('notifications');
	}

	getSoundsMuted(): boolean {
		return this.storageService.getBoolean(KEY_MUTED, StorageScope.APPLICATION, false);
	}

	setSoundsMuted(muted: boolean): void {
		this.storageService.store(KEY_MUTED, muted, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._onDidChange.fire('notifications');
	}

	getVolume(): number {
		const value = this.storageService.getNumber(KEY_VOLUME, StorageScope.APPLICATION, 100);
		return Math.max(0, Math.min(100, value));
	}

	setVolume(volume: number): void {
		this.storageService.store(KEY_VOLUME, Math.max(0, Math.min(100, volume)), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._onDidChange.fire('notifications');
	}

	getOsNotificationsEnabled(): boolean {
		return this.storageService.getBoolean(KEY_OS_ENABLED, StorageScope.APPLICATION, true);
	}

	setOsNotificationsEnabled(enabled: boolean): void {
		this.storageService.store(KEY_OS_ENABLED, enabled, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._onDidChange.fire('notifications');
	}

	getOsNotifyOnPermission(): boolean {
		return this.storageService.getBoolean(KEY_OS_PERMISSION, StorageScope.APPLICATION, true);
	}

	setOsNotifyOnPermission(enabled: boolean): void {
		this.storageService.store(KEY_OS_PERMISSION, enabled, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._onDidChange.fire('notifications');
	}

	getOsNotifyOnReview(): boolean {
		return this.storageService.getBoolean(KEY_OS_REVIEW, StorageScope.APPLICATION, true);
	}

	setOsNotifyOnReview(enabled: boolean): void {
		this.storageService.store(KEY_OS_REVIEW, enabled, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._onDidChange.fire('notifications');
	}

	getNotifyWhileFocused(): boolean {
		return this.storageService.getBoolean(KEY_NOTIFY_FOCUSED, StorageScope.APPLICATION, false);
	}

	setNotifyWhileFocused(enabled: boolean): void {
		this.storageService.store(KEY_NOTIFY_FOCUSED, enabled, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._onDidChange.fire('notifications');
	}

	getDoNotDisturb(): IParadisDoNotDisturbState {
		if (!this.storageService.getBoolean(KEY_DO_NOT_DISTURB, StorageScope.APPLICATION, false)) {
			return { enabled: false, until: undefined };
		}
		const until = this.storageService.getNumber(KEY_DO_NOT_DISTURB_UNTIL, StorageScope.APPLICATION);
		if (until !== undefined && until <= Date.now()) {
			// 期限切れ。次回以降の読み取りで再判定しなくて済むよう、ここで保存済みの状態を捨てる。
			// onDidChange は発火しない（getter からの再入で購読側の再描画が走るのを避けるため）。
			// UI 側は各 surface の deadline-aware refresh で追従する。
			this.storageService.remove(KEY_DO_NOT_DISTURB, StorageScope.APPLICATION);
			this.storageService.remove(KEY_DO_NOT_DISTURB_UNTIL, StorageScope.APPLICATION);
			return { enabled: false, until: undefined };
		}
		return { enabled: true, until };
	}

	setDoNotDisturb(enabled: boolean, until: number | undefined): void {
		if (!enabled) {
			this.storageService.remove(KEY_DO_NOT_DISTURB, StorageScope.APPLICATION);
			this.storageService.remove(KEY_DO_NOT_DISTURB_UNTIL, StorageScope.APPLICATION);
		} else {
			this.storageService.store(KEY_DO_NOT_DISTURB, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
			if (until === undefined) {
				this.storageService.remove(KEY_DO_NOT_DISTURB_UNTIL, StorageScope.APPLICATION);
			} else {
				this.storageService.store(KEY_DO_NOT_DISTURB_UNTIL, until, StorageScope.APPLICATION, StorageTarget.MACHINE);
			}
		}
		this._onDidChange.fire('dnd');
		this._onDidChangeDoNotDisturb.fire({ external: false });
	}

	/** JSON に保存されている値（API キーの上書きを当てる前）。 */
	private _readStoredAivisSettings(): IParadisStoredAivisSettings {
		const raw = this.storageService.get(KEY_AIVIS, StorageScope.APPLICATION);
		if (!raw) {
			return {};
		}
		try {
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as IParadisStoredAivisSettings : {};
		} catch {
			return {};
		}
	}

	private _writeStoredAivisSettings(value: IParadisStoredAivisSettings): void {
		this.storageService.store(KEY_AIVIS, JSON.stringify(value), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	/** JSON の「secret storage に置いた」印を付け外しする（キー本体は書かない）。 */
	private _setSecretMarker(field: ParadisApiKeyField, present: boolean): void {
		const stored = this._readStoredAivisSettings();
		const markers = new Set(paradisStoredSecretMarkers(stored));
		if (markers.has(field) === present) {
			return;
		}
		if (present) {
			markers.add(field);
		} else {
			markers.delete(field);
		}
		stored[SECRET_MARKER_FIELD] = API_KEY_FIELDS.filter(candidate => markers.has(candidate));
		this._writeStoredAivisSettings(stored);
	}

	getAivisSettings(): IParadisAivisSettings {
		const stored = this._readStoredAivisSettings();
		delete stored[SECRET_MARKER_FIELD];
		const settings: IParadisAivisSettings = { ...DEFAULT_AIVIS_SETTINGS, ...stored };
		for (const [field, value] of this._apiKeyOverrides) {
			settings[field] = value;
		}
		settings.engine = paradisNormalizeVoiceEngine(settings.engine);
		settings.elevenLabsSpeed = paradisClampElevenLabsSpeed(settings.elevenLabsSpeed);
		return settings;
	}

	setAivisSettings(patch: Partial<IParadisAivisSettings>): void {
		const next: IParadisStoredAivisSettings = { ...DEFAULT_AIVIS_SETTINGS, ...this._readStoredAivisSettings(), ...patch };
		for (const field of API_KEY_FIELDS) {
			const value = patch[field];
			if (value !== undefined) {
				this._apiKeyOverrides.set(field, value);
				this._lostApiKeys.delete(field);
				void this._persistApiKey(field, value);
			}
			if (this._apiKeysKeptInJson.has(field)) {
				continue;
			}
			if (this._secretsPersisted === true || (this._secretsPersisted === undefined && value !== undefined)) {
				// キーは secret storage に置く（書けなかったときは _persistApiKey が JSON に戻す）。
				// 読み込み前に入れ直されたキーも、行き先が決まるまで JSON へは書かない。
				// 読み込み前に他の項目だけを変えた場合は、移行前の JSON のキーを消さない。
				delete next[field];
			}
		}
		this._writeStoredAivisSettings(next);
		this._onDidChange.fire('aivis');
	}

	whenApiKeysLoaded(): Promise<void> {
		return this._apiKeysLoaded;
	}

	areApiKeysLoaded(): boolean {
		return this._apiKeysLoadedDone;
	}

	isApiKeyLost(field: ParadisApiKeyField): boolean {
		return this._lostApiKeys.has(field);
	}

	/**
	 * 起動時に API キーを読み込み、JSON に平文で残っているキーを secret storage へ移す。
	 * 移せなかったら JSON から消さない。
	 *
	 * 別のウィンドウが同時に移行していても取りこぼさないよう、JSON を先に読み、その後で secret を読む
	 * （逆順だと「secret はまだ空・JSON はもう消えた」の間に挟まってキーが空に見える）。
	 */
	private async _loadApiKeys(): Promise<void> {
		const storedAtStart = this._readStoredAivisSettings();
		const markers = new Set(paradisStoredSecretMarkers(storedAtStart));
		const secrets = new Map<ParadisApiKeyField, string | undefined>();
		for (const field of API_KEY_FIELDS) {
			secrets.set(field, await this._readSecret(field));
		}
		// type は最初の get で決まる（それまでは 'unknown'）。移行が終わるまでは _secretsPersisted を
		// 決めないでおき、その間の setAivisSettings が移行前の JSON のキーを消さないようにする。
		const persisted = this.secretStorageService.type === 'persisted';

		let changed = false;
		const removeFromJson: ParadisApiKeyField[] = [];
		for (const field of API_KEY_FIELDS) {
			if (this._apiKeyOverrides.has(field)) {
				continue; // 読み込み中に画面で入れ直された。その値を _persistApiKey が保存する
			}
			if (!persisted) {
				continue; // 今までどおり JSON の値を使う
			}
			const stored = storedAtStart[field];
			const jsonKey = typeof stored === 'string' ? stored : undefined;
			let plan = paradisPlanApiKeyMigration(jsonKey, secrets.get(field), true);
			if (plan.use === '' && jsonKey === undefined) {
				// 別のウィンドウの移行がちょうど secret へ書いたところかもしれない。もう一度だけ読む。
				const again = await this._readSecret(field);
				if (again) {
					plan = { use: again, removeFromJson: false };
				}
			}
			if (plan.writeSecret !== undefined) {
				try {
					await this.secretStorageService.set(API_KEY_SECRETS[field], plan.writeSecret);
				} catch {
					this._apiKeysKeptInJson.add(field);
					continue; // 移せなかった。JSON のキーを使い続け、消さない
				}
			}
			if (plan.use !== (jsonKey ?? '')) {
				changed = true;
			}
			this._apiKeyOverrides.set(field, plan.use);
			if (plan.removeFromJson) {
				removeFromJson.push(field);
			}
			if (paradisIsApiKeyLost(markers.has(field), plan.use)) {
				// 移したはずのキーが secret storage から読めない（復号に失敗すると上流の get が黙って消す）。
				this._lostApiKeys.add(field);
				changed = true;
			}
		}
		if (persisted) {
			const stored = this._readStoredAivisSettings();
			for (const field of removeFromJson) {
				delete stored[field];
			}
			// 印は「secret に置いたキーがある」か「読み出せなかった（再入力待ち）」のとき残す。
			const nextMarkers = API_KEY_FIELDS.filter(field => this._lostApiKeys.has(field) || (!this._apiKeysKeptInJson.has(field) && !!this._apiKeyOverrides.get(field)));
			stored[SECRET_MARKER_FIELD] = nextMarkers;
			if (removeFromJson.length > 0 || JSON.stringify(paradisStoredSecretMarkers(storedAtStart)) !== JSON.stringify(nextMarkers)) {
				this._writeStoredAivisSettings(stored);
			}
		}
		this._secretsPersisted = persisted;
		if (changed) {
			this._onDidChange.fire('aivis');
		}
	}

	private async _readSecret(field: ParadisApiKeyField): Promise<string | undefined> {
		try {
			return await this.secretStorageService.get(API_KEY_SECRETS[field]);
		} catch {
			return undefined;
		}
	}

	/** 画面で入れた API キーを保存する。secret storage に書けなければ JSON に戻す。 */
	private async _persistApiKey(field: ParadisApiKeyField, value: string): Promise<void> {
		await this._apiKeysLoaded;
		if (this._apiKeyOverrides.get(field) !== value) {
			return; // 後から別の値が入った。そちらの保存に任せる
		}
		if (this._secretsPersisted) {
			try {
				if (value) {
					await this.secretStorageService.set(API_KEY_SECRETS[field], value);
				} else {
					await this.secretStorageService.delete(API_KEY_SECRETS[field]);
				}
				this._setSecretMarker(field, !!value);
				if (this._apiKeysKeptInJson.delete(field)) {
					// 以前 JSON に残したキーは、secret storage に書けたので消す。
					const stored = this._readStoredAivisSettings();
					delete stored[field];
					this._writeStoredAivisSettings(stored);
				}
				return;
			} catch {
				// 下で JSON に書く
			}
		}
		if (this._secretsPersisted) {
			this._apiKeysKeptInJson.add(field);
		}
		const stored = this._readStoredAivisSettings();
		stored[field] = value;
		this._writeStoredAivisSettings(stored);
	}

	/** 別のウィンドウが secret storage のキーを変えたときに読み直す。 */
	private async _reloadApiKey(field: ParadisApiKeyField): Promise<void> {
		let value: string | undefined;
		try {
			value = await this.secretStorageService.get(API_KEY_SECRETS[field]);
		} catch {
			return;
		}
		const next = value ?? '';
		if (this._apiKeyOverrides.get(field) === next) {
			return;
		}
		this._apiKeyOverrides.set(field, next);
		if (next) {
			this._lostApiKeys.delete(field);
		}
		this._onDidChange.fire('aivis');
	}

	getCustomAivisModelPresets(): readonly IParadisAivisModelPreset[] {
		const raw = this.storageService.get(KEY_AIVIS_CUSTOM_PRESETS, StorageScope.APPLICATION);
		if (!raw) {
			return [];
		}
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}

	addCustomAivisModelPreset(preset: IParadisAivisModelPreset): void {
		const existing = this.getCustomAivisModelPresets().filter(p => p.uuid !== preset.uuid);
		const next = [...existing, preset];
		this.storageService.store(KEY_AIVIS_CUSTOM_PRESETS, JSON.stringify(next), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._onDidChange.fire('aivis');
	}

	removeCustomAivisModelPreset(uuid: string): void {
		const next = this.getCustomAivisModelPresets().filter(p => p.uuid !== uuid);
		this.storageService.store(KEY_AIVIS_CUSTOM_PRESETS, JSON.stringify(next), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._onDidChange.fire('aivis');
	}
}

registerSingleton(IParadisNotificationsSettingsService, ParadisNotificationsSettingsService, InstantiationType.Delayed);
