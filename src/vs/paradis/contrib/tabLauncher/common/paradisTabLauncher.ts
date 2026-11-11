/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タブの「＋」の横の ⌄ から開くランチャー（Q570、Orca の新しいタブのメニュー相当）の、画面を持たない部分。
// どのエージェントを並べるか、前回の選択の読み直し、検索欄の文字からの絞り込みを純関数で持つ。

import { IParadisAndroidDeviceSummary } from '../../simulator/common/paradisAndroid.js';
import { IParadisSimulatorDevice } from '../../simulator/common/paradisSimulator.js';
import { IParadisAgentCommandTemplate, IParadisAgentLaunchOptions } from '../../workspaceSwitch/common/paradisWorktreeCreate.js';

/**
 * ランチャーに出さないエージェント。モバイルの「エージェントを起動」シート
 * （app/mobile/src/features/launch/launchForm.ts の HIDDEN_AGENTS）と同じ規則にして、PC とモバイルで一覧を揃える（Q570）。
 * 例外として Antigravity CLI は PC のランチャーには出し、モバイルへは送らない（PARADIS_MOBILE_HIDDEN_AGENTS。
 * 状態の検知と会話の記録がそろうまで、モバイルの起動フォームに出さないため）。
 */
export const PARADIS_TAB_LAUNCHER_HIDDEN_AGENTS: ReadonlySet<string> = new Set(['gemini']);

/** ランチャーに並べるエージェント（設定の一覧から {@link PARADIS_TAB_LAUNCHER_HIDDEN_AGENTS} を除く。自分で足した定義は出す）。 */
export function paradisTabLauncherAgents(templates: readonly IParadisAgentCommandTemplate[]): readonly IParadisAgentCommandTemplate[] {
	return templates.filter(template => !PARADIS_TAB_LAUNCHER_HIDDEN_AGENTS.has(template.id));
}

/** 起動パネルで選んでいる値。undefined は「既定」（フラグを付けない）。 */
export interface IParadisTabLauncherChoice {
	readonly modelId?: string;
	readonly effortId?: string;
	readonly permissionId?: string;
}

/**
 * 保存しておいた前回の選択（`Record<agentId, IParadisAgentLaunchOptions>` の JSON）を読む。
 * 形の合わない値は捨てる（壊れた保存値で起動を止めない）。
 */
export function paradisParseStoredLaunchChoices(raw: string | undefined): Record<string, IParadisTabLauncherChoice> {
	if (!raw) {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return {};
	}
	const result: Record<string, IParadisTabLauncherChoice> = {};
	for (const [agentId, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			continue;
		}
		const record = value as Record<string, unknown>;
		const pick = (key: string) => typeof record[key] === 'string' && record[key] !== '' ? record[key] as string : undefined;
		result[agentId] = { modelId: pick('modelId'), effortId: pick('effortId'), permissionId: pick('permissionId') };
	}
	return result;
}

/** 前回の選択に、このエージェントの今回の選択を書き足した JSON。 */
export function paradisStoreLaunchChoice(raw: string | undefined, agentId: string, choice: IParadisTabLauncherChoice): string {
	const all: Record<string, IParadisAgentLaunchOptions> = paradisParseStoredLaunchChoices(raw);
	all[agentId] = { modelId: choice.modelId, effortId: choice.effortId, permissionId: choice.permissionId };
	return JSON.stringify(all);
}

/** そのモデルで選べるエフォート。 */
export interface IParadisTabLauncherEfforts {
	/** エフォートの欄を出すか（エージェントがエフォートの語彙を持たなければ出さない）。 */
	readonly shown: boolean;
	/** 選べるエフォート id。空ならこのモデルはエフォートに対応しない。 */
	readonly ids: readonly string[];
	/** 「既定」を選んだときに実際に使われるエフォート。 */
	readonly defaultEffort?: string;
}

/** 新しいスペースのダイアログと同じ規則で、モデルごとに選べるエフォートを返す。 */
export function paradisTabLauncherEfforts(template: IParadisAgentCommandTemplate, modelId: string | undefined): IParadisTabLauncherEfforts {
	const vocabulary = (template.efforts ?? []).map(effort => effort.id);
	if (vocabulary.length === 0) {
		return { shown: false, ids: [] };
	}
	const model = modelId !== undefined ? template.models?.find(candidate => candidate.id === modelId) : undefined;
	const allowed = model?.efforts;
	return {
		shown: true,
		ids: allowed === undefined ? vocabulary : vocabulary.filter(id => allowed.includes(id)),
		defaultEffort: model?.defaultEffort,
	};
}

