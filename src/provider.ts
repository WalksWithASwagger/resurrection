/**
 * The model provider boundary (docs/SPEC.md section 6).
 *
 * Generation talks to a model only through this interface, so the loop is
 * tested against a scripted provider and nothing in the engine depends on a
 * particular service. A live provider is constructed explicitly by the CLI,
 * behind a spend confirmation; no code path creates one by default.
 */

export interface ModelImage {
  mediaType: 'image/png';
  /** Base64, no newlines. */
  data: string;
}

export interface ModelMessage {
  role: 'user' | 'assistant';
  text: string;
  /** Sent before the text. User messages only. */
  images?: ModelImage[];
}

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  maxOutputTokens: number;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelResponse {
  text: string;
  usage: ModelUsage;
  /** The model that actually answered, which can differ after a fallback. */
  servedBy: string;
  /** The model declined. `text` is then not a usable answer. */
  refused: boolean;
  /** The answer hit the output cap and is incomplete. */
  truncated: boolean;
}

export interface ModelProvider {
  /** Recorded with every patch, e.g. `anthropic:claude-opus-5-5`. */
  readonly id: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export type ScriptedAnswer = string | { text: string; refused?: boolean };

/**
 * A provider that replays chosen answers. It calls nothing and costs nothing;
 * usage is derived from text length so budget logic has numbers to count.
 */
export function createScriptedProvider(
  answer: (request: ModelRequest, callIndex: number) => ScriptedAnswer,
): ModelProvider & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    id: 'scripted',
    requests,
    async complete(request) {
      requests.push(request);
      const result = answer(request, requests.length - 1);
      const text = typeof result === 'string' ? result : result.text;
      const promptLength = request.system.length + request.messages.reduce((total, message) => total + message.text.length, 0);
      return {
        text,
        usage: { inputTokens: Math.ceil(promptLength / 4), outputTokens: Math.ceil(text.length / 4) },
        servedBy: 'scripted',
        refused: typeof result === 'string' ? false : (result.refused ?? false),
        truncated: false,
      };
    },
  };
}
