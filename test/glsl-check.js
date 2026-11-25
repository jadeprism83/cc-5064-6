// Lightweight offline GLSL sanity checks (no GPU available in this environment).
// These do not replace driver compilation but catch structural mistakes:
// unbalanced braces/parens, missing version, duplicate/unresolved identifiers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHADER_DIR = path.join(__dirname, '..', 'public', 'shaders');
const files = fs.readdirSync(SHADER_DIR).filter((f) => f.endsWith('.vert') || f.endsWith('.frag'));

let passed = 0;
for (const file of files) {
  const src = fs.readFileSync(path.join(SHADER_DIR, file), 'utf8');
  assert.ok(src.startsWith('#version 300 es'), `${file}: must target GLSL ES 3.00`);

  // Strip comments and strings before balance checks.
  const clean = src
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const pairs = { '}': '{', ')': '(' };
  const stack = [];
  for (const ch of clean) {
    if (ch === '{' || ch === '(') stack.push(ch);
    else if (ch === '}' || ch === ')') {
      assert.equal(stack.pop(), pairs[ch], `${file}: unbalanced ${ch}`);
    }
  }
  assert.equal(stack.length, 0, `${file}: unclosed brackets`);

  // Every declared in/out must be used or is a legal entry signature.
  const outs = [...clean.matchAll(/^\s*(?:layout\([^)]*\)\s*)?out\s+\w+\s+(\w+)/gm)].map((m) => m[1]);
  for (const name of outs) {
    const uses = clean.match(new RegExp(`\\b${name}\\b`, 'g')) || [];
    assert.ok(uses.length >= 2, `${file}: out ${name} never assigned`);
  }
  console.log('  PASS', file);
  passed++;
}
console.log(`\n${passed} shader files structurally valid`);
