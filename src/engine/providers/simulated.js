// A fake model for demos and tests. It costs nothing, needs no API key, and can
// inject latency and failures on demand. That is how the retry, rate-limit and
// recovery paths are tested deterministically.
//
// It is NOT a language model. It "answers" by echoing the prompt (or wrapping
// it in JSON), so it exercises the pipeline but cannot tell you whether a real
// prompt is good. Use an OpenAI-compatible provider for that.
import { ProviderError } from './providerError.js';

const estimateTokens = (text) => Math.max(1, Math.ceil(text.length / 4));
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new ProviderError('Simulated request timed out', { retryable: true }));
    });
  });

export function createSimulatedProvider(providerConfig) {
  const settings = {
    latencyMs: 100,
    mode: 'echo', // 'echo' | 'json'
    rateLimitRate: 0, // probability of returning 429
    errorRate: 0, // probability of returning 503
    failUntilAttempt: 0, // deterministic: fail with 503 while attempt <= this
    ...providerConfig.settings,
  };

  return {
    async complete({ systemPrompt, prompt, maxTokens, attempt, signal }) {
      await sleep(settings.latencyMs, signal);

      if (attempt <= settings.failUntilAttempt) {
        throw new ProviderError(`Simulated 503 on attempt ${attempt}`, { retryable: true, status: 503 });
      }
      if (Math.random() < settings.rateLimitRate) {
        throw new ProviderError('Simulated 429 rate limit', {
          retryable: true,
          status: 429,
          retryAfterMs: 500,
        });
      }
      if (Math.random() < settings.errorRate) {
        throw new ProviderError('Simulated 503 service unavailable', { retryable: true, status: 503 });
      }

      let output = settings.mode === 'json' ? JSON.stringify({ input: prompt }) : prompt;
      // Mimic max_tokens truncation so length assertions behave realistically.
      output = output.slice(0, maxTokens * 4);
      return {
        output,
        inputTokens: estimateTokens(systemPrompt + prompt),
        outputTokens: estimateTokens(output),
      };
    },
  };
}
