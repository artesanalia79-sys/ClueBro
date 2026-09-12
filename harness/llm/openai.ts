import OpenAI from "openai";
import type { LlmClient, LlmRequest, LlmResponse } from "@contracts";

/**
 * The only file in this repo that imports a model vendor SDK.
 *
 * If you want a different provider, or the Responses API instead of chat
 * completions, this is the single file to change. Nothing in core/ or
 * adapters/ knows this file exists.
 */

export interface OpenAiOptions {
  apiKey: string;
  model: string;
  /** Any OpenAI-compatible endpoint (OpenRouter, a local server). */
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export function createOpenAiLlm(options: OpenAiOptions): LlmClient {
  const client = new OpenAI({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    // The SDK's bundled HTTP client drops the connection against some
    // OpenAI-compatible endpoints ("Premature close"). Node's own fetch
    // talks to all of them, so use it.
    fetch: globalThis.fetch,
    // Short and shallow on purpose: in a live channel a slow reply is worse
    // than no reply, and a retry storm is worse than both.
    timeout: options.timeoutMs ?? 20_000,
    maxRetries: options.maxRetries ?? 1,
  });

  return {
    name: "openai",
    model: options.model,

    async complete(req: LlmRequest): Promise<LlmResponse> {
      const started = Date.now();
      try {
        const completion = await client.chat.completions.create({
          model: options.model,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
          ...(req.json ? { response_format: { type: "json_object" as const } } : {}),
          ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
          ...(req.maxTokens === undefined ? {} : { max_completion_tokens: req.maxTokens }),
        });

        return {
          text: completion.choices[0]?.message?.content ?? "",
          model: completion.model ?? options.model,
          latencyMs: Date.now() - started,
        };
      } catch (err) {
        // An empty body makes every caller fall back to its own default, and
        // the caller records the failure. The agent goes quiet, it does not
        // crash the process in the middle of a demo.
        const message = err instanceof Error ? err.message : String(err);
        return {
          text: JSON.stringify({ error: message }),
          model: `${options.model} (failed)`,
          latencyMs: Date.now() - started,
        };
      }
    },
  };
}
