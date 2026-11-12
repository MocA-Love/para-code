/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { gunzipSync } from 'zlib';

const REPO_ROOT = path.dirname(path.dirname(import.meta.dirname));

const DOCX_PREVIEW_037_TARBALL_URL = 'https://registry.npmjs.org/docx-preview/-/docx-preview-0.3.7.tgz';
const DOCX_PREVIEW_037_TARBALL_SHA256 = 'cfc102718407e6a1d591df01aa50e070dce308fb7f7f49655927ff3b742edb77';
const DOCX_PREVIEW_037_UPSTREAM_SHA256 = 'a011a499016a269eb048b8558a3eefc94bc33568ef434235943948ff24a40005';
const DOCX_PREVIEW_037_PATCHED_SHA256 = 'be407c2f18c43cc02a66d678513bed33e698c9d1e3e88df64b5e172629a8fc74';
const DOCX_PREVIEW_037_LICENSE_SHA256 = '0ed0b35bd10cb0d990fbecf7f1e05d113d785dfbbef8332e139fc10b84a4c3d7';
const JSZIP_3101_SHA256 = 'acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e';
const JSZIP_3101_LICENSE_SHA256 = '566c953c6090b1218ca6217dd7359d45dde46581968586dc607d59a78af6a9c4';
const DOCX_PREVIEW_MOBILE_BUNDLE_SHA256 = 'c5bae3ae1f48e7db24239c4fc252c4d81d7276dcafbe9d6b2e2f86c0dabadc6e';

interface IDocxPreview037Patch {
	readonly id: string;
	readonly before: string;
	readonly after: string;
}

const docxPreview037Patches: readonly IDocxPreview037Patch[] = [
	{
		id: 'vml-stroke-attributes',
		before: 'case"fillcolor":r.attrs.fill=t.value;break;case"from"',
		after: 'case"fillcolor":r.attrs.fill=t.value;break;case"strokecolor":r.attrs.stroke=t.value.replace(/\\s*\\[[^\\]]*\\]\\s*$/,"");break;case"strokeweight":r.attrs["stroke-width"]=t.value;break;case"from"',
	},
	{
		id: 'vertical-writing-variants',
		before: 'tbRl:{writingMode:"vertical-rl",transform:"none"}};for(const a of v.elements(e))',
		after: 'tbRl:{writingMode:"vertical-rl",transform:"none"},tbRlV:{writingMode:"vertical-rl",transform:"none"},lrTbV:{writingMode:"vertical-lr",transform:"none"},tbLrV:{writingMode:"vertical-rl",transform:"rotate(180deg)"}};for(const a of v.elements(e))',
	},
	{
		id: 'table-layout-type-attribute',
		before: 'static valueOfTblLayout(e){return"fixed"==v.attr(e,"val")?"fixed":"auto"}',
		after: 'static valueOfTblLayout(e){return"fixed"==v.attr(e,"type")?"fixed":"auto"}',
	},
	{
		id: 'hanging-indent-tab-stop',
		before: ':[Ve],c=i[i.length-1],h=l.width*a',
		after: ':[Ve],c=(parseFloat(o.textIndent)<0&&i[0].pos>0&&i.unshift({pos:0,leader:"none",style:"left"}),i[i.length-1]),h=l.width*a',
	},
	{
		id: 'fixed-table-width',
		before: 'e.columns&&t.appendChild(this.renderTableColumns(e.columns)),this.renderClass(e,t)',
		after: 'e.columns&&(t.appendChild(this.renderTableColumns(e.columns)),"auto"===e.cssStyle.width&&"fixed"===e.cssStyle["table-layout"]&&e.columns.every(e=>e.width)&&(e.cssStyle.width=e.columns.reduce((e,t)=>e+parseFloat(t.width),0)+"pt"),"auto"!==e.cssStyle.width&&!e.cssStyle["table-layout"]&&(e.cssStyle["table-layout"]="fixed")),this.renderClass(e,t)',
	},
	{
		id: 'page-relative-vml-origin',
		before: 'renderVmlElement(e){var t=this.createSvgElement("svg");t.setAttribute("style",e.cssStyleText);const r=',
		after: 'renderVmlElement(e){var t=this.createSvgElement("svg");t.setAttribute("style",e.cssStyleText);/mso-position-horizontal-relative:page/.test(e.cssStyleText)&&(t.style.left="0");/mso-position-vertical-relative:page/.test(e.cssStyleText)&&(t.style.top="0");const r=',
	},
	{
		id: 'numbering-css-content',
		before: 'levelTextToContent(e,t,r,a){return`"${e.replace(/%\\d*/g,e=>{let t=parseInt(e.substring(1),10)-1;return`"counter(${this.numberingCounter(r,t)}, ${a})"`})}${{tab:"\\\\9",space:"\\\\a0"}[t]??""}"`}',
		after: 'levelTextToContent(e,t,r,a){const n=[];let l=0;const p=/%\\d*/g;let m;while(m=p.exec(e)){if(m.index>l)n.push(JSON.stringify(e.slice(l,m.index)));const lv=parseInt(m[0].substring(1),10)-1;n.push(`counter(${this.numberingCounter(r,lv)}, ${a})`);l=m.index+m[0].length}if(l<e.length)n.push(JSON.stringify(e.slice(l)));const sf={tab:\'"\\\\9"\',space:\'"\\\\a0"\'}[t];if(sf)n.push(sf);return n.join(" ")}',
	},
];

