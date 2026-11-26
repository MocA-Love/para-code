/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 1 つのターミナルペインに割り当てた端末の帳面（10 台まで）と、mobile_* の道具が「どの端末を操作するか」を決める決まり。
// 台帳（shared process の ParadisMobileCanvasService）とテストの偽の台帳が、同じこの帳面を使う。
//
// 決まり:
//  - 1 ペインに {@link PARADIS_MOBILE_MAX_DEVICES_PER_PANE} 台まで。足すのは利用者の操作（共有ダイアログ・承認）だけ
//  - 道具の `device`（id か名前）は、**そのペインに割り当てた端末の中だけ**で引く。ほかのペインの端末の id を渡しても
//    「割り当てられていない」で断る（端末の一覧からは引かない）
//  - `device` を省いた道具は、そのペインの「今の端末」に当たる。今の端末は **最後に割り当てた端末**。`device` を付けた
//    呼び出しでは動かさない（同じペインで並んで動くサブエージェントが、互いの既定を黙って動かさないように）。
//    今の端末を外したら、残りのうち最後に割り当てたものが今の端末になる
//  - 起動前の AVD で割り当てた Android は、起動すると一覧の id が替わる。同じ端末として引く（paradisFindMobileDevice）
//  - 道具の返事には、操作した端末の名前と id を必ず入れる（{@link paradisStampMobileDevice}）

import { IParadisMobileAttachment, IParadisMobileDevice, paradisFindMobileDevice } from './paradisMobileCanvas.js';
import { paradisDeviceHeldByAnotherPane } from './paradisMobileDeviceOps.js';

/** 1 つのペインに割り当てられる端末の数の上限。 */
export const PARADIS_MOBILE_MAX_DEVICES_PER_PANE = 10;

export const PARADIS_MOBILE_NO_DEVICE_MESSAGE = 'No mobile device is attached to this terminal pane. Call mobile_request_device to ask the user for one (or ask them to attach it from the "Mobile Devices" tab of the sharing dialog), then try again.';

/** 道具が操作する端末。 */
export interface IParadisMobileTarget {
	readonly attachment: IParadisMobileAttachment;
	/** `device` を省いたので、ペインの今の端末に当てた。 */
	readonly byDefault: boolean;
	/** そのペインに割り当てている端末の数。 */
	readonly attachedCount: number;
}

/** 割り当てを断った理由。 */
export type ParadisMobileAttachRefusal = 'heldByAnotherPane' | 'full' | 'releaseNotAttached';

/** 割り当ての結果。断ったときだけ `refused` が入る（`refused === undefined` なら割り当てた・既に持っていた）。 */
export type ParadisMobileAttachResult =
	| { readonly refused?: undefined; readonly attachment: IParadisMobileAttachment; /** 新しく足したか（既に持っていれば false）。 */ readonly added: boolean; readonly released?: IParadisMobileAttachment }
	| { readonly refused: ParadisMobileAttachRefusal };

export interface IParadisMobileAttachOptions {
	/** ほかのペインが使っている端末は断る（エージェントの要求）。利用者が共有ダイアログから渡すときは付けない。 */
	readonly onlyIfFree?: boolean;
	/** 足す前に外す端末（台帳の id）。上限のときに利用者が選んだもの。 */
	readonly releaseDeviceId?: string;
}

interface IBookEntry {
	readonly attachment: IParadisMobileAttachment;
	/** 道具がこの端末を最後に使った時刻（24 時間使われなければ掃除する）。 */
	lastActiveAt: number;
}

/**
 * 端末の id・番号（UDID・シリアル）の形をした文字列。`ios:…`・`android:…`、UUID、`emulator-5554`、`host:port`。
 * この形のものは、名前としてより先に id として引く。
 */
const LOOKS_LIKE_DEVICE_ID = /^(?:(?:ios|android):.+|[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}|emulator-\d+|[^\s:]+:\d+)$/;

/** 道具の `device` に渡された文字列を、エラー文に出せる長さにする。 */
function quoted(value: string): string {
	return value.length > 120 ? `${value.slice(0, 120)}…` : value;
}

export function paradisDescribeAttachedDevices(attachments: readonly IParadisMobileAttachment[]): string {
	return attachments.map(attachment => `${attachment.deviceName} (${attachment.deviceId})`).join(', ');
}

