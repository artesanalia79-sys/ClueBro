import OpenAI from "openai";
import type { LlmClient, LlmRequest, LlmResponse, Logger } from "@contracts";

/**
 * Marks a response that came back from the error path. The decision log reads
 * this to say on screen that a block ran without the model, because a silent
 * fallback to regex is exactly the kind of invisible decision this product
 * exists to refuse.
 */
export const FAILED_SUFFIX = "(failed)";

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
  /** Any OpenAI-compatible endpoint. Passed explicitly so config.ts stays the
   *  only thing that reads the environment: the SDK would otherwise pick
   *  OPENAI_BASE_URL up behind our back. */
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** So a failing model is reported once, out loud, instead of silently
   *  degrading every decision to the heuristic prefilter. */
  log?: Logger;
}

export function createOpenAiLlm(options: OpenAiOptions): LlmClient {
  const client = new OpenAI({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    // Short and shallow on purpose: in a live channel a slow reply is worse
    // than no reply, and a retry storm is worse than both.
    timeout: options.timeoutMs ?? 20_000,
    maxRetries: options.maxRetries ?? 1,
  });

  // One line per distinct failure, not one per call. Eleven copies of the same
  // message is how a real problem gets scrolled past.
  const reported = new Set<string>();
  const reportOnce = (message: string): void => {
    if (reported.has(message)) return;
    reported.add(message);
    options.log?.warn("model call failed, falling back to heuristics", { error: message });
  };

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
        reportOnce(message);
        return {
          text: JSON.stringify({ error: message }),
          model: `${options.model} ${FAILED_SUFFIX}`,
          latencyMs: Date.now() - started,
        };
      }
    },
  };
}