function sha256(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}

function verifyHash(name: string, value: string | Uint8Array, expected: string): void {
	const actual = sha256(value);
	if (actual !== expected) {
		throw new Error(`${name} SHA-256 mismatch: expected ${expected}, got ${actual}`);
	}
}

function readTarEntry(archive: Buffer, wantedPath: string): Buffer {
	for (let offset = 0; offset + 512 <= archive.length;) {
		const header = archive.subarray(offset, offset + 512);
		if (header.every(value => value === 0)) {
			break;
		}
		const entryPath = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
		const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
		const size = Number.parseInt(sizeText || '0', 8);
		if (!Number.isSafeInteger(size) || size < 0) {
			throw new Error(`Invalid tar entry size for ${entryPath}`);
		}
		const contentOffset = offset + 512;
		if (entryPath === wantedPath) {
			return Buffer.from(archive.subarray(contentOffset, contentOffset + size));
		}
		offset = contentOffset + Math.ceil(size / 512) * 512;
	}
	throw new Error(`Missing ${wantedPath} in docx-preview 0.3.7 tarball`);
}

function applyDocxPreview037Patches(upstream: string): string {
	let result = upstream;
	for (const patch of docxPreview037Patches) {
		const first = result.indexOf(patch.before);
		if (first < 0 || result.indexOf(patch.before, first + patch.before.length) >= 0) {
			throw new Error(`Patch ${patch.id} expected exactly one upstream match`);
		}
		result = result.slice(0, first) + patch.after + result.slice(first + patch.before.length);
	}
	return result;
}

async function writeOrCheck(filePath: string, value: string | Uint8Array, check: boolean): Promise<void> {
	const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
	if (check) {
		const existing = await fs.promises.readFile(filePath);
		if (!existing.equals(bytes)) {
			throw new Error(`${path.relative(REPO_ROOT, filePath)} is not reproducible; run the docx-preview-037 build`);
		}
		return;
	}
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	await fs.promises.writeFile(filePath, bytes);
}

/**
 * Reproducible docx-preview 0.3.7 vendor build shared by desktop and mobile
 * (`node build/next/index.ts docx-preview-037 [--check] [--out <dir>]`).
 */
export async function buildDocxPreview037(outputDirectory: string | undefined, check: boolean): Promise<void> {
	const response = await fetch(DOCX_PREVIEW_037_TARBALL_URL);
	if (!response.ok) {
		throw new Error(`Unable to download docx-preview 0.3.7: HTTP ${response.status}`);
	}
	const tarball = Buffer.from(await response.arrayBuffer());
	verifyHash('docx-preview 0.3.7 tarball', tarball, DOCX_PREVIEW_037_TARBALL_SHA256);
	const archive = gunzipSync(tarball);
	const upstream = readTarEntry(archive, 'package/dist/docx-preview.min.js').toString('utf8');
	const docxLicense = readTarEntry(archive, 'package/LICENSE').toString('utf8').replaceAll('\r\n', '\n');
	verifyHash('upstream docx-preview.min.js', upstream, DOCX_PREVIEW_037_UPSTREAM_SHA256);
	verifyHash('docx-preview license', docxLicense, DOCX_PREVIEW_037_LICENSE_SHA256);
	const patched = applyDocxPreview037Patches(upstream);
	verifyHash('patched docx-preview.min.js', patched, DOCX_PREVIEW_037_PATCHED_SHA256);

	const vendorDirectory = path.join(REPO_ROOT, 'src/vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview');
	const jszip = await fs.promises.readFile(path.join(vendorDirectory, 'jszip.min.js'));
	const jszipLicense = await fs.promises.readFile(path.join(vendorDirectory, 'LICENSE-jszip'));
	verifyHash('jszip 3.10.1', jszip, JSZIP_3101_SHA256);
	verifyHash('jszip license', jszipLicense, JSZIP_3101_LICENSE_SHA256);
	const mobileBundle = `{"version": 1, "jszip": ${JSON.stringify(jszip.toString('utf8'))}, "docxPreview": ${JSON.stringify(patched)}}`;
	verifyHash('mobile docx preview bundle', mobileBundle, DOCX_PREVIEW_MOBILE_BUNDLE_SHA256);

	const pcOutput = outputDirectory ? path.resolve(REPO_ROOT, outputDirectory, 'pc') : vendorDirectory;
	const mobileOutput = outputDirectory
		? path.resolve(REPO_ROOT, outputDirectory, 'mobile/docxPreviewBundle.json')
		: path.join(REPO_ROOT, 'app/mobile/assets/docxpreview/docxPreviewBundle.json');
	await Promise.all([
		writeOrCheck(path.join(pcOutput, 'docx-preview.min.js'), patched, check),
		writeOrCheck(path.join(pcOutput, 'LICENSE-docx-preview'), docxLicense, check),
		writeOrCheck(path.join(pcOutput, 'jszip.min.js'), jszip, check),
		writeOrCheck(path.join(pcOutput, 'LICENSE-jszip'), jszipLicense, check),
		writeOrCheck(mobileOutput, mobileBundle, check),
	]);
	console.log(`[docx-preview-037] docx=${DOCX_PREVIEW_037_PATCHED_SHA256} mobile=${DOCX_PREVIEW_MOBILE_BUNDLE_SHA256}${check ? ' (checked)' : ''}`);
}