export class ParadisMobileAttachmentBook {

	/** ペインのトークン → 割り当て（割り当てた順。最後が今の端末）。 */
	private readonly _panes = new Map<string, IBookEntry[]>();

	/** 全部の割り当て。各ペインの今の端末に `current` を付ける。 */
	list(): IParadisMobileAttachment[] {
		const all: IParadisMobileAttachment[] = [];
		for (const entries of this._panes.values()) {
			entries.forEach((entry, index) => all.push(index === entries.length - 1 ? { ...entry.attachment, current: true } : entry.attachment));
		}
		return all;
	}

	/** そのペインの割り当て（割り当てた順。最後が今の端末）。 */
	listPane(paneToken: string): IParadisMobileAttachment[] {
		return (this._panes.get(paneToken) ?? []).map(entry => entry.attachment);
	}

	/** そのペインが、その端末を持っているか（起動して id が替わった Android・同じ番号の端末も同じとみなす）。 */
	findInPane(paneToken: string, device: IParadisMobileDevice, devices: readonly IParadisMobileDevice[]): IParadisMobileAttachment | undefined {
		return (this._panes.get(paneToken) ?? []).find(entry => sameDevice(entry.attachment.deviceId, device, devices))?.attachment;
	}

	/**
	 * 端末を足す。確かめてから書き込むまでは同期（呼ぶ側は、端末の一覧を取り終えてから呼ぶ。別の窓の 2 つのペインが
	 * 同じ端末をほぼ同時に承認されても、二重に割り当てないように）。
	 */
	attach(paneToken: string, device: IParadisMobileDevice, devices: readonly IParadisMobileDevice[], stateKey: string | undefined, now: number, options: IParadisMobileAttachOptions = {}): ParadisMobileAttachResult {
		const entries = this._panes.get(paneToken) ?? [];
		const existing = entries.find(entry => sameDevice(entry.attachment.deviceId, device, devices));
		if (existing) {
			return { attachment: existing.attachment, added: false };
		}
		if (options.onlyIfFree && paradisDeviceHeldByAnotherPane(paneToken, device, devices, this.list())) {
			return { refused: 'heldByAnotherPane' };
		}
		let remaining = entries;
		let released: IParadisMobileAttachment | undefined;
		if (options.releaseDeviceId !== undefined) {
			released = entries.find(entry => entry.attachment.deviceId === options.releaseDeviceId)?.attachment;
			if (!released) {
				return { refused: 'releaseNotAttached' };
			}
			remaining = entries.filter(entry => entry.attachment !== released);
		}
		if (remaining.length >= PARADIS_MOBILE_MAX_DEVICES_PER_PANE) {
			return { refused: 'full' };
		}
		const attachment: IParadisMobileAttachment = { paneToken, deviceId: device.id, deviceName: device.name, stateKey, attachedAt: now };
		this._panes.set(paneToken, [...remaining, { attachment, lastActiveAt: now }]);
		return { attachment, added: true, ...(released ? { released } : {}) };
	}

	/** 割り当てを外す。`deviceId`（台帳の id）を省くと、そのペインの全部（ターミナルを閉じたとき）。外したものを返す。 */
	detach(paneToken: string, deviceId?: string): IParadisMobileAttachment[] {
		const entries = this._panes.get(paneToken) ?? [];
		const removed = entries.filter(entry => deviceId === undefined || entry.attachment.deviceId === deviceId);
		if (removed.length === 0) {
			return [];
		}
		const remaining = entries.filter(entry => !removed.includes(entry));
		if (remaining.length) {
			this._panes.set(paneToken, remaining);
		} else {
			this._panes.delete(paneToken);
		}
		return removed.map(entry => entry.attachment);
	}

	/** 道具の利用として、そのペインの全部の端末の最終利用時刻を進める（端末を選ばない mobile_list_devices）。 */
	touchPane(paneToken: string, now: number): void {
		for (const entry of this._panes.get(paneToken) ?? []) {
			entry.lastActiveAt = now;
		}
	}