/**
 * 今の定義で使えない値を外した選択。モデルが一覧から消えた・エフォートが今のモデルで選べない・
 * 権限が無い、のどれも「既定」に戻す。権限の既定は先頭の選択肢（新しいスペースのダイアログと同じ）。
 */
export function paradisNormalizeLaunchChoice(template: IParadisAgentCommandTemplate, choice: IParadisTabLauncherChoice | undefined): IParadisTabLauncherChoice {
	const modelId = choice?.modelId !== undefined && template.models?.some(model => model.id === choice.modelId) ? choice.modelId : undefined;
	const efforts = paradisTabLauncherEfforts(template, modelId);
	const effortId = choice?.effortId !== undefined && efforts.ids.includes(choice.effortId) ? choice.effortId : undefined;
	const permissions = template.permissions ?? [];
	const permissionId = choice?.permissionId !== undefined && permissions.some(permission => permission.id === choice.permissionId)
		? choice.permissionId
		: permissions[0]?.id;
	return { modelId, effortId, permissionId };
}

/**
 * 保存しておいた前回の選択から、ランチャーを開いたときの選択を作る。危ない権限（`danger`。全許可・全バイパス）は
 * 引き継がず、毎回危なくない既定（危なくない先頭の選択肢）に戻す。開いている間に選び直した値はこの関数を通らない。
 */
export function paradisRestoreLaunchChoice(template: IParadisAgentCommandTemplate, stored: IParadisTabLauncherChoice | undefined): IParadisTabLauncherChoice {
	const choice = paradisNormalizeLaunchChoice(template, stored);
	const permissions = template.permissions ?? [];
	if (!permissions.find(permission => permission.id === choice.permissionId)?.danger) {
		return choice;
	}
	return { ...choice, permissionId: (permissions.find(permission => !permission.danger) ?? permissions[0])?.id };
}

/**
 * エージェントを起動するフォルダ。スペースを使うウィンドウでは、今のスペースのルート（リポジトリ本体か worktree）を
 * スペースの一覧から引く（複数フォルダのワークスペースでも、先頭のフォルダにずれない）。スペースを使っていない
 * ウィンドウ（今のスペースが無い）か、一覧に見つからないときだけ、ワークスペースの先頭のフォルダを使う。
 */
export function paradisTabLauncherRoot<T>(activeStateKey: string | undefined, spaces: readonly { readonly space: string; readonly uri: T }[], firstFolder: T | undefined): T | undefined {
	const active = activeStateKey !== undefined ? spaces.find(entry => entry.space === activeStateKey) : undefined;
	return active?.uri ?? firstFolder;
}

/**
 * 検索欄の文字が URL（またはホスト名）なら、内蔵ブラウザで開く URL を返す。
 * `https://…` はそのまま、`localhost:3000` は http、`example.com/path` は https を補う。空白を含むものは URL と見なさない。
 */
export function paradisTabLauncherUrl(query: string): string | undefined {
	const text = query.trim();
	if (!text || /\s/.test(text)) {
		return undefined;
	}
	if (/^https?:\/\/\S+$/i.test(text)) {
		return text;
	}
	if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?(\/\S*)?$/i.test(text)) {
		return `http://${text}`;
	}
	const host = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(?<tld>[a-z]{2,})(?<rest>(:\d{1,5})?(\/\S*)?)$/i.exec(text);
	if (!host?.groups) {
		return undefined;
	}
	// 「README.md」「app.ts」のようなファイル名は URL にしない（ポートやパスが付いていればホスト名と見なす）
	if (host.groups.rest === '' && FILE_NAME_EXTENSIONS.has(host.groups.tld.toLowerCase())) {
		return undefined;
	}
	return `https://${text}`;
}

/** 末尾がこれならファイル名と見なす拡張子（同じ綴りのトップレベルドメインがあっても）。 */
const FILE_NAME_EXTENSIONS: ReadonlySet<string> = new Set([
	'md', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'txt', 'py', 'rb', 'rs', 'go', 'sh', 'zsh', 'css', 'scss', 'html', 'htm',
	'yml', 'yaml', 'toml', 'lock', 'log', 'csv', 'xml', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'pdf', 'docx', 'xlsx', 'swift', 'kt', 'java', 'cs', 'cpp', 'mm',
]);

