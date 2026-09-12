import type { InboundAdapter, OutboundAdapter } from "@contracts";
import { createSlackInbound, type SlackInboundOptions } from "./inbound";
import { createSlackOutbound } from "./outbound";

export interface SlackAdapter {
  inbound: InboundAdapter;
  outbound: OutboundAdapter;
}

/**
 * One Socket Mode connection shared by both directions, so the agent reads
 * and writes as the same identity.
 */
export function createSlackAdapter(options: SlackInboundOptions): SlackAdapter {
  const inbound = createSlackInbound(options);
  const outbound = createSlackOutbound({ app: inbound.app });
  return { inbound, outbound };
}

export { createSlackInbound, toContextEvent, toPlainText, mentionsIn } from "./inbound";
export { createSlackOutbound, formatMessage } from "./outbound";