	/** `cutoff` より前から使われていない割り当てを落とす（端末ごと）。落としたものを返す。 */
	sweep(cutoff: number): { readonly attachment: IParadisMobileAttachment; readonly lastActiveAt: number }[] {
		const dropped: { attachment: IParadisMobileAttachment; lastActiveAt: number }[] = [];
		for (const [paneToken, entries] of [...this._panes]) {
			const kept = entries.filter(entry => entry.lastActiveAt >= cutoff);
			if (kept.length === entries.length) {
				continue;
			}
			dropped.push(...entries.filter(entry => entry.lastActiveAt < cutoff).map(entry => ({ attachment: entry.attachment, lastActiveAt: entry.lastActiveAt })));
			if (kept.length) {
				this._panes.set(paneToken, kept);
			} else {
				this._panes.delete(paneToken);
			}
		}
		return dropped;
	}

	/**
	 * 道具が操作する端末を決める。`device`（道具の引数。id か名前）は、そのペインの割り当ての中だけで引く。
	 * 省いたら今の端末（最後に割り当てたもの）。決まらなければ、エージェントに返す文で throw する。
	 * 道具の利用として、その端末の最終利用時刻を進める。
	 */
	async resolve(paneToken: string, device: unknown, listDevices: () => Promise<readonly IParadisMobileDevice[]>, now: number): Promise<IParadisMobileTarget> {
		if (device !== undefined && device !== null && typeof device !== 'string') {
			throw new Error('"device" must be the id or the exact name of a device attached to this terminal pane.');
		}
		const wanted = typeof device === 'string' ? device.trim() : '';
		const entries = this._panes.get(paneToken) ?? [];
		if (entries.length === 0) {
			throw new Error(PARADIS_MOBILE_NO_DEVICE_MESSAGE);
		}
		let found: IBookEntry | undefined;
		if (!wanted) {
			found = entries[entries.length - 1];
		} else {
			// id は名前より先に照合する。端末の名前はエージェントも付けられる（simctl rename）ので、ほかの端末の id と同じ名前の
			// 端末があっても、id を渡した呼び出しがその端末へ行かないようにする。id の形の文字列は、台帳の名前で決めずに
			// 一覧の今の id まで見る（ふつうの名前のときは、端末の一覧を取りに行かずに決める）
			found = entries.find(entry => entry.attachment.deviceId === wanted);
			if (!found && !LOOKS_LIKE_DEVICE_ID.test(wanted)) {
				found = onlyOne(entries.filter(entry => entry.attachment.deviceName === wanted), wanted);
			}
			if (!found) {
				// 一覧の今の id・番号（UDID / シリアル）・名前でも引く（起動して id が替わった Android、名前を変えた端末）
				// 一覧を読めないときは、名前では決めない（id の形の文字列を、同じ名前を付けた別の端末へ当てないため）
				const devices = await listDevices().catch(() => undefined);
				if (!devices) {
					throw new Error(`Para Code could not read the device list, so it cannot tell which device "${quoted(wanted)}" is. Pass the id of an attached device exactly as mobile_list_devices shows it (attachedDevices): ${paradisDescribeAttachedDevices((this._panes.get(paneToken) ?? []).map(entry => entry.attachment))}.`);
				}
				const live = (this._panes.get(paneToken) ?? []).map(entry => ({ entry, device: paradisFindMobileDevice(devices, entry.attachment.deviceId) }));
				const byId = live.filter(candidate => candidate.device !== undefined && (candidate.device.id === wanted || candidate.device.udid === wanted || candidate.device.avdId === wanted));
				found = onlyOne((byId.length ? byId : live.filter(candidate => candidate.entry.attachment.deviceName === wanted || candidate.device?.name === wanted)).map(candidate => candidate.entry), wanted);
			}
		}
		// 一覧を待つ間に外されていたら使わない
		const current = this._panes.get(paneToken) ?? [];
		if (!found || !current.includes(found)) {
			if (current.length === 0) {
				throw new Error(PARADIS_MOBILE_NO_DEVICE_MESSAGE);
			}
			throw new Error(`"${quoted(wanted)}" is not attached to this terminal pane. Attached: ${paradisDescribeAttachedDevices(current.map(entry => entry.attachment))}. Pass one of these as "device" (id or exact name), or call mobile_request_device to ask the user for another device.`);
		}
		found.lastActiveAt = now;
		return { attachment: found.attachment, byDefault: !wanted, attachedCount: current.length };
	}
}

