'use strict';

const { SignJWT, jwtVerify } = require('jose');
const { getJwtSecret } = require('./ssm');

const ISSUER = 'loxberry-alexa';
const AUDIENCE = 'loxberry-alexa-skill';
const ACCESS_TOKEN_TTL = '1h';

async function getKey() {
  const secret = await getJwtSecret();
  return new TextEncoder().encode(secret);
}

async function signAccessToken({ userId }) {
  if (!userId) throw new Error('userId is required to sign an access token');
  const key = await getKey();
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .sign(key);
}

async function verifyAccessToken(token) {
  const key = await getKey();
  const { payload } = await jwtVerify(token, key, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  if (!payload.sub) throw new Error('Token has no subject');
  return { userId: payload.sub, payload };
}

module.exports = { signAccessToken, verifyAccessToken, ACCESS_TOKEN_TTL };
