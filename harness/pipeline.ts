import {
  ContextEventSchema,
  makeResult,
  type ActionEngine,
  type ActionResult,
  type Clock,
  type Detector,
  type InboundAdapter,
  type Logger,
  type OutboundAdapter,
} from "@contracts";
import type { DecisionLog } from "./observability";
import { WindowStore, type WindowStoreConfig } from "./window";

/**
 * The only place in the repo where the four pieces meet.
 *
 *   inbound adapter -> window -> detector -> action engine -> outbound adapter
 *
 * Read this file to understand the system. Everything else is a leaf.
 */

export interface PipelineDeps {
  inbound: InboundAdapter;
  outbound: OutboundAdapter;
  detector: Detector;
  actionEngine: ActionEngine;
  decisionLog: DecisionLog;
  log: Logger;
  clock: Clock;
  config: {
    window: WindowStoreConfig;
    dryRun: boolean;
  };
}

export async function runPipeline(deps: PipelineDeps): Promise<void> {
  const windows = new WindowStore(deps.config.window);

  await deps.inbound.start?.();
  deps.log.info("pipeline running", {
    inbound: deps.inbound.name,
    outbound: deps.outbound.name,
    detector: `${deps.detector.name}@${deps.detector.version}`,
    engine: `${deps.actionEngine.name}@${deps.actionEngine.version}`,
    dry_run: deps.config.dryRun,
  });

  for await (const raw of deps.inbound.stream()) {
    const t0 = Date.now();

    // An adapter that emits a malformed event gets a loud, specific error
    // instead of a mystery crash three layers down.
    const parsed = ContextEventSchema.safeParse(raw);
    if (!parsed.success) {
      deps.log.error(`adapter ${deps.inbound.name} emitted an invalid ContextEvent`, {
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
      continue;
    }
    const event = parsed.data;

    // The agent never reacts to itself or to other bots. Without this the
    // first reply starts a loop that ends the demo.
    if (event.actor.is_agent) {
      deps.log.debug("ignoring agent message", { event_id: event.event_id });
      continue;
    }

    // On a replay this pins policy time to the conversation's own time, so a
    // cooldown measured in minutes is not swallowed by a run that takes
    // twenty seconds.
    deps.clock.advanceTo?.(new Date(event.occurred_at));

    const window = windows.push(event);
    const traceId = `trc_${event.source.adapter}_${event.event_id}`;

    // One bad event must not end the conversation. A live channel does not
    // stop producing messages because the model returned something the parser
    // hated, and an agent that dies mid-session dies silently -- which is the
    // one failure this product cannot have.
    const tDetectStart = Date.now();
    let observations;
    try {
      observations = await deps.detector.observe(window, {
        surfaceId: event.source.surface_id,
        surfaceType: event.source.surface_type,
        triggerEventId: event.event_id,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log.error(`detector ${deps.detector.name} threw, skipping this event`, {
        event_id: event.event_id,
        error: message,
      });
      deps.decisionLog.noteFailure({ eventId: event.event_id, stage: "detect", error: message });
      continue;
    }
    const detectMs = Date.now() - tDetectStart;

    if (observations.length === 0) {
      deps.log.warn("detector returned nothing, which hides a decision", {
        event_id: event.event_id,
      });
      continue;
    }

    for (const observation of observations) {
      try {
        const tDecideStart = Date.now();
        const decision = await deps.actionEngine.decide(observation, window);
        const decideMs = Date.now() - tDecideStart;

        let result: ActionResult;
        let deliverMs = 0;

        if (!decision.act) {
          result = makeResult({ decision, status: "skipped_no_action" });
        } else if (deps.config.dryRun) {
          result = makeResult({
            decision,
            status: "dry_run",
            adapter: deps.outbound.name,
          });
        } else {
          const tDeliverStart = Date.now();
          result = await deps.outbound.deliver(decision);
          deliverMs = Date.now() - tDeliverStart;
          if (result.status === "delivered") {
            deps.actionEngine.noteDelivered?.(event.source.surface_id, deps.clock.now());
          }
        }

        deps.decisionLog.write({
          traceId,
          event,
          observation,
          decision,
          result,
          timings: {
            detect: detectMs,
            decide: decideMs,
            deliver: deliverMs,
            total: Date.now() - t0,
          },
        });
      } catch (err) {
        // Includes a delivery that threw instead of returning a failed
        // ActionResult, and a record the contract refused. Both are bugs
        // somewhere else, and neither is worth ending the session over.
        const message = err instanceof Error ? err.message : String(err);
        deps.log.error("deciding this observation threw, moving on", {
          event_id: event.event_id,
          observation_id: observation.observation_id,
          error: message,
        });
        deps.decisionLog.noteFailure({
          eventId: event.event_id,
          stage: "decide",
          error: message,
        });
      }
    }
  }

  await deps.inbound.stop?.();
  deps.log.info("inbound stream finished");
}