function onlyOne(entries: readonly IBookEntry[], wanted: string): IBookEntry | undefined {
	if (entries.length > 1) {
		throw new Error(`More than one device attached to this terminal pane is named "${quoted(wanted)}". Pass its id instead: ${paradisDescribeAttachedDevices(entries.map(entry => entry.attachment))}.`);
	}
	return entries[0];
}

/** 割り当ての id が、一覧のその端末を指すか（id、起動して替わった id、同じ番号）。 */
function sameDevice(attachedDeviceId: string, device: IParadisMobileDevice, devices: readonly IParadisMobileDevice[]): boolean {
	if (attachedDeviceId === device.id) {
		return true;
	}
	const held = paradisFindMobileDevice(devices, attachedDeviceId);
	return held === device || (!!device.udid && held?.udid === device.udid);
}

// --- 道具の引数と返事 ---

/** mobile_* の道具に足す、任意の引数 `device`。定義はここ 1 か所（MCP と para CLI は同じ定義を読む）。 */
export const PARADIS_MOBILE_DEVICE_ARGUMENT = {
	type: 'string',
	description: 'Which device attached to this terminal pane to use: its id or its exact name (see attachedDevices in mobile_list_devices). Omit it to use the pane\'s current device, which is the one attached last. Pass it whenever more than one device is attached.',
} as const;

/** 道具の定義に、任意の引数 `device` を足す。 */
export function paradisWithMobileDeviceArgument<T extends { readonly inputSchema: object }>(tool: T): T {
	const schema = tool.inputSchema as { readonly properties?: object };
	return { ...tool, inputSchema: { ...schema, properties: { ...schema.properties, device: PARADIS_MOBILE_DEVICE_ARGUMENT } } };
}

type ParadisMobileToolContent = { readonly type: 'text'; readonly text: string } | { readonly type: 'image'; readonly data: string; readonly mimeType: string };

/** mobile_* の道具の返事（MCP の形）。 */
export interface IParadisMobileToolResult {
	content: ParadisMobileToolContent[];
	isError?: boolean;
	structuredContent?: unknown;
}

/** 返事に入れる、操作した端末。`device` を省いて複数台あるときは、どれに当てたかの知らせも付ける。 */
export function paradisMobileTargetLabel(target: IParadisMobileTarget): { readonly id: string; readonly name: string; readonly note?: string } {
	const { deviceId, deviceName } = target.attachment;
	return {
		id: deviceId,
		name: deviceName,
		...(target.byDefault && target.attachedCount > 1
			? { note: `"device" was omitted, so this used the pane's current device (the one attached last). ${target.attachedCount} devices are attached to this pane: pass "device" to choose.` }
			: {}),
	};
}

/**
 * 返事に、操作した端末の名前と id を入れる（端末の取り違えに、エージェントがその場で気付けるように）。
 * JSON の返事は `device` を足し（文字と structuredContent の両方。JSON として読める形を保つ）、文の返事と
 * エラーは最後に `Device: 名前 (id).` の行を足す。失敗した返事にも入れる。
 */
export function paradisStampMobileDevice<T extends IParadisMobileToolResult>(result: T, target: IParadisMobileTarget): T {
	const label = paradisMobileTargetLabel(target);
	const structured = result.structuredContent;
	const isRecord = !!structured && typeof structured === 'object' && !Array.isArray(structured);
	const stamped = isRecord ? { ...structured as Record<string, unknown>, device: label } : structured;
	const firstText = result.content.findIndex(block => block.type === 'text');
	const first = firstText >= 0 ? result.content[firstText] as { readonly type: 'text'; readonly text: string } : undefined;
	const line = `Device: ${label.name} (${label.id}).${label.note ? ` ${label.note}` : ''}`;
	let content: ParadisMobileToolContent[];
	if (isRecord && first && first.text === JSON.stringify(structured, undefined, 2)) {
		// JSON の返事: 文字の側も同じ中身で組み直す
		content = result.content.map((block, index) => index === firstText ? { type: 'text', text: JSON.stringify(stamped, undefined, 2) } : block);
	} else if (first) {
		content = result.content.map((block, index) => index === firstText ? { type: 'text', text: `${first.text}\n${line}` } : block);
	} else {
		content = [{ type: 'text', text: line }, ...result.content];
	}
	return { ...result, content, ...(structured !== undefined ? { structuredContent: stamped } : {}) };
}