/** 検索欄の文字に合ったエージェント（とモデル・エフォートの組み合わせ）。 */
export interface IParadisTabLauncherAgentMatch {
	readonly agentId: string;
	readonly modelId?: string;
	readonly effortId?: string;
}

/**
 * 検索欄の文字からエージェントを探す。語は空白で区切り、全部の語がどこかに当たったものを返す。
 * 「claude」はエージェント、「opus high」は Opus のモデルとエフォート high の組み合わせになる。
 * モデルの行は、語のどれかがモデルの名前に当たったときだけ出す（「claude」で全モデルを並べない）。
 */
export function paradisMatchLauncherAgents(templates: readonly IParadisAgentCommandTemplate[], query: string, limit = 6): readonly IParadisTabLauncherAgentMatch[] {
	const words = query.toLowerCase().split(/\s+/).filter(word => word.length > 0);
	if (words.length === 0) {
		return [];
	}
	const matches: IParadisTabLauncherAgentMatch[] = [];
	for (const template of templates) {
		const agentText = `${template.id} ${template.label}`.toLowerCase();
		if (words.every(word => agentText.includes(word))) {
			matches.push({ agentId: template.id });
		}
		for (const model of template.models ?? []) {
			const modelText = `${model.id} ${model.label ?? ''}`.toLowerCase();
			const efforts = paradisTabLauncherEfforts(template, model.id).ids;
			const effortId = efforts.find(effort => words.includes(effort));
			const rest = words.filter(word => word !== effortId);
			if (rest.length === 0 || !rest.some(word => modelText.includes(word))) {
				continue;
			}
			if (rest.every(word => modelText.includes(word) || agentText.includes(word))) {
				matches.push({ agentId: template.id, modelId: model.id, effortId });
			}
		}
	}
	return matches.slice(0, limit);
}

/** 「シミュレータを開く ›」のサブメニューに並べる 1 台。 */
export interface IParadisTabLauncherDevice {
	readonly kind: 'ios' | 'android';
	/** iOS は udid、Android は serial（そのまま「シミュレータを開く」のコマンドへ渡す）。 */
	readonly id: string;
	readonly name: string;
	readonly runtime: string;
}

/**
 * 「シミュレータを開く ›」に並べる端末。Xcode の端末は数十台あるのが普通なので、すぐ映せるもの
 * （起動している iOS のシミュレータと、動いている Android）だけにする。止まっている端末は「すべての端末…」の一覧から開く。
 * iOS のシミュレータは macOS だけ（`iosSupported` が false なら iOS を出さない。Android は全 OS）。
 */
export function paradisTabLauncherDevices(ios: readonly IParadisSimulatorDevice[], android: readonly IParadisAndroidDeviceSummary[], iosSupported: boolean): readonly IParadisTabLauncherDevice[] {
	return [
		...(iosSupported ? ios.filter(device => device.state === 'Booted').map(device => ({ kind: 'ios' as const, id: device.udid, name: device.name, runtime: device.runtime })) : []),
		...android.filter(device => device.state === 'device').map(device => ({ kind: 'android' as const, id: device.serial, name: device.name, runtime: device.runtime || 'Android' })),
	];
}

/** 「シミュレータを開く ›」の端末の一覧を覚えておく時間。 */
export const PARADIS_TAB_LAUNCHER_DEVICE_CACHE_MS = 30_000;

/**
 * 「シミュレータを開く ›」の端末の一覧の短いキャッシュ。一覧は › を開いたときに初めて取る（⌄ を開くたびに
 * `xcrun simctl` と `adb devices` を起こさない。adb は Android を使わない人の手元でもサーバーを起こすため）。
 * 取っている最中に開き直したときは、同じ取り出しを待つ。
 */
export class ParadisTabLauncherDeviceCache<T> {

	private _entry: { readonly at: number; readonly value: Promise<T> } | undefined;

	constructor(private readonly _ttlMs = PARADIS_TAB_LAUNCHER_DEVICE_CACHE_MS) { }

	get(load: () => Promise<T>, now: number): Promise<T> {
		if (!this._entry || now - this._entry.at >= this._ttlMs) {
			this._entry = { at: now, value: load() };
		}
		return this._entry.value;
	}
}
