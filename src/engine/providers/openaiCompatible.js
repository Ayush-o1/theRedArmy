// Adapter for any server that implements the OpenAI Chat Completions API:
// OpenAI itself, and many other hosted or local servers (Groq, OpenRouter,
// Ollama, LM Studio, vLLM) that copy that API shape.
import { config } from '../../config.js';
import { decrypt } from '../../lib/crypto.js';
import { parseRetryAfter } from '../backoff.js';
import { ProviderError, isRetryableStatus } from './providerError.js';
import { assertSafeProviderUrl, UnsafeUrlError } from './urlGuard.js';

export function createOpenAiCompatibleProvider(providerConfig) {
  return {
    async complete({ systemPrompt, prompt, temperature, maxTokens, signal }) {
      let base;
      try {
        // Re-checked at call time, not only when saved: DNS can change.
        base = await assertSafeProviderUrl(providerConfig.baseUrl, {
          allowPrivate: config.ALLOW_PRIVATE_PROVIDER_URLS,
        });
      } catch (err) {
        if (err instanceof UnsafeUrlError) throw new ProviderError(err.message, { retryable: false });
        throw err;
      }

      const headers = { 'content-type': 'application/json' };
      if (providerConfig.apiKeyCiphertext) {
        headers.authorization = `Bearer ${decrypt(providerConfig.apiKeyCiphertext)}`;
      }
      const messages = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      messages.push({ role: 'user', content: prompt });

      let response;
      try {
        response = await fetch(
          new URL('chat/completions', base.href.endsWith('/') ? base : `${base.href}/`),
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: providerConfig.model,
              messages,
              temperature,
              max_tokens: maxTokens,
            }),
            signal,
            redirect: 'error', // a redirect could bypass the SSRF check
          },
        );
      } catch (err) {
        // Network failures and timeouts are usually transient.
        throw new ProviderError(
          `Request failed: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`,
          {
            retryable: true,
          },
        );
      }

      if (!response.ok) {
        // Read a bounded amount of the error body for debugging; never echo headers.
        const body = (await response.text().catch(() => '')).slice(0, 500);
        throw new ProviderError(`Provider returned HTTP ${response.status}: ${body}`, {
          retryable: isRetryableStatus(response.status),
          status: response.status,
          retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
        });
      }

      const data = await response.json().catch(() => null);
      const output = data?.choices?.[0]?.message?.content;
      if (typeof output !== 'string') {
        throw new ProviderError('Provider response did not contain choices[0].message.content', {
          retryable: false,
        });
      }
      return {
        output,
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      };
    },
  };
}
