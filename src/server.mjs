import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export function replaceOrigin(url, sourceOrigin, destinationOrigin) {
  const parsed = new URL(url);
  if (parsed.origin !== new URL(sourceOrigin).origin) {
    throw new Error('OIDC endpoint origin is issuer origin と一致しません');
  }
  const destination = new URL(destinationOrigin);
  parsed.protocol = destination.protocol;
  parsed.host = destination.host;
  return parsed.toString();
}

export function safeClaims(payload) {
  const pickString = (name) => typeof payload[name] === 'string' ? payload[name] : undefined;
  const pickStrings = (name) => Array.isArray(payload[name]) ? payload[name].filter((value) => typeof value === 'string') : undefined;
  return {
    sub: pickString('sub'),
    preferred_username: pickString('preferred_username'),
    email: pickString('email'),
    acr: pickString('acr'),
    amr: pickStrings('amr')
  };
}

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} を設定してください`);
  return value;
};

const requiredBoolean = (name) => {
  const value = required(name);
  if (value !== 'true' && value !== 'false') throw new Error(`${name} は true または false にしてください`);
  return value === 'true';
};

async function main() {
  const issuer = required('OIDC_ISSUER').replace(/\/$/, '');
  const backchannelIssuer = required('OIDC_BACKCHANNEL_ISSUER').replace(/\/$/, '');
  const clientId = required('OIDC_CLIENT_ID');
  const clientSecret = required('OIDC_CLIENT_SECRET');
  const redirectUri = required('OIDC_REDIRECT_URI');
  const postLogoutRedirectUri = required('OIDC_POST_LOGOUT_REDIRECT_URI');
  const sessionCookieSecure = requiredBoolean('SESSION_COOKIE_SECURE');

  // discovery/JWKS/token は Docker ネットワーク、認可・logout はブラウザから到達可能な公開 URL。
  const discoveryUrl = `${backchannelIssuer}/.well-known/openid-configuration`;
  const metadata = await fetch(discoveryUrl).then(async (response) => {
    if (!response.ok) throw new Error(`OIDC discovery 失敗: ${response.status}`);
    return response.json();
  });
  if (metadata.issuer !== issuer) throw new Error('OIDC_ISSUER と discovery の issuer が一致しません');
  const jwks = createRemoteJWKSet(new URL(replaceOrigin(metadata.jwks_uri, issuer, backchannelIssuer)));

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(session({
    name: 'mfa_demo_session',
    secret: required('SESSION_SECRET'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: sessionCookieSecure, maxAge: 60 * 60 * 1000 }
  }));

  app.get('/health', (_request, response) => response.type('text').send('ok'));
  app.get('/', (request, response) => {
    const claims = request.session.claims;
    response.type('html').send(page(claims));
  });
  app.get('/login', (request, response) => {
    const state = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(32).toString('base64url');
    const verifier = crypto.randomBytes(64).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    request.session.oidc = { state, nonce, verifier };
    const authorizationUrl = new URL(metadata.authorization_endpoint);
    authorizationUrl.search = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      scope: 'openid profile email',
      redirect_uri: redirectUri,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    }).toString();
    response.redirect(authorizationUrl.toString());
  });
  app.get('/callback', async (request, response, next) => {
    try {
      const transaction = request.session.oidc;
      const returnedState = typeof request.query.state === 'string' ? Buffer.from(request.query.state) : undefined;
      const expectedState = transaction ? Buffer.from(transaction.state) : undefined;
      if (!transaction || !returnedState || !expectedState || returnedState.length !== expectedState.length || !crypto.timingSafeEqual(expectedState, returnedState)) {
        return response.status(400).type('text').send('ログイン応答の state を検証できません。最初からやり直してください。');
      }
      if (typeof request.query.error === 'string') return response.status(400).type('text').send('認証に失敗しました。');
      if (typeof request.query.code !== 'string') return response.status(400).type('text').send('認可コードがありません。');
      const tokenResponse = await fetch(replaceOrigin(metadata.token_endpoint, issuer, backchannelIssuer), {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code: request.query.code, redirect_uri: redirectUri, code_verifier: transaction.verifier })
      });
      if (!tokenResponse.ok) throw new Error(`token endpoint failed (${tokenResponse.status})`);
      const tokens = await tokenResponse.json();
      const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer, audience: clientId });
      if (payload.nonce !== transaction.nonce) throw new Error('nonce validation failed');
      await new Promise((resolve, reject) => request.session.regenerate((error) => error ? reject(error) : resolve()));
      request.session.claims = safeClaims(payload);
      response.redirect('/');
    } catch (error) { next(error); }
  });
  app.get('/logout', (request, response, next) => {
    request.session.destroy((error) => {
      if (error) return next(error);
      const logoutUrl = new URL(metadata.end_session_endpoint);
      logoutUrl.searchParams.set('client_id', clientId);
      logoutUrl.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
      response.redirect(logoutUrl.toString());
    });
  });
  app.use((error, _request, response, _next) => {
    console.error('request failed', error.message);
    response.status(500).type('text').send('処理に失敗しました。サーバーログを確認してください。');
  });
  app.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Web app listening'));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function page(claims) {
  const body = claims
    ? `<h1>ログイン済み</h1><p>検証済み ID token から、MFA 判定に役立つ claim だけを表示しています。</p><pre>${escapeHtml(JSON.stringify(claims, null, 2))}</pre><p><a href="/logout">ログアウト</a></p>`
    : '<h1>Keycloak TOTP サンプル</h1><p>初回ログインでは Keycloak が TOTP の QR コードを表示します。</p><p><a href="/login">ログイン</a></p>';
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Keycloak MFA demo</title><style>body{font-family:system-ui;max-width:48rem;margin:3rem auto;padding:0 1rem}pre{overflow:auto;background:#f5f5f5;padding:1rem;border-radius:.4rem}</style><body>${body}</body></html>`;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main().catch((error) => { console.error('startup failed', error.message); process.exit(1); });
}
