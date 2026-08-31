/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import { createServer } from 'http';
import JSZip from 'jszip';
import { load } from 'js-yaml';
import * as path from 'path';
import { Stream } from 'stream';
import { suite, test } from 'node:test';
import File from 'vinyl';
import { getParadisDesktopUpdatePlatform } from '../../../src/vs/platform/update/common/paradisUpdatePlatform.ts';
import type { IExtensionDefinition } from '../builtInExtensions.ts';
import { fromMarketplace } from '../extensions.ts';

interface IWorkflowStep {
	readonly name?: string;
	readonly uses?: string;
	readonly run?: string;
	readonly with?: Record<string, string>;
}

interface IWorkflowJob {
	readonly strategy?: { readonly matrix?: { readonly arch?: readonly string[] } };
	readonly steps: readonly IWorkflowStep[];
}

interface IReleaseWorkflow {
	readonly jobs: Record<string, IWorkflowJob>;
}

interface IProductManifest {
	readonly updateUrl: string;
	readonly extensionsGallery: { readonly serviceUrl: string };
	readonly builtInExtensions: readonly IExtensionDefinition[];
}

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');

function readReleaseWorkflow(): IReleaseWorkflow {
	return load(fs.readFileSync(path.join(repositoryRoot, '.github/workflows/para-release.yml'), 'utf8')) as IReleaseWorkflow;
}

function readProductManifest(): IProductManifest {
	return JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'product.json'), 'utf8')) as IProductManifest;
}

function getUploadContract(job: IWorkflowJob): { readonly artifact: string; readonly files: readonly string[] } {
	const upload = job.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
	assert.ok(upload?.with?.name);
	assert.ok(upload.with.path);
	return {
		artifact: upload.with.name,
		files: upload.with.path.split('\n').map(file => file.trim()).filter(file => file.length > 0),
	};
}

function expandUploadContract(contract: { readonly artifact: string; readonly files: readonly string[] }, architectures: readonly string[] = ['']): readonly { readonly artifact: string; readonly file: string }[] {
	return architectures.flatMap(arch => contract.files
		.filter(file => !file.endsWith('.sha256'))
		.map(file => ({
			artifact: contract.artifact.replaceAll('${{ matrix.arch }}', arch),
			file: file.replaceAll('${{ matrix.arch }}', arch),
		})));
}

function getPublishedArtifacts(workflow: IReleaseWorkflow): readonly { readonly platform: string; readonly directory: string; readonly file: string; readonly artifact: string }[] {
	const publishScript = workflow.jobs['publish'].steps.find(step => step.name === 'Publish artifacts to R2 + update feed KV')?.run;
	assert.ok(publishScript);
	return [...publishScript.matchAll(/^\s*publish\s+"stable:(?<platform>[^"]+)"\s+"(?<directory>[^"]+)"\s+"(?<file>[^"]+)"\s+"(?<artifact>[^"]+)"/gm)].map(match => ({
		platform: match.groups!.platform,
		directory: match.groups!.directory,
		file: match.groups!.file,
		artifact: match.groups!.artifact,
	}));
}

async function createVsixFixture(): Promise<Buffer> {
	const zip = new JSZip();
	zip.file('extension/package.json', JSON.stringify({ publisher: 'ms-vscode', name: 'vscode-js-profile-table', version: '1.0.11' }));
	zip.file('extension/out/extension.js', 'module.exports = {};');
	return zip.generateAsync({ type: 'nodebuffer' });
}

function collectFiles(stream: Stream): Promise<readonly File[]> {
	return new Promise((resolve, reject) => {
		const files: File[] = [];
		stream.on('data', file => files.push(file));
		stream.on('error', reject);
		stream.on('end', () => resolve(files));
	});
}

