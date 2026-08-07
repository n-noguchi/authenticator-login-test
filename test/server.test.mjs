import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceOrigin, safeClaims } from '../src/server.mjs';

test('バックチャネル URL は issuer のパスを保って内部 origin に置換する', () => {
  assert.equal(
    replaceOrigin('http://localhost:8080/realms/mfa-demo/protocol/openid-connect/token', 'http://localhost:8080/realms/mfa-demo', 'http://keycloak:8080/realms/mfa-demo'),
    'http://keycloak:8080/realms/mfa-demo/protocol/openid-connect/token'
  );
});

test('安全表示する claim は許可リストだけである', () => {
  assert.deepEqual(safeClaims({ sub: 'id', preferred_username: 'demo', acr: '1', amr: ['pwd', 'otp', 3], access_token: 'secret' }), {
    sub: 'id', preferred_username: 'demo', email: undefined, acr: '1', amr: ['pwd', 'otp']
  });
});
