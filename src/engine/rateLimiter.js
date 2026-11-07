// Per-provider token bucket shared by every worker process.
//
// Why Redis and not an in-memory counter? With 3 workers each allowed
// 60 requests/minute in memory, the provider would actually see 180/minute.
// The bucket has to live in one shared place, and the check-and-take has to be
// atomic. A Lua script runs atomically inside Redis, so two workers can never
// both take the last token.
import { redis } from '../redis.js';

// KEYS[1] = bucket key
// ARGV[1] = capacity (max burst), ARGV[2] = refill rate in tokens per ms
// Returns 0 if a token was taken, otherwise the number of ms to wait.
// Uses Redis server TIME so worker clock differences do not matter.
const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1]) or capacity
local ts = tonumber(state[2]) or now
tokens = math.min(capacity, tokens + (now - ts) * refill_per_ms)
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
else
  wait = math.ceil((1 - tokens) / refill_per_ms)
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / refill_per_ms) + 1000)
return wait
`;

redis.defineCommand('takeToken', { numberOfKeys: 1, lua: TOKEN_BUCKET_LUA });

// Allows a short burst (one tenth of the per-minute limit), then a steady rate.
export function bucketParams(requestsPerMinute) {
  return {
    capacity: Math.max(1, Math.ceil(requestsPerMinute / 10)),
    refillPerMs: requestsPerMinute / 60_000,
  };
}

/** @returns {Promise<number>} 0 when allowed, otherwise milliseconds to wait. */
export async function takeProviderToken(providerConfigId, requestsPerMinute) {
  const { capacity, refillPerMs } = bucketParams(requestsPerMinute);
  return Number(await redis.takeToken(`bucket:provider:${providerConfigId}`, capacity, refillPerMs));
}
