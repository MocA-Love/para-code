/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知サウンド + Aivis読み上げ機能の共有データモデル。workbench (browser / electron-browser) と
// shared process (node) の両方から参照される（Superset apps/desktop の shared/ringtones.ts と
// main/lib/notifications/aivis-tts.ts の移植・統合）。

/** shared process 側の通知バックエンド (node/paradisNotificationsChannel.ts) のIPCチャネル名。 */
export const PARADIS_NOTIFICATIONS_CHANNEL = 'paradisNotifications';

// --- 着信音（ビルトイン + カスタム） ----------------------------------------------------------

export interface IParadisRingtoneData {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly filename: string;
	readonly emoji: string;
	/** 秒。カスタム音源は undefined（都度メタデータから取得）。 */
	readonly duration?: number;
}

export const CUSTOM_RINGTONE_ID = 'custom';
export const DEFAULT_RINGTONE_ID = 'arcade';

/** ビルトイン着信音。Superset (apps/desktop の shared/ringtones.ts) と同一データ。 */
export const PARADIS_RINGTONES: readonly IParadisRingtoneData[] = Object.freeze([
	{ id: 'shamisen', name: 'Shamisen', description: 'Japanese string instrument', filename: 'shamisen.mp3', emoji: '🪕', duration: 1 },
	// allow-any-unicode-next-line
	{ id: 'arcade', name: 'Arcade', description: 'Retro game sounds', filename: 'arcade.mp3', emoji: '🕹️', duration: 3 },
	// allow-any-unicode-next-line
	{ id: 'ping', name: 'Ping', description: 'Quick alert tone', filename: 'ping.mp3', emoji: '📍', duration: 1 },
	// allow-any-unicode-next-line
	{ id: 'quick', name: 'Quick Ping', description: 'Short & sweet', filename: 'supersetquick.mp3', emoji: '⚡', duration: 3 },
	// allow-any-unicode-next-line
	{ id: 'doowap', name: 'Doo-Wap', description: 'Retro vibes', filename: 'supersetdoowap.mp3', emoji: '🎷', duration: 10 },
	// allow-any-unicode-next-line
	{ id: 'woman', name: 'Agent is Done', description: 'Your agent is done!', filename: 'agentisdonewoman.mp3', emoji: '👩‍💻', duration: 8 },
	// allow-any-unicode-next-line
	{ id: 'african', name: 'Code Complete', description: 'World music energy', filename: 'codecompleteafrican.mp3', emoji: '🌍', duration: 9 },
	// allow-any-unicode-next-line
	{ id: 'afrobeat', name: 'Afrobeat Code Complete', description: 'Groovy celebration', filename: 'codecompleteafrobeat.mp3', emoji: '🥁', duration: 9 },
	// allow-any-unicode-next-line
	{ id: 'edm', name: 'Long EDM', description: 'Bass goes brrrr', filename: 'codecompleteedm.mp3', emoji: '🎧', duration: 56 },
	// allow-any-unicode-next-line
	{ id: 'comeback', name: 'Come Back!', description: 'Code needs you', filename: 'comebacktothecode.mp3', emoji: '📢', duration: 7 },
	{ id: 'shabala', name: 'Shabalaba', description: 'Ding dong vibes', filename: 'shabalabadingdong.mp3', emoji: '🎉', duration: 7 },
]);

export function getRingtoneById(id: string): IParadisRingtoneData | undefined {
	return PARADIS_RINGTONES.find(r => r.id === id);
}

export function isBuiltInRingtoneId(id: string): boolean {
	return PARADIS_RINGTONES.some(r => r.id === id);
}

export function getRingtoneFilename(id: string): string {
	return getRingtoneById(id)?.filename ?? '';
}

/** shared process (~/.para-code/assets/ringtones/) に保存されたカスタム音源のメタ情報。 */
export interface IParadisCustomRingtoneInfo {
	readonly id: typeof CUSTOM_RINGTONE_ID;
	readonly name: string;
	readonly description: string;
	readonly emoji: string;
	readonly thumbnailUrl?: string;
	readonly duration?: number;
}

/** カスタム音源の編集状態（YouTube取込 → 波形エディタで再編集する際に復元される）。 */
export interface IParadisRingtoneEditState {
	readonly startSeconds: number;
	readonly endSeconds: number;
	readonly fadeInSeconds?: number;
	readonly fadeOutSeconds?: number;
	readonly playbackRate?: number;
	readonly sourceTitle?: string;
	readonly sourceUrl?: string;
}

