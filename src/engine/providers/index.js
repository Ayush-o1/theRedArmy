import { createSimulatedProvider } from './simulated.js';
import { createOpenAiCompatibleProvider } from './openaiCompatible.js';

const factories = {
  SIMULATED: createSimulatedProvider,
  OPENAI_COMPATIBLE: createOpenAiCompatibleProvider,
};

export function createProvider(providerConfig) {
  const factory = factories[providerConfig.kind];
  if (!factory) throw new Error(`Unknown provider kind: ${providerConfig.kind}`);
  return factory(providerConfig);
}

export function estimateCostUsd(providerConfig, inputTokens, outputTokens) {
  return (
    (inputTokens * providerConfig.inputCostPerMTok + outputTokens * providerConfig.outputCostPerMTok) /
    1_000_000
  );
}
