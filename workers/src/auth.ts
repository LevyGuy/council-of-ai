import * as jose from 'jose';
import type { Env } from './types.ts';

export interface AuthPayload {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
}

/**
 * Validates an Auth0 Bearer JWT from the request's Authorization header.
 * Uses Auth0's JWKS endpoint and the Web Crypto API (via jose).
 * Throws if the token is missing, malformed, or invalid.
 */
export async function validateToken(request: Request, env: Env): Promise<AuthPayload> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing or invalid Authorization header');
  }

  const token = authHeader.slice(7);

  // Fetch the public key set from Auth0 (cached by the jose library)
  const JWKS = jose.createRemoteJWKSet(
    new URL(`https://${env.AUTH0_DOMAIN}/.well-known/jwks.json`),
  );

  const { payload } = await jose.jwtVerify(token, JWKS, {
    issuer: `https://${env.AUTH0_DOMAIN}/`,
    audience: env.AUTH0_AUDIENCE,
  });

  if (!payload.sub) {
    throw new Error('JWT missing sub claim');
  }

  return {
    sub: payload.sub,
    email: payload['email'] as string | undefined,
    name: payload['name'] as string | undefined,
    picture: payload['picture'] as string | undefined,
  };
}
