'use strict';
// Tests for getAnonymousId persistence semantics (stable, valid, PII-free).
const test = require('node:test');
const assert = require('node:assert');
const A = require('../belfed-attribution.js');

function mockStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    _map: m,
  };
}

test('getAnonymousId creates a valid UUID-shaped id and persists it', () => {
  const s = mockStorage();
  const id = A.getAnonymousId(s);
  assert.match(id, /^[0-9a-fA-F-]{16,64}$/);
  assert.strictEqual(s.getItem('bf_anon_id'), id);
});

test('getAnonymousId is stable across calls (same storage → same id)', () => {
  const s = mockStorage();
  const a = A.getAnonymousId(s);
  const b = A.getAnonymousId(s);
  assert.strictEqual(a, b);
});

test('getAnonymousId replaces a malformed stored value', () => {
  const s = mockStorage();
  s.setItem('bf_anon_id', 'not a uuid !!!');
  const id = A.getAnonymousId(s);
  assert.match(id, /^[0-9a-fA-F-]{16,64}$/);
  assert.notStrictEqual(id, 'not a uuid !!!');
});

test('anonymous_id contains no PII — it is a random handle only', () => {
  const s = mockStorage();
  const id = A.getAnonymousId(s);
  assert.ok(!id.includes('@'));
  assert.ok(!/[a-z]{4,}\s/i.test(id));
});

test('uuid() produces distinct values', () => {
  const set = new Set();
  for (let i = 0; i < 100; i++) set.add(A.uuid());
  assert.strictEqual(set.size, 100);
});
