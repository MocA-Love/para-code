/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Design Mode の main プロセス側の窓口（Q62 A: app.ts に登録を2行足す方式）。
//
// renderer からは内蔵ブラウザのページ（WebContentsView）に直接触れないので、ページへ仕掛けを
// 入れる処理と、画像をディスクへ書く処理をここに置く。できることは固定の仕掛けを流すことと
// PNG を決まった場所へ書くことだけで、任意のスクリプトや任意のパスは受け付けない。

import { promises as fs } from 'fs';
import { join } from '../../../../base/common/path.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IServerChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import {
	IParadisDesignModeMainService,
	IParadisDesignPin,
	PARADIS_DESIGN_BUDGET,
	PARADIS_DESIGN_MODE_CHANNEL,
	PARADIS_DESIGN_MODE_WORLD_ID,
	ParadisDesignPickResult,
	paradisClampPickedElement,
	paradisIsPng,
} from '../common/paradisDesignMode.js';
import { paradisBuildCancelPickScript, paradisBuildPickScript, paradisBuildSetPinsScript } from '../common/paradisDesignModePageScript.js';

/** 仕掛けを流す先（BrowserView の webContents の最小構造。テストから偽物を渡せるように）。 */
export interface IParadisDesignModeTarget {
	readonly webContents: {
		isDestroyed(): boolean;
		executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[], userGesture?: boolean): Promise<unknown>;
	};
}

/** ビュー ID から対象を引く（本番は IBrowserViewMainService.tryGetBrowserView）。 */
export type ParadisDesignModeTargetResolver = (viewId: string) => IParadisDesignModeTarget | undefined;

/** 保存した画像を置いておく時間。エージェントが読む前に消さない程度に長く取る。 */
const IMAGE_TTL_MS = 24 * 60 * 60 * 1000;
/** 画像の名前（ここで作った名前以外は掃除の対象にしない）。 */
const IMAGE_NAME_PATTERN = /^design-(?<time>\d+)-[0-9a-f-]{36}\.png$/;

export class ParadisDesignModeMainService implements IParadisDesignModeMainService {

	constructor(
		private readonly resolveTarget: ParadisDesignModeTargetResolver,
		/** 画像を置くディレクトリ（userData 配下）。 */
		private readonly imageDirectory: string,
		private readonly now: () => number = Date.now,
	) { }

	async pickElement(viewId: string): Promise<ParadisDesignPickResult> {
		const target = this.resolveLive(viewId);
		if (!target) {
			return { kind: 'cancelled' };
		}
		let raw: unknown;
		try {
			raw = await target.webContents.executeJavaScriptInIsolatedWorld(PARADIS_DESIGN_MODE_WORLD_ID, [{ code: paradisBuildPickScript() }], true);
		} catch {
			// ページの遷移・再読み込み・クラッシュで isolated world ごと消えると reject される。
			// 選択は続けられないので、取り消しとして扱う
			return { kind: 'cancelled' };
		}
		if (!raw || typeof raw !== 'object') {
			return { kind: 'cancelled' };
		}
		const element = paradisClampPickedElement((raw as { readonly element?: unknown }).element);
		return element ? { kind: 'picked', element } : { kind: 'cancelled' };
	}

	async cancelPick(viewId: string): Promise<void> {
		const target = this.resolveLive(viewId);
		if (!target) {
			return;
		}
		try {
			await target.webContents.executeJavaScriptInIsolatedWorld(PARADIS_DESIGN_MODE_WORLD_ID, [{ code: paradisBuildCancelPickScript() }]);
		} catch {
			// 遷移中などで流せなくても、仕掛けは遷移と一緒に消えている
		}
	}

	async setPins(viewId: string, pins: readonly IParadisDesignPin[]): Promise<void> {
		const target = this.resolveLive(viewId);
		if (!target || !Array.isArray(pins)) {
			return;
		}
		try {
			await target.webContents.executeJavaScriptInIsolatedWorld(PARADIS_DESIGN_MODE_WORLD_ID, [{ code: paradisBuildSetPinsScript(pins.slice(0, PARADIS_DESIGN_BUDGET.annotationsMaxPerPage * 2)) }]);
		} catch {
			// 札は飾りなので、置けなくても何もしない
		}
	}

	async saveImage(png: VSBuffer): Promise<string> {
		const bytes = png?.buffer;
		if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > PARADIS_DESIGN_BUDGET.imageMaxBytes || !paradisIsPng(bytes)) {
			throw new Error('Not a PNG image within the size limit.');
		}
		// 所有者だけが読み書きできる場所にする。すでにあるディレクトリの権限も絞り直す
		// （以前の版や手作業で緩く作られていても、ここで書く画像を他のユーザーから隠す）
		await fs.mkdir(this.imageDirectory, { recursive: true, mode: 0o700 });
		await fs.chmod(this.imageDirectory, 0o700).catch(() => undefined);
		const time = this.now();
		const file = join(this.imageDirectory, `design-${time}-${generateUuid()}.png`);
		// wx: 同名のファイル（や symlink）があれば書かずに失敗させる
		await fs.writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
		void this.cleanup(time);
		return file;
	}

	private async cleanup(now: number): Promise<void> {
		let names: string[];
		try {
			names = await fs.readdir(this.imageDirectory);
		} catch {
			return;
		}
		for (const name of names) {
			const match = IMAGE_NAME_PATTERN.exec(name);
			const time = Number(match?.groups?.time);
			if (match && Number.isFinite(time) && now - time > IMAGE_TTL_MS) {
				await fs.unlink(join(this.imageDirectory, name)).catch(() => undefined);
			}
		}
	}

	private resolveLive(viewId: string): IParadisDesignModeTarget | undefined {
		if (typeof viewId !== 'string' || viewId.length === 0) {
			return undefined;
		}
		const target = this.resolveTarget(viewId);
		return target && !target.webContents.isDestroyed() ? target : undefined;
	}
}

/** 画像を置くディレクトリ（userData 配下）。 */
export function paradisDesignModeImageDirectory(userDataPath: string): string {
	return join(userDataPath, 'paradis-design-mode', 'images');
}

/** app.ts の PARA-PATCH 点から呼ばれる登録関数。 */
export function paradisRegisterDesignMode(
	channelHost: { registerChannel(channelName: string, channel: IServerChannel<string>): void },
	browserViews: { tryGetBrowserView(id: string): IParadisDesignModeTarget | undefined },
	userDataPath: string,
): IDisposable {
	const disposables = new DisposableStore();
	const service = new ParadisDesignModeMainService(viewId => browserViews.tryGetBrowserView(viewId), paradisDesignModeImageDirectory(userDataPath));
	channelHost.registerChannel(PARADIS_DESIGN_MODE_CHANNEL, ProxyChannel.fromService(service, disposables));
	return disposables;
}
