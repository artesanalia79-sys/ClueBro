import type { ActionDecision } from "./action-decision";
import type { ActionResult } from "./action-result";
import type { ContextEvent } from "./context-event";
import type { Observation } from "./observation";

/**
 * The seams of the system. Every component depends only on these types, and
 * the harness is the only place that knows which implementation is behind
 * each one.
 *
 * THIS FILE IS FROZEN after the first integration checkpoint. Changing it
 * changes everyone's world at once, so it changes only with the team present.
 */

/** Produces ContextEvents from some surface. Slack, a browser, a file. */
export interface InboundAdapter {
  readonly name: string;
  start?(): Promise<void>;
  /** Yields events until the process is stopped or the source is exhausted. */
  stream(): AsyncIterable<ContextEvent>;
  stop?(): Promise<void>;
}

/** Delivers a decision back to some surface. */
export interface OutboundAdapter {
  readonly name: string;
  deliver(decision: ActionDecision): Promise<ActionResult>;
}

export interface WindowContext {
  surfaceId: string;
  surfaceType: string;
  /** The event that caused this detection pass. Always the last in the window. */
  triggerEventId: string;
}

/** Perception: what is happening in this conversation? */
export interface Detector {
  readonly name: string;
  readonly version: string;
  observe(window: readonly ContextEvent[], ctx: WindowContext): Promise<Observation[]>;
}

/** Judgement plus composition: should we speak, to whom, and saying what? */
export interface ActionEngine {
  readonly name: string;
  readonly version: string;
  decide(observation: Observation, window: readonly ContextEvent[]): Promise<ActionDecision>;
  /** Called by the harness after a real delivery, so cooldown state is honest. */
  noteDelivered?(surfaceId: string, at: Date): void;
}

export interface LlmRequest {
  system: string;
  user: string;
  /** Ask the provider for a JSON object back. Detectors always want this. */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  /**
   * Which prompt produced `system`. Carried so logs can attribute cost and
   * latency per prompt, and so the fake provider can answer deterministically
   * without guessing from the prose.
   */
  promptId?: string;
}

export interface LlmResponse {
  text: string;
  model: string;
  latencyMs: number;
}

/**
 * The core never constructs an LLM client and never imports a vendor SDK.
 * It receives one of these.
 */
export interface LlmClient {
  readonly name: string;
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** A prompt read from /prompts at runtime, never inlined in code. */
export interface LoadedPrompt {
  id: string;
  version: string;
  body: string;
  /** Fills {{placeholders}} in the prompt body. */
  render(vars: Record<string, string>): string;
}

export interface PromptRegistry {
  get(id: string, version?: string): LoadedPrompt;
  activeVersion(id: string): string;
  versions(id: string): string[];
}

export interface Clock {
  now(): Date;
  /**
   * Replay only. Pins "now" to the event being processed, so time-based
   * policy (cooldown, dedupe) behaves the same on a recorded conversation as
   * it did live. Undefined on a real clock.
   */
  advanceTo?(at: Date): void;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/** What detection and action receive from the harness. Nothing else. */
export interface CoreDeps {
  llm: LlmClient;
  prompts: PromptRegistry;
  clock: Clock;
  log: Logger;
}
