import { App, LogLevel } from "@slack/bolt";
import { ContextEventSchema, type ContextEvent, type InboundAdapter } from "@contracts";
import { AsyncQueue } from "../shared/queue";

/**
 * Slack -> ContextEvent.
 *
 * Everything Slack-shaped stops here. The core downstream cannot tell a Slack
 * message from a meeting caption.
 *
 * Passive by design: this listens to channel and DM history. It does not
 * subscribe to app_mention, and there are no slash commands. Nobody invokes
 * the agent.
 */

export interface SlackInboundOptions {
  botToken: string;
  appToken: string;
  /** Empty means every channel the bot has been invited to. */
  allowedChannels: string[];
  debug?: boolean;
}

/** The subset of a Slack message event this adapter relies on. */
interface SlackMessageLike {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  team?: string;
}

const MENTION = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;
const LINK = /<(https?:\/\/[^|>]+)(?:\|([^>]*))?>/g;
const CHANNEL_REF = /<#[A-Z0-9]+(?:\|([^>]*))?>/g;

/** Slack markup out, plain text in. The core should never see angle brackets. */
export function toPlainText(text: string): string {
  return text
    .replace(MENTION, "")
    .replace(CHANNEL_REF, (_m, name: string | undefined) => (name ? `#${name}` : ""))
    .replace(LINK, (_m, url: string, label: string | undefined) => label ?? url)
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export const mentionsIn = (text: string): string[] =>
  [...text.matchAll(MENTION)].map((m) => m[1]).filter((id): id is string => Boolean(id));

export function toContextEvent(input: {
  message: SlackMessageLike;
  botUserId: string | undefined;
  displayName: string;
  surfaceLabel: string | undefined;
}): ContextEvent | null {
  const { message, botUserId } = input;
  if (!message.channel || !message.ts) return null;

  // Joins, leaves, edits, pins and file comments are not conversation.
  if (message.subtype && message.subtype !== "bot_message") return null;

  const text = toPlainText(message.text ?? "");
  if (text.length === 0) return null;

  const actorId = message.user ?? message.bot_id ?? "unknown";
  const isAgent = Boolean(message.bot_id) || message.subtype === "bot_message" || actorId === botUserId;

  return ContextEventSchema.parse({
    schema_version: "1.0.0",
    event_id: `slack:${message.channel}:${message.ts}`,
    source: {
      adapter: "slack",
      surface_id: message.channel,
      surface_type: message.channel_type === "im" ? "direct" : "group",
      ...(input.surfaceLabel ? { surface_label: input.surfaceLabel } : {}),
    },
    actor: {
      actor_id: actorId,
      display_name: input.displayName,
      is_agent: isAgent,
    },
    occurred_at: new Date(Number(message.ts) * 1000).toISOString(),
    text,
    thread_id: message.thread_ts ?? null,
    reply_to_event_id: message.thread_ts ? `slack:${message.channel}:${message.thread_ts}` : null,
    mentions: mentionsIn(message.text ?? ""),
    metadata: {
      slack_ts: message.ts,
      slack_thread_ts: message.thread_ts ?? null,
      slack_channel_type: message.channel_type ?? null,
      slack_team: message.team ?? null,
    },
  } satisfies Record<string, unknown>);
}

export interface SlackInbound extends InboundAdapter {
  /** Exposed so the outbound side can share one authenticated client. */
  app: App;
}

export function createSlackInbound(options: SlackInboundOptions): SlackInbound {
  const app = new App({
    token: options.botToken,
    appToken: options.appToken,
    socketMode: true,
    logLevel: options.debug ? LogLevel.DEBUG : LogLevel.WARN,
  });

  const queue = new AsyncQueue<ContextEvent>();
  const nameCache = new Map<string, string>();
  const channelCache = new Map<string, string>();
  let botUserId: string | undefined;

  const displayNameFor = async (userId: string | undefined): Promise<string> => {
    if (!userId) return "unknown";
    const cached = nameCache.get(userId);
    if (cached) return cached;
    try {
      const res = await app.client.users.info({ user: userId });
      const name =
        res.user?.profile?.display_name?.trim() || res.user?.real_name?.trim() || res.user?.name || userId;
      nameCache.set(userId, name);
      return name;
    } catch {
      // A missing users:read scope should degrade the logs, not stop the agent.
      nameCache.set(userId, userId);
      return userId;
    }
  };

  const labelFor = async (channelId: string, channelType: string | undefined): Promise<string | undefined> => {
    if (channelType === "im") return undefined;
    const cached = channelCache.get(channelId);
    if (cached) return cached;
    try {
      const res = await app.client.conversations.info({ channel: channelId });
      const label = res.channel?.name ? `#${res.channel.name}` : channelId;
      channelCache.set(channelId, label);
      return label;
    } catch {
      return channelId;
    }
  };

  app.event("message", async ({ event, context }) => {
    const message = event as unknown as SlackMessageLike;
    botUserId = context.botUserId ?? botUserId;

    if (
      options.allowedChannels.length > 0 &&
      message.channel &&
      message.channel_type !== "im" &&
      !options.allowedChannels.includes(message.channel)
    ) {
      return;
    }

    const contextEvent = toContextEvent({
      message,
      botUserId,
      displayName: await displayNameFor(message.user),
      surfaceLabel: message.channel ? await labelFor(message.channel, message.channel_type) : undefined,
    });

    if (contextEvent) queue.push(contextEvent);
  });

  return {
    name: "slack",
    app,
    async start() {
      await app.start();
    },
    stream() {
      return queue;
    },
    async stop() {
      queue.close();
      await app.stop();
    },
  };
}
