import * as jose from 'jose';
import type { Env } from './types.ts';

export interface AuthPayload {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
}

/**
 * Validates an Auth0 ID token (Bearer JWT) from the request's Authorization
 * header.  The frontend sends the ID token rather than an access token, which
 * avoids the need to create and authorize a custom Auth0 API resource.
 *
 * ID-token audience claim == the Auth0 SPA client ID.
 */
export async function validateToken(request: Request, env: Env): Promise<AuthPayload> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing or invalid Authorization header');
  }

  const token = authHeader.slice(7);

  const JWKS = jose.createRemoteJWKSet(
    new URL(`https://${env.AUTH0_DOMAIN}/.well-known/jwks.json`),
  );

  const { payload } = await jose.jwtVerify(token, JWKS, {
    issuer: `https://${env.AUTH0_DOMAIN}/`,
    audience: env.AUTH0_CLIENT_ID, // ID token aud == client ID
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
