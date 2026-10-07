// cursor-motion: https://github.com/trycua/cua/blob/2ce4691fc053287b332fb5ca9a170f4fbcbd7f1d/libs/typescript/cursor-motion/src/rng.ts
// Copyright (c) 2025 Cua AI, Inc. Licensed under the MIT License. See LICENSE in this folder.
// PARA-CODE: third-party file vendored by Para Code - not present in upstream microsoft/vscode. See README.md in this folder.
// Para Code change: relative imports end in .js (VS Code loads ES modules by file name).

/** FNV-1a over UTF-16 code units. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32, bit-identical to the Rust crate and the motion lab. */
export class Rng {
  private state: number;

  constructor(seed: string) {
    this.state = hashString(seed) || 1;
  }

  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
}
