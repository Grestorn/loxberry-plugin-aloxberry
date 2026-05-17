'use strict';

const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

let _ssmClient;
function getSsmClient() {
  if (!_ssmClient) _ssmClient = new SSMClient({});
  return _ssmClient;
}

// Module-scope cache: SecureString fetches survive across warm invocations,
// but we rotate after CACHE_TTL_MS so a manual rotation in SSM eventually
// propagates without redeploying the function.
const CACHE_TTL_MS = 5 * 60 * 1000;
const _cache = new Map();

async function getSecureParam(name) {
  const cached = _cache.get(name);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const cmd = new GetParameterCommand({ Name: name, WithDecryption: true });
  const res = await getSsmClient().send(cmd);
  const value = res.Parameter && res.Parameter.Value;
  if (!value) throw new Error(`SSM parameter ${name} is missing or empty`);

  _cache.set(name, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

async function getJwtSecret() {
  const paramName = process.env.JWT_SECRET_PARAM;
  if (!paramName) throw new Error('JWT_SECRET_PARAM env var is not set');
  return getSecureParam(paramName);
}

module.exports = { getSecureParam, getJwtSecret };
