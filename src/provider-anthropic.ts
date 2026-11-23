/**
 * The Anthropic provider.
 *
 * Every call here spends money, so this module is imported only by the CLI's
 * `modernize` command after an explicit spend confirmation. The SDK resolves
 * credentials from the environment; this code never reads or prints a key.
 *
 * Requests stream, because a rewritten page can be long. Thinking is left to
 * the model's default (adaptive) and depth is set through effort. A policy
 * decline is retried server-side on the provider's recommended fallback
 * model, and the model that actually answered is recorded.
 */

import type { ModelProvider, ModelRequest, ModelResponse } from './provider.ts';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicProviderOptions {
  model?: string;
  effort?: AnthropicEffort;
}

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export async function createAnthropicProvider(options: AnthropicProviderOptions = {}): Promise<ModelProvider> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  const model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
  const effort = options.effort ?? 'high';

  return {
    id: `anthropic:${model}`,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const stream = client.beta.messages.stream({
        model,
        max_tokens: request.maxOutputTokens,
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
        output_config: { effort },
        // The system prompt and the first user turn repeat across repair attempts.
        cache_control: { type: 'ephemeral' },
        system: request.system,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: [
            ...(message.images ?? []).map((image) => ({
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: image.mediaType, data: image.data },
            })),
            { type: 'text' as const, text: message.text },
          ],
        })),
      });
      const message = await stream.finalMessage();

      let text = '';
      for (const block of message.content) {
        if (block.type === 'text') text += block.text;
      }
      return {
        text,
        usage: {
          inputTokens:
            message.usage.input_tokens +
            (message.usage.cache_creation_input_tokens ?? 0) +
            (message.usage.cache_read_input_tokens ?? 0),
          outputTokens: message.usage.output_tokens,
        },
        servedBy: message.model,
        refused: message.stop_reason === 'refusal',
        truncated: message.stop_reason === 'max_tokens',
      };
    },
  };
}
