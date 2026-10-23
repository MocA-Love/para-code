/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントが CDP で送る大きさの命令（chrome-devtools-mcp の emulate、lighthouse_audit など）を、
// upstream の Device Emulation の状態（`IBrowserViewModel.device`）へ畳み込むための純粋な部分。
//
// fork の CDP の中継（paradisCdpFilterProxy.ts）は Electron の remote-debugging の WebSocket へ直接つなぐ
// ので、upstream が BrowserViewDebugger で横取りして device へ畳み込む経路（browserViewEmulator.ts の
// `_intercept`）を通らない。そのまま Chromium へ流すと、device は空のまま枠は元の幅で、ページだけが左上に
// 小さく描かれ、空いた所から upstream の静止画が透けて二重に見える。upstream もそのまま流すと Electron が
// 落ちることがあるとして止めている。そこで中継が命令を拾い、main で device を変える（中継は Chromium へ流さない）。
//
// 戻し方（ユーザーの決定「LLM が変えた大きさは chip に出し、確認は出さない」に合わせる）:
//  - CDP の命令で付けた大きさは、その接続の持ち物。clear の命令か、接続が切れた（共有を解いた・CLI を
//    止めた）ときに、付ける前の大きさへ戻す
//  - ただし、その間に利用者（chip・帯）やエージェントの set_viewport が大きさを変えていたら戻さない
//    （今の大きさが、命令で付けたものと違えば触らない）

import { IBrowserDeviceProfile } from '../../../../platform/browserView/common/browserView.js';

/** 中継が拾って main へ渡す CDP の命令。 */
export const PARADIS_CDP_VIEWPORT_METHODS: ReadonlySet<string> = new Set([
	'Emulation.setDeviceMetricsOverride',
	'Emulation.clearDeviceMetricsOverride',
	// 古い命令。表示の大きさを変えるだけで device には載らないので、受けて何もしない（流すと枠とずれる）
	'Emulation.setVisibleSize',
]);

export function paradisIsCdpViewportMethod(method: string): boolean {
	return PARADIS_CDP_VIEWPORT_METHODS.has(method);
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * `Emulation.setDeviceMetricsOverride` の引数を、今の device に重ねる（upstream の `_intercept` と同じ形）。
 * UA は残す。`deviceScaleFactor` は 1 以下なら「その画面の値」にする: Puppeteer は指定が無くても 1 を
 * 送るので、そのまま使うと Retina の画面ではページが小さくぼやける。
 */
export function paradisFoldDeviceMetricsOverride(current: IBrowserDeviceProfile | undefined, params: unknown): IBrowserDeviceProfile {
	const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
	const width = positiveNumber(p.width);
	const height = positiveNumber(p.height);
	const scale = positiveNumber(p.deviceScaleFactor);
	const mobile = typeof p.mobile === 'boolean' ? p.mobile : current?.mobile;
	return {
		...(current?.userAgent ? { userAgent: current.userAgent } : {}),
		...(width !== undefined ? { width: Math.round(width) } : {}),
		...(height !== undefined ? { height: Math.round(height) } : {}),
		...(mobile ? { mobile: true } : {}),
		...(scale !== undefined && scale > 1 ? { deviceScaleFactor: scale } : {}),
	};
}

export function paradisDevicesEqual(a: IBrowserDeviceProfile | undefined, b: IBrowserDeviceProfile | undefined): boolean {
	if (a === undefined || b === undefined) {
		return a === b;
	}
	return a.width === b.width
		&& a.height === b.height
		&& !!a.mobile === !!b.mobile
		&& a.deviceScaleFactor === b.deviceScaleFactor
		&& a.userAgent === b.userAgent;
}

interface IAgentEmulationRecord {
	readonly owner: string;
	/** 命令で付ける前の device。 */
	readonly previous: IBrowserDeviceProfile | undefined;
	/** 最後に命令で付けた device。 */
	readonly applied: IBrowserDeviceProfile;
}

/** 戻すときの答え。 */
export type ParadisEmulationRelease =
	/** 何もしない（記録が無い・別の接続のもの・その後に大きさが変わった）。 */
	| { readonly kind: 'keep' }
	/** この device へ戻す。 */
	| { readonly kind: 'restore'; readonly device: IBrowserDeviceProfile | undefined };

/**
 * CDP の命令で付けた大きさの台帳（ビューごとに 1 件）。main が持つ。
 */
export class ParadisAgentEmulationLedger {

	private readonly _records = new Map<string, IAgentEmulationRecord>();

	/**
	 * 命令で device を付ける前に呼ぶ。付ける device を返す。別の接続の記録や、その後に大きさが変わった
	 * 記録は捨てて、今の device を「付ける前」として持ち直す。
	 */
	apply(viewId: string, owner: string, current: IBrowserDeviceProfile | undefined, params: unknown): IBrowserDeviceProfile {
		const next = paradisFoldDeviceMetricsOverride(current, params);
		const record = this._records.get(viewId);
		const previous = record && record.owner === owner && paradisDevicesEqual(record.applied, current) ? record.previous : current;
		this._records.set(viewId, { owner, previous, applied: next });
		return next;
	}

	/** clear の命令・接続が切れたとき。`owner` を省くと、持ち主を問わない（ビューが消えたときの片付け）。 */
	release(viewId: string, owner: string | undefined, current: IBrowserDeviceProfile | undefined): ParadisEmulationRelease {
		const record = this._records.get(viewId);
		if (!record || (owner !== undefined && record.owner !== owner)) {
			return { kind: 'keep' };
		}
		this._records.delete(viewId);
		return paradisDevicesEqual(record.applied, current) ? { kind: 'restore', device: record.previous } : { kind: 'keep' };
	}

	/** その持ち主が記録を持つビュー。 */
	viewsOwnedBy(owner: string): string[] {
		const views: string[] = [];
		for (const [viewId, record] of this._records) {
			if (record.owner === owner) {
				views.push(viewId);
			}
		}
		return views;
	}

	get size(): number {
		return this._records.size;
	}
}
