/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知サウンド + Aivis読み上げ設定の永続化サービス（IStorageService、APPLICATIONスコープ）。
// キーは `paradis.notifications.*` プレフィックスで統一する。APIキー等の機微情報を含むため
// StorageTarget.MACHINE を使い、Settings Sync による同期対象から外す。

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import {
	DEFAULT_RINGTONE_ID,
	IParadisAivisModelPreset,
	PARADIS_AIVIS_DEFAULT_FORMAT,
	PARADIS_AIVIS_DEFAULT_FORMAT_PERMISSION,
} from '../common/paradisNotifications.js';

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
});

export const IParadisNotificationsSettingsService = createDecorator<IParadisNotificationsSettingsService>('paradisNotificationsSettingsService');

/**
 * `onDidChange` が通知する変更範囲。設定ダイアログの各セクションは自分に関係しないスコープの
 * 変更まで購読すると、無関係な操作のたびに自身のDOMを丸ごと再構築してしまう
 * （着信音リスト等の非同期再フェッチによるスクロール位置のズレ・ちらつきの原因になっていた）。
 * そのため「通知サウンド関連」と「Aivis関連」を分けて通知し、各セクションが自分のスコープの
 * 変更だけを購読できるようにする。
 */
export type ParadisNotificationsChangeScope = 'notifications' | 'aivis';

/**
 * 通知サウンド + Aivis読み上げ設定の読み書きサービス。トリガー・再生ロジック（electron-browser）と
 * 設定UI（electron-browser の自前ダイアログ）の両方から参照される。
 */
export interface IParadisNotificationsSettingsService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<ParadisNotificationsChangeScope>;

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

	getAivisSettings(): IParadisAivisSettings;
	setAivisSettings(patch: Partial<IParadisAivisSettings>): void;

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
const KEY_AIVIS = 'paradis.notifications.aivis';
const KEY_AIVIS_CUSTOM_PRESETS = 'paradis.notifications.aivisCustomModelPresets';

class ParadisNotificationsSettingsService extends Disposable implements IParadisNotificationsSettingsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<ParadisNotificationsChangeScope>());
	readonly onDidChange: Event<ParadisNotificationsChangeScope> = this._onDidChange.event;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
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

	getAivisSettings(): IParadisAivisSettings {
		const raw = this.storageService.get(KEY_AIVIS, StorageScope.APPLICATION);
		if (!raw) {
			return { ...DEFAULT_AIVIS_SETTINGS };
		}
		try {
			const parsed = JSON.parse(raw) as Partial<IParadisAivisSettings>;
			return { ...DEFAULT_AIVIS_SETTINGS, ...parsed };
		} catch {
			return { ...DEFAULT_AIVIS_SETTINGS };
		}
	}

	setAivisSettings(patch: Partial<IParadisAivisSettings>): void {
		const next = { ...this.getAivisSettings(), ...patch };
		this.storageService.store(KEY_AIVIS, JSON.stringify(next), StorageScope.APPLICATION, StorageTarget.MACHINE);
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