async function consumeMarketplaceFixture(extension: IExtensionDefinition): Promise<{ readonly requestedPath: string; readonly files: readonly File[] }> {
	const vsix = await createVsixFixture();
	let requestedPath: string | undefined;
	const server = createServer((request, response) => {
		requestedPath = request.url;
		response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
		response.end(vsix);
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});

	try {
		const address = server.address();
		assert.ok(address && typeof address !== 'string');
		const files = await collectFiles(fromMarketplace(`http://127.0.0.1:${address.port}`, {
			...extension,
			sha256: createHash('sha256').update(vsix).digest('hex'),
		}));
		assert.ok(requestedPath);
		return { requestedPath, files };
	} finally {
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
}

suite('Para Code release contract', () => {
	test('publishes the platform names consumed by desktop update clients from matching workflow artifacts', () => {
		const workflow = readReleaseWorkflow();
		const published = getPublishedArtifacts(workflow);
		const desktopPlatforms = [
			getParadisDesktopUpdatePlatform('darwin', 'x64'),
			getParadisDesktopUpdatePlatform('darwin', 'arm64'),
			getParadisDesktopUpdatePlatform('win32', 'x64', { target: 'user' }),
			getParadisDesktopUpdatePlatform('win32', 'arm64', { target: 'user' }),
			getParadisDesktopUpdatePlatform('linux', 'x64'),
		];
		const uploadContracts = {
			darwin: getUploadContract(workflow.jobs['build-darwin']),
			win32: getUploadContract(workflow.jobs['build-win32']),
			linux: getUploadContract(workflow.jobs['build-linux']),
		};

		assert.deepStrictEqual(workflow.jobs['build-darwin'].strategy?.matrix?.arch, ['x64', 'arm64']);
		assert.deepStrictEqual(workflow.jobs['build-win32'].strategy?.matrix?.arch, ['x64', 'arm64']);
		assert.deepStrictEqual(published.map(item => item.platform).sort(), desktopPlatforms.sort());
		assert.deepStrictEqual(uploadContracts, {
			darwin: { artifact: 'darwin-${{ matrix.arch }}', files: ['darwin-${{ matrix.arch }}.zip', 'darwin-${{ matrix.arch }}.zip.sha256'] },
			win32: { artifact: 'win32-${{ matrix.arch }}', files: ['win32-${{ matrix.arch }}-user-setup.exe', 'win32-${{ matrix.arch }}-user-setup.exe.sha256'] },
			linux: { artifact: 'linux-x64', files: ['linux-x64.deb', 'linux-x64.deb.sha256'] },
		});
		const uploaded = [
			...expandUploadContract(uploadContracts.darwin, workflow.jobs['build-darwin'].strategy?.matrix?.arch),
			...expandUploadContract(uploadContracts.win32, workflow.jobs['build-win32'].strategy?.matrix?.arch),
			...expandUploadContract(uploadContracts.linux),
		];
		assert.deepStrictEqual(
			published.map(item => JSON.stringify({ artifact: item.artifact, file: item.file })).sort(),
			uploaded.map(item => JSON.stringify(item)).sort(),
		);
	});

	test('consumes the current Open VSX manifest contract through fromMarketplace', async () => {
		const product = readProductManifest();
		assert.strictEqual(product.extensionsGallery.serviceUrl, 'https://open-vsx.org/vscode/gallery');
		const extension = product.builtInExtensions.find(candidate => candidate.name === 'ms-vscode.vscode-js-profile-table');
		assert.ok(extension);
		assert.match(extension.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
		assert.match(extension.sha256 ?? '', /^[a-f\d]{64}$/);
		const result = await consumeMarketplaceFixture(extension);
		const [publisher, name] = extension.name.split('.');
		const packageJson = result.files.find(file => file.relative === 'package.json');
		assert.ok(packageJson?.contents);
		assert.deepStrictEqual({
			requestedPath: result.requestedPath,
			files: result.files.map(file => file.relative).sort(),
			metadata: JSON.parse(packageJson.contents.toString()).__metadata,
		}, {
			requestedPath: `/publishers/${publisher}/vsextensions/${name}/${extension.version}/vspackage`,
			files: ['out', 'out/extension.js', 'package.json'],
			metadata: extension.metadata,
		});
	});
});
