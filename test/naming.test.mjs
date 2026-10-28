import test from 'node:test';
import assert from 'node:assert/strict';
import { publicToolName, MAX_PUBLIC_NAME_LENGTH } from '../src/naming.js';

test('clean identity is mcp__<server>__<raw> verbatim', () => {
  assert.equal(publicToolName('demo', 'ping'), 'mcp__demo__ping');
  assert.equal(publicToolName('summon-fixture', 'echo'), 'mcp__summon-fixture__echo');
});

test('invalid characters are normalized and salted with the identity hash', () => {
  const name = publicToolName('my.server', 'do it!');
  // '!' normalizes to '_', then the identity hash is appended after another '_'.
  assert.match(name, /^mcp__my_server__do_it__[0-9a-f]{12}$/);
  assert.ok(name.length <= MAX_PUBLIC_NAME_LENGTH);
});

test('over-long identities truncate to the 64-char contract with a hash suffix', () => {
  const rawName = 'x'.repeat(100);
  const name = publicToolName('server', rawName);
  assert.equal(name.length, MAX_PUBLIC_NAME_LENGTH);
  assert.match(name, /_[0-9a-f]{12}$/);
});

test('naming is deterministic and distinct identities never collapse', () => {
  assert.equal(publicToolName('a', 'b'), publicToolName('a', 'b'));
  // Both normalize to mcp__a_b__c without the hash; the salt keeps them apart.
  assert.notEqual(publicToolName('a.b', 'c'), publicToolName('a', 'b.c'));
  assert.notEqual(publicToolName('a', 'b'), publicToolName('ab', ''));
});