export const PARADIS_MAX_CLIP_DURATION_SECONDS = 30;
export const PARADIS_MAX_CUSTOM_AUDIO_SIZE_BYTES = 20 * 1024 * 1024;
/** リモート音声(Aivisモデルのサンプル音声等)を shared process 経由で取得する際の上限サイズ。 */
export const PARADIS_MAX_FETCHED_AUDIO_SIZE_BYTES = 10 * 1024 * 1024;

// --- YouTube取込 --------------------------------------------------------------------------------

export interface IParadisYouTubeVideoInfo {
	readonly title: string;
	readonly thumbnailUrl: string;
	readonly durationSeconds: number;
}

export interface IParadisYouTubeDownloadResult {
	readonly tempId: string;
	readonly info: IParadisYouTubeVideoInfo;
}

export interface IParadisRenderClipRequest {
	/** downloadYouTubeAudio が返した tempId。省略時は保存済みソース（再編集）を使う。 */
	readonly tempId?: string;
	readonly startSeconds: number;
	readonly endSeconds: number;
	readonly fadeInSeconds?: number;
	readonly fadeOutSeconds?: number;
	readonly playbackRate?: number;
	readonly displayName?: string;
	readonly thumbnailUrl?: string;
	readonly sourceTitle?: string;
	readonly sourceUrl?: string;
}

export type ParadisInstallLogLevel = 'info' | 'warn' | 'error';

export interface IParadisInstallLogLine {
	readonly seq: number;
	readonly time: number;
	readonly level: ParadisInstallLogLevel;
	readonly message: string;
}

export interface IParadisInstallLogResult {
	readonly lines: readonly IParadisInstallLogLine[];
	readonly done: boolean;
	readonly error?: string;
}

// --- Aivis読み上げ -------------------------------------------------------------------------------

export type ParadisAivisEventKind = 'complete' | 'permission';

export interface IParadisAivisPlaceholders {
	branch?: string;
	workspace?: string;
	worktree?: string;
	project?: string;
	tab?: string;
	pane?: string;
	event?: string;
}

export const PARADIS_AIVIS_PLACEHOLDER_KEYS = ['branch', 'workspace', 'worktree', 'project', 'tab', 'pane', 'event'] as const satisfies readonly (keyof IParadisAivisPlaceholders)[];

/** プレースホルダ表示用ラベル（日本語、Superset移植）。 */
export const PARADIS_AIVIS_PLACEHOLDER_LABELS: Readonly<Record<(typeof PARADIS_AIVIS_PLACEHOLDER_KEYS)[number], string>> = Object.freeze({
	// allow-any-unicode-next-line
	branch: 'ブランチ',
	// allow-any-unicode-next-line
	workspace: 'ワークスペース',
	// allow-any-unicode-next-line
	worktree: 'ワークツリー',
	// allow-any-unicode-next-line
	project: 'プロジェクト',
	// allow-any-unicode-next-line
	tab: 'タブ',
	// allow-any-unicode-next-line
	pane: 'ペーン',
	// allow-any-unicode-next-line
	event: 'イベント',
});

export function renderParadisAivisTemplate(template: string, vars: IParadisAivisPlaceholders): string {
	return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
		const value = (vars as Record<string, string | undefined>)[key];
		return value ?? '';
	});
}

// allow-any-unicode-next-line
export const PARADIS_AIVIS_DEFAULT_FORMAT = 'ワークスペース、{{workspace}}、です';
// allow-any-unicode-next-line
export const PARADIS_AIVIS_DEFAULT_FORMAT_PERMISSION = '{{branch}}で対応が必要です';

export type ParadisAivisWordType = 'PROPER_NOUN' | 'COMMON_NOUN' | 'VERB' | 'ADJECTIVE' | 'SUFFIX';

export const PARADIS_AIVIS_WORD_TYPES: readonly { readonly value: ParadisAivisWordType; readonly label: string }[] = Object.freeze([
	// allow-any-unicode-next-line
	{ value: 'PROPER_NOUN', label: '固有名詞' },
	// allow-any-unicode-next-line
	{ value: 'COMMON_NOUN', label: '一般名詞' },
	// allow-any-unicode-next-line
	{ value: 'VERB', label: '動詞' },
	// allow-any-unicode-next-line
	{ value: 'ADJECTIVE', label: '形容詞' },
	// allow-any-unicode-next-line
	{ value: 'SUFFIX', label: '接尾辞' },
]);

export interface IParadisAivisDictionaryWord {
	readonly uuid: string;
	readonly surface: readonly string[];
	readonly pronunciation: readonly string[];
	readonly accent_type: readonly number[];
	readonly word_type: ParadisAivisWordType;
	readonly priority: number;
}

