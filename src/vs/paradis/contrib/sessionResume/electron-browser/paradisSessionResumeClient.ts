/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IParadisResumeListRequest, IParadisResumePreview, IParadisResumeSession, PARADIS_SESSION_RESUME_CHANNEL } from '../common/paradisSessionResume.js';

export class ParadisSessionResumeClient {
	constructor(@ISharedProcessService private readonly sharedProcessService: ISharedProcessService) { }

	list(request: IParadisResumeListRequest): Promise<readonly IParadisResumeSession[]> {
		return this.sharedProcessService.getChannel(PARADIS_SESSION_RESUME_CHANNEL).call('list', [request]);
	}

	preview(catalogId: string): Promise<IParadisResumePreview> {
		return this.sharedProcessService.getChannel(PARADIS_SESSION_RESUME_CHANNEL).call('preview', [catalogId]);
	}

	search(query: string, catalogIds: readonly string[]): Promise<readonly string[]> {
		return this.sharedProcessService.getChannel(PARADIS_SESSION_RESUME_CHANNEL).call('search', [query, catalogIds]);
	}
}
