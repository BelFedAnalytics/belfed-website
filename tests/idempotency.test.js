'use strict';
// Models the DB idempotency contract enforced by
// ux_conversion_funnel_events_event_key (unique partial index) +
// record_conversion_event's ON CONFLICT (event_key) DO NOTHING.
//
// The real guarantee lives in Postgres (see the migration + SQL test), which
// cannot run in this environment. These tests pin the KEY-DERIVATION contract
// the SQL relies on: identical funnel inputs must yield identical event_keys,
// so a replay collides and is dropped.
const test = require('node:test');
const assert = require('node:assert');
const A = require('../belfed-attribution.js');

// Minimal stand-in for the unique-partial-index behavior.
function makeConversionTable() {
  const rows = [];
  const seen = new Set();
  return {
    // returns inserted id, or null when event_key already present (DO NOTHING)
    record(evt) {
      if (evt.event_key != null) {
        if (seen.has(evt.event_key)) return null;
        seen.add(evt.event_key);
      }
      const id = rows.length + 1;
      rows.push({ id, ...evt });
      return id;
    },
    count(event_key) { return rows.filter((r) => r.event_key === event_key).length; },
    get rows() { return rows; },
  };
}

test('duplicate payment webhook does not double-count (same event_key)', () => {
  const t = makeConversionTable();
  const key = A.paymentEventKey('yookassa', 'pay_42');
  const first = t.record({ event_type: 'payment', event_key: key, value: 1500 });
  const second = t.record({ event_type: 'payment', event_key: key, value: 1500 });
  assert.ok(first, 'first insert succeeds');
  assert.strictEqual(second, null, 'replay is a no-op');
  assert.strictEqual(t.count(key), 1, 'exactly one payment row');
});

test('signup replay (resent form, same token) collapses to one row', () => {
  const t = makeConversionTable();
  const key = A.signupEventKey('tok_web_1');
  t.record({ event_type: 'signup', event_key: key });
  t.record({ event_type: 'signup', event_key: key });
  t.record({ event_type: 'signup', event_key: key });
  assert.strictEqual(t.count(key), 1);
});

test('distinct funnel stages for one token keep distinct keys', () => {
  const t = makeConversionTable();
  const signup = A.signupEventKey('tok_web_1');
  const trial = A.trialEventKey('tok_web_1');
  assert.notStrictEqual(signup, trial);
  t.record({ event_type: 'signup', event_key: signup });
  t.record({ event_type: 'trial', event_key: trial });
  assert.strictEqual(t.rows.length, 2);
});

test('different providers with same payment id do not collide', () => {
  assert.notStrictEqual(
    A.paymentEventKey('yookassa', 'x1'),
    A.paymentEventKey('tribute', 'x1')
  );
});
