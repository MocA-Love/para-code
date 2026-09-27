/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Design Mode の注釈トレイ（ページごと）と、main プロセスの窓口をまとめたサービス。
//
// 注釈はブラウザのページ（IBrowserViewModel の id）ごとに持つ。エディタのタブを切り替えても、
// 同じページへ戻れば溜めた注釈がそのまま残る。ページが閉じられたら捨てる。
// 保存先はメモリだけ（再起動をまたいで残さない）。画像は送るときまでディスクへ書かない。

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IParadisDesignModeMainService, IParadisDesignPin, PARADIS_DESIGN_BUDGET, PARADIS_DESIGN_MODE_CHANNEL, ParadisDesignPickResult } from '../common/paradisDesignMode.js';
import { IParadisDesignAnnotation } from '../common/paradisDesignModeFormat.js';

export const IParadisDesignModeService = createDecorator<IParadisDesignModeService>('paradisDesignModeService');

export interface IParadisDesignModeService {
	readonly _serviceBrand: undefined;
	/** 注釈が変わったページの id。 */
	readonly onDidChangeAnnotations: Event<string>;
	/** 画像を添えるかの切り替えが変わった。 */
	readonly onDidChangeAttachImages: Event<void>;
	/** 送るときに画像を添えるか（トレイのチェック。ウィンドウ内で共通、既定オン）。 */
	attachImages: boolean;

	getAnnotations(pageId: string): readonly IParadisDesignAnnotation[];
	/** 追加できたら true（1ページの上限を超えると false）。ページが閉じられたら注釈も捨てる。 */
	addAnnotation(page: IBrowserViewModel, annotation: IParadisDesignAnnotation): boolean;
	removeAnnotation(pageId: string, annotationId: string): void;
	clearAnnotations(pageId: string): void;

	pickElement(pageId: string): Promise<ParadisDesignPickResult>;
	cancelPick(pageId: string): Promise<void>;
	setPins(pageId: string, pins: readonly IParadisDesignPin[]): Promise<void>;
	/** PNG を userData 配下へ保存し、その絶対パスを返す。 */
	saveImage(png: Uint8Array): Promise<string>;
}

export class ParadisDesignModeService extends Disposable implements IParadisDesignModeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeAnnotations = this._register(new Emitter<string>());
	readonly onDidChangeAnnotations = this._onDidChangeAnnotations.event;
	private readonly _onDidChangeAttachImages = this._register(new Emitter<void>());
	readonly onDidChangeAttachImages = this._onDidChangeAttachImages.event;

	private readonly _annotations = new Map<string, IParadisDesignAnnotation[]>();
	/** 注釈を持っているページの「閉じられたら捨てる」購読。 */
	private readonly _pageListeners = this._register(new DisposableMap<string>());
	private readonly _main: IParadisDesignModeMainService;
	private _attachImages = true;

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		super();
		this._main = ProxyChannel.toService<IParadisDesignModeMainService>(mainProcessService.getChannel(PARADIS_DESIGN_MODE_CHANNEL));
	}

	get attachImages(): boolean {
		return this._attachImages;
	}

	set attachImages(value: boolean) {
		if (this._attachImages !== value) {
			this._attachImages = value;
			this._onDidChangeAttachImages.fire();
		}
	}

	getAnnotations(pageId: string): readonly IParadisDesignAnnotation[] {
		return this._annotations.get(pageId) ?? [];
	}

	addAnnotation(page: IBrowserViewModel, annotation: IParadisDesignAnnotation): boolean {
		const pageId = page.id;
		const list = this._annotations.get(pageId) ?? [];
		if (list.length >= PARADIS_DESIGN_BUDGET.annotationsMaxPerPage) {
			return false;
		}
		this._annotations.set(pageId, [...list, annotation]);
		if (!this._pageListeners.has(pageId)) {
			this._pageListeners.set(pageId, page.onWillDispose(() => this.clearAnnotations(pageId)));
		}
		this._onDidChangeAnnotations.fire(pageId);
		return true;
	}

	removeAnnotation(pageId: string, annotationId: string): void {
		const list = this._annotations.get(pageId);
		if (!list) {
			return;
		}
		const next = list.filter(annotation => annotation.id !== annotationId);
		if (next.length === list.length) {
			return;
		}
		if (next.length === 0) {
			this._annotations.delete(pageId);
			this._pageListeners.deleteAndDispose(pageId);
		} else {
			this._annotations.set(pageId, next);
		}
		this._onDidChangeAnnotations.fire(pageId);
	}

	clearAnnotations(pageId: string): void {
		this._pageListeners.deleteAndDispose(pageId);
		if (this._annotations.delete(pageId)) {
			this._onDidChangeAnnotations.fire(pageId);
		}
	}

	pickElement(pageId: string): Promise<ParadisDesignPickResult> {
		return this._main.pickElement(pageId);
	}

	cancelPick(pageId: string): Promise<void> {
		return this._main.cancelPick(pageId);
	}

	setPins(pageId: string, pins: readonly IParadisDesignPin[]): Promise<void> {
		return this._main.setPins(pageId, pins);
	}

	saveImage(png: Uint8Array): Promise<string> {
		return this._main.saveImage(VSBuffer.wrap(png));
	}
}

registerSingleton(IParadisDesignModeService, ParadisDesignModeService, InstantiationType.Delayed);
