/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Verifies that the image viewer wins over the upstream image preview custom editor (builtin priority, as
// contributed by extensions/media-preview) with the real EditorResolverService, including diffs, user
// associations, the "reopen as text" override and the opt-out setting.

import { deepStrictEqual } from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { EditorResolution } from '../../../../../platform/editor/common/editor.js';
import { DEFAULT_EDITOR_ASSOCIATION, IResourceDiffEditorInput, IUntypedEditorInput } from '../../../../../workbench/common/editor.js';
import { EditorResolverService } from '../../../../../workbench/services/editor/browser/editorResolverService.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { editorsAssociationsSettingId, IEditorResolverService, RegisteredEditorPriority, ResolvedStatus } from '../../../../../workbench/services/editor/common/editorResolverService.js';
import { createEditorPart, TestFileEditorInput, workbenchInstantiationService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { registerParadisImageEditors } from '../../browser/image/paradisImageEditorRegistration.js';

const IMAGE_INPUT = 'test.paradisImage';
const UPSTREAM_INPUT = 'test.upstreamImagePreview';
const TEXT_INPUT = 'test.defaultText';
const UPSTREAM_VIEW_TYPE = 'imagePreview.previewEditor';
const AUDIO_INPUT = 'test.upstreamAudioPreview';
const VIDEO_INPUT = 'test.upstreamVideoPreview';

suite('ParadisImageEditorRegistration', () => {
	const disposables = new DisposableStore();
	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	async function resolve(configuration: Record<string, unknown>, editor: IUntypedEditorInput | IResourceDiffEditorInput, enabled = true): Promise<string> {
		const instantiationService = workbenchInstantiationService({ configurationService: () => new TestConfigurationService(configuration) }, disposables);
		const part = await createEditorPart(instantiationService, disposables);
		instantiationService.stub(IEditorGroupsService, part);
		const service = disposables.add(instantiationService.createInstance(EditorResolverService));
		instantiationService.stub(IEditorResolverService, service);
		const testInput = (resource: URI, typeId: string) => disposables.add(new TestFileEditorInput(resource, typeId));
		// The built-in text editor, registered the same way the workbench does (builtin priority for every file).
		disposables.add(service.registerEditor('*', { id: DEFAULT_EDITOR_ASSOCIATION.id, label: DEFAULT_EDITOR_ASSOCIATION.displayName, priority: RegisteredEditorPriority.builtin }, {}, {
			createEditorInput: ({ resource }) => ({ editor: testInput(resource, TEXT_INPUT) }),
			createDiffEditorInput: ({ modified }) => ({ editor: testInput(modified.resource!, `diff:${TEXT_INPUT}`) }),
		}));
		// The upstream image preview custom editor, as contributed by extensions/media-preview/package.json.
		disposables.add(service.registerEditor('*.{jpg,jpe,jpeg,png,bmp,gif,ico,webp,avif,svg}', { id: UPSTREAM_VIEW_TYPE, label: 'Image Preview', priority: RegisteredEditorPriority.builtin }, {}, {
			createEditorInput: ({ resource }) => ({ editor: testInput(resource, UPSTREAM_INPUT) }),
			createDiffEditorInput: ({ modified }) => ({ editor: testInput(modified.resource!, `diff:${UPSTREAM_INPUT}`) }),
		}));
		// The other two custom editors of extensions/media-preview (audio and video) must stay untouched.
		disposables.add(service.registerEditor('*.{mp3,wav,ogg,oga}', { id: 'vscode.audioPreview', label: 'Audio Preview', priority: RegisteredEditorPriority.builtin }, {}, {
			createEditorInput: ({ resource }) => ({ editor: testInput(resource, AUDIO_INPUT) }),
		}));
		disposables.add(service.registerEditor('*.{mp4,webm}', { id: 'vscode.videoPreview', label: 'Video Preview', priority: RegisteredEditorPriority.builtin }, {}, {
			createEditorInput: ({ resource }) => ({ editor: testInput(resource, VIDEO_INPUT) }),
		}));
		disposables.add(registerParadisImageEditors(service, {
			isEnabled: () => enabled,
			canRead: resource => resource.scheme !== 'no-provider',
			createInput: resource => testInput(resource, IMAGE_INPUT),
			createDiffInput: (_label, _description, original, modified) => testInput(modified.resource!, `diff:${original.typeId}+${modified.typeId}`),
		}));
		const result = await service.resolveEditor(editor, part.activeGroup);
		if (result === ResolvedStatus.NONE) {
			return 'none (text editor)';
		}
		if (result === ResolvedStatus.ABORT) {
			return 'abort';
		}
		return result.editor.typeId;
	}

	test('opens images in the image viewer ahead of the upstream preview, and keeps the text and opt-out paths', async () => {
		const png = URI.file('/workspace/logo.png');
		const svg = URI.file('/workspace/icon.SVG');
		const gitPng = URI.from({ scheme: 'git', path: '/workspace/logo.png', query: '{"ref":"HEAD~1"}' });
		deepStrictEqual({
			png: await resolve({}, { resource: png }),
			svg: await resolve({}, { resource: svg }),
			associatedWithUpstream: await resolve({ [editorsAssociationsSettingId]: { '*.png': UPSTREAM_VIEW_TYPE } }, { resource: png }),
			associatedWithText: await resolve({ [editorsAssociationsSettingId]: { '*.svg': DEFAULT_EDITOR_ASSOCIATION.id } }, { resource: svg }),
			textAssociationForOtherFiles: await resolve({ [editorsAssociationsSettingId]: { '*.svg': DEFAULT_EDITOR_ASSOCIATION.id } }, { resource: png }),
			moreSpecificAssociation: await resolve({ [editorsAssociationsSettingId]: { '*.svg': DEFAULT_EDITOR_ASSOCIATION.id, 'icon.SVG': UPSTREAM_VIEW_TYPE } }, { resource: svg }),
			associatedWithUnknownEditor: await resolve({ [editorsAssociationsSettingId]: { '*.png': 'some.uninstalledEditor' } }, { resource: png }),
			reopenAsText: await resolve({}, { resource: svg, options: { override: DEFAULT_EDITOR_ASSOCIATION.id } }),
			reopenWithUpstream: await resolve({}, { resource: png, options: { override: UPSTREAM_VIEW_TYPE } }),
			extensionShowTextDocument: await resolve({}, { resource: png, options: { override: EditorResolution.EXCLUSIVE_ONLY } }),
			disabled: await resolve({}, { resource: png }, false),
			unreadableScheme: await resolve({}, { resource: URI.from({ scheme: 'no-provider', path: '/logo.png' }) }),
			scmDiff: await resolve({}, { original: { resource: gitPng }, modified: { resource: png } }),
			scmDiffDisabled: await resolve({}, { original: { resource: gitPng }, modified: { resource: png } }, false),
		}, {
			png: IMAGE_INPUT,
			svg: IMAGE_INPUT,
			associatedWithUpstream: IMAGE_INPUT,
			associatedWithText: TEXT_INPUT,
			textAssociationForOtherFiles: IMAGE_INPUT,
			moreSpecificAssociation: IMAGE_INPUT,
			associatedWithUnknownEditor: IMAGE_INPUT,
			reopenAsText: TEXT_INPUT,
			reopenWithUpstream: UPSTREAM_INPUT,
			extensionShowTextDocument: IMAGE_INPUT,
			disabled: UPSTREAM_INPUT,
			unreadableScheme: UPSTREAM_INPUT,
			scmDiff: `diff:${IMAGE_INPUT}+${IMAGE_INPUT}`,
			scmDiffDisabled: `diff:${UPSTREAM_INPUT}`,
		});
	});

	test('only takes the image extensions and leaves audio, video and other files to their current editors', async () => {
		const names = [
			'a.jpg', 'a.jpe', 'a.jpeg', 'a.png', 'a.bmp', 'a.gif', 'a.ico', 'a.webp', 'a.avif', 'a.svg',
			'a.mp4', 'a.webm', 'a.mp3', 'a.wav', 'a.ogg', 'a.oga', 'a.mov', 'a.m4a', 'a.flac',
			'a.html', 'a.md', 'a.svgz', 'a.tiff',
		];
		const resolved: Record<string, string> = {};
		for (const name of names) {
			resolved[name] = await resolve({}, { resource: URI.file(`/workspace/${name}`) });
		}
		deepStrictEqual(resolved, {
			'a.jpg': IMAGE_INPUT, 'a.jpe': IMAGE_INPUT, 'a.jpeg': IMAGE_INPUT, 'a.png': IMAGE_INPUT, 'a.bmp': IMAGE_INPUT,
			'a.gif': IMAGE_INPUT, 'a.ico': IMAGE_INPUT, 'a.webp': IMAGE_INPUT, 'a.avif': IMAGE_INPUT, 'a.svg': IMAGE_INPUT,
			'a.mp4': VIDEO_INPUT, 'a.webm': VIDEO_INPUT,
			'a.mp3': AUDIO_INPUT, 'a.wav': AUDIO_INPUT, 'a.ogg': AUDIO_INPUT, 'a.oga': AUDIO_INPUT,
			// Not handled by media-preview upstream either: the text/binary editor, as before.
			'a.mov': TEXT_INPUT, 'a.m4a': TEXT_INPUT, 'a.flac': TEXT_INPUT,
			// The fork's HTML / Markdown viewers register their own `*.html` / `*.md` globs; this registration never matches them.
			'a.html': TEXT_INPUT, 'a.md': TEXT_INPUT, 'a.svgz': TEXT_INPUT, 'a.tiff': TEXT_INPUT,
		});
	});
});
