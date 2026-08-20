import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSpaceRole, accessibleSpacesQuery, PUBLIC_ROLES, SPACE_ROLES } from '../src/lib/auth.js';

const member = { id: 'u1', role: 'member' };
const admin = { id: 'u2', role: 'admin' };

test('a private space is members-only', () => {
  assert.equal(resolveSpaceRole({ memberRole: null, publicRole: null }), null);
  assert.equal(resolveSpaceRole({ memberRole: 'reader', publicRole: null }), 'reader');
});

test('a public space grants its role to users with no membership row', () => {
  assert.equal(resolveSpaceRole({ memberRole: null, publicRole: 'reader' }), 'reader');
  assert.equal(resolveSpaceRole({ memberRole: null, publicRole: 'writer' }), 'writer');
});

test('an explicit membership row raises access above the public role', () => {
  assert.equal(resolveSpaceRole({ memberRole: 'writer', publicRole: 'reader' }), 'writer');
  assert.equal(resolveSpaceRole({ memberRole: 'admin', publicRole: 'reader' }), 'admin');
});

test('an explicit membership row also holds a user below the public role', () => {
  assert.equal(resolveSpaceRole({ memberRole: 'reader', publicRole: 'writer' }), 'reader');
});

test('public access cannot hand out space admin', () => {
  assert.deepEqual(PUBLIC_ROLES, ['reader', 'writer']);
  assert.ok(!PUBLIC_ROLES.includes('admin'));
  assert.ok(SPACE_ROLES.includes('admin'));
});

test('accessible spaces cover memberships and public spaces for ordinary users', () => {
  const acc = accessibleSpacesQuery(member);
  assert.deepEqual(acc.params, [member.id]);
  assert.match(acc.sql, /space_members WHERE user_id = \$1/);
  assert.match(acc.sql, /public_role IS NOT NULL/);
});

test('workspace admins still see every space with no parameters', () => {
  const acc = accessibleSpacesQuery(admin);
  assert.deepEqual(acc.params, []);
  assert.equal(acc.sql, 'SELECT id FROM spaces');
});
