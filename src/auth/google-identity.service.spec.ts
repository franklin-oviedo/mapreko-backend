import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { AuthSettings } from './auth.settings.js';
import { GoogleIdentityService } from './google-identity.service.js';

describe('GoogleIdentityService (official cryptographic verifier)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const clientId = 'client.apps.googleusercontent.com';
  const nonce = randomBytes(32).toString('base64url');
  const settings = new AuthSettings(
    new ConfigService({
      GOOGLE_CLIENT_ID: clientId,
      GOOGLE_CLIENT_SECRET: randomBytes(32).toString('hex'),
      GOOGLE_REDIRECT_URI: 'http://localhost:4200/api/auth/google/callback',
    }),
  );
  const service = new GoogleIdentityService(settings);

  function sign(
    overrides: Record<string, unknown> = {},
    validSignature = true,
  ) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', kid: 'test-key' }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: clientId,
        sub: 'google-sub',
        email: 'person@example.test',
        email_verified: true,
        nonce,
        iat: now - 60,
        exp: now + 600,
        ...overrides,
      }),
    ).toString('base64url');
    const content = `${header}.${payload}`;
    const signature = validSignature
      ? createSign('RSA-SHA256')
          .update(content)
          .sign(privateKey)
          .toString('base64url')
      : randomBytes(256).toString('base64url');
    return `${content}.${signature}`;
  }

  beforeEach(() => {
    vi.spyOn(
      OAuth2Client.prototype,
      'getFederatedSignonCertsAsync',
    ).mockResolvedValue({
      certs: {
        'test-key': publicKey
          .export({ type: 'spki', format: 'pem' })
          .toString(),
      },
      format: 'PEM',
      res: null,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('accepts a signed, verified identity even when optional profile fields are absent', async () => {
    const token = sign();
    vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({
      tokens: { id_token: token },
      res: null,
    });
    expect(await service.exchange('code', 'verifier', nonce)).toEqual({
      subject: 'google-sub',
      email: 'person@example.test',
      givenName: null,
      familyName: null,
      avatarUrl: null,
    });
    const url = new URL(service.authorizationUrl('state', nonce, 'challenge'));
    expect(url.searchParams.get('code_challenge_method')).toBe(
      CodeChallengeMethod.S256,
    );
  });

  it.each([
    ['wrong audience', { aud: 'other-client' }, true],
    ['wrong issuer', { iss: 'https://attacker.example' }, true],
    [
      'expired even within Google clock tolerance',
      { exp: Math.floor(Date.now() / 1000) - 1 },
      true,
    ],
    ['unverified email', { email_verified: false }, true],
    ['nonce mismatch', { nonce: 'another-flow' }, true],
    ['invalid signature', {}, false],
  ])(
    'rejects %s without exposing Google credentials',
    async (_label, claims, validSignature) => {
      const token = sign(claims, validSignature);
      vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({
        tokens: { id_token: token },
        res: null,
      });
      await expect(
        service.exchange('code', 'verifier', nonce),
      ).rejects.toMatchObject({ status: 401 });
    },
  );
});