export interface IParadisAivisDictionaryListItem {
	readonly uuid: string;
	readonly name: string;
	readonly description: string;
	readonly word_count: number;
	readonly created_at: string;
	readonly updated_at: string;
}

export interface IParadisAivisDictionaryDetail {
	readonly name: string;
	readonly description: string;
	readonly word_properties: readonly IParadisAivisDictionaryWord[];
	readonly created_at: string;
	readonly updated_at: string;
}

export interface IParadisAivisModelSummary {
	readonly uuid: string;
	readonly name: string;
	readonly description: string;
	readonly iconUrl: string | null;
	readonly sampleUrl: string | null;
	readonly authorName: string | null;
	readonly authorHandle: string | null;
}

export interface IParadisAivisUsageDayEntry {
	readonly date: string;
	readonly requestCount: number;
	readonly characterCount: number;
	readonly creditConsumed: number;
	readonly byApiKey: Readonly<Record<string, { readonly name: string; readonly requestCount: number; readonly characterCount: number; readonly creditConsumed: number }>>;
}

export interface IParadisAivisUsageResult {
	readonly days: readonly IParadisAivisUsageDayEntry[];
	readonly total: { readonly requestCount: number; readonly characterCount: number; readonly creditConsumed: number };
}

export interface IParadisAivisMeResult {
	readonly handle: string | null;
	readonly name: string | null;
	readonly creditBalance: number | null;
}

/** ビルトインのAivisモデルプリセット（Superset apps/desktop の preset-data.ts より、UUID/名前/作者のみ移植）。 */
export interface IParadisAivisModelPreset {
	readonly uuid: string;
	readonly name: string;
	readonly authorName: string;
}

export const PARADIS_AIVIS_BUILTIN_PRESETS: readonly IParadisAivisModelPreset[] = Object.freeze([
	// allow-any-unicode-next-line
	{ uuid: 'e9339137-2ae3-4d41-9394-fb757a7e61e6', name: 'まい', authorName: '魔法プログラム' },
	// allow-any-unicode-next-line
	{ uuid: 'a670e6b8-0852-45b2-8704-1bc9862f2fe6', name: '花音', authorName: '魔法プログラム' },
	// allow-any-unicode-next-line
	{ uuid: '4f281e78-eba6-495a-8e50-5c322d02b5b1', name: 'るな', authorName: '魔法プログラム' },
	// allow-any-unicode-next-line
	{ uuid: '3328da9a-8124-4619-a853-f7fc2f37889f', name: '桜音', authorName: '魔法プログラム' },
	// allow-any-unicode-next-line
	{ uuid: '9107b8b6-1ed1-43f5-bebe-0de4df4d229d', name: '中2', authorName: '魔法プログラム' },
	// allow-any-unicode-next-line
	{ uuid: '7fc08a41-b64d-456d-8b22-8e1284674775', name: 'zonoko', authorName: 'ずごっく' },
	// allow-any-unicode-next-line
	{ uuid: '22e8ed77-94fe-4ef2-871f-a86f94e9a579', name: 'コハク', authorName: 'オズチャット -Oz Chat-' },
	// allow-any-unicode-next-line
	{ uuid: 'a59cb814-0083-4369-8542-f51a29e72af7', name: 'まお', authorName: 'オズチャット -Oz Chat-' },
	// allow-any-unicode-next-line
	{ uuid: '0f6821f4-9f86-4da1-a41a-fbe6fff9ca88', name: '天深シノ', authorName: '天深シノ・亜空マオ' },
]);

export interface IParadisPlayAivisRequest {
	readonly apiKey: string;
	readonly modelUuid: string;
	readonly text: string;
	readonly speakingRate?: number;
	readonly userDictionaryUuid?: string;
	readonly volume?: number;
}

/**
 * 通知1回分の音声要求。shared process 側の AudioScheduler が ringtone → (合成は並行) → Aivis再生
 * の順で調停する。複数ウィンドウからの呼び出しも単一スケジューラで直列化される。
 */
export interface IParadisNotifyAudioRequest {
	/** 通知音。ミュート時は undefined（＝鳴らさず Aivis のみ調停する）。 */
	readonly ringtone?: {
		readonly id: string;
		/** 0-100 */
		readonly volume: number;
	};
	/** Aivis 読み上げ。無効・未設定・空テキスト時は undefined。 */
	readonly aivis?: IParadisPlayAivisRequest;
	/** 'high' は要対応（PermissionRequest）。待機中の完了通知より前に割り込む。 */
	readonly priority: 'normal' | 'high';
}
