// EventSub WebSocket wire shapes (dev.twitch.tv/docs/eventsub/websocket-reference and
// handling-websocket-events, checked 31 Oct 2026). Only the fields ComicToons reads are typed.

export type EventSubMessageType = 'session_welcome' | 'session_keepalive' | 'notification' | 'session_reconnect' | 'revocation';

export interface EventSubMetadata {
  message_id: string;
  message_type: EventSubMessageType;
  message_timestamp: string;
  subscription_type?: string;
  subscription_version?: string;
}

export interface EventSubSession {
  id: string;
  status: 'connected' | 'reconnecting' | string;
  keepalive_timeout_seconds: number | null;
  reconnect_url: string | null;
  connected_at?: string;
}

export interface EventSubSubscriptionInfo {
  id: string;
  status: string;
  type: string;
  version: string;
  cost?: number;
  condition: Record<string, string>;
  transport?: { method: string; session_id?: string };
  created_at?: string;
}

export interface EventSubMessage {
  metadata: EventSubMetadata;
  payload: {
    session?: EventSubSession;
    subscription?: EventSubSubscriptionInfo;
    event?: Record<string, unknown>;
  };
}

/** One subscription to create on a session (POST /helix/eventsub/subscriptions). */
export interface SubscriptionRequest {
  type: string;
  version: string;
  condition: Record<string, string>;
  /** Scopes from the subscription-types page; informational, Twitch enforces them. */
  scopes: string[];
}

/** Creates one subscription for a WebSocket session. The real one is twitch-api/helix.ts. */
export interface SubscriptionCreator {
  createEventSubSubscription(input: { type: string; version: string; condition: Record<string, string>; sessionId: string }): Promise<{ id: string }>;
}

/** A revoked subscription, as the studio shows it. `status` is Twitch's reason. */
export interface Revocation { type: string; version: string; status: string; at: number }

/** What the studio may show about the live link. Never carries tokens; errors are fixed ComicToons text, never Twitch's own wording. */
export interface EventSubStatus {
  /** 'revoked': Twitch withdrew the broadcaster's authorization (authorization_revoked); sign in again. */
  state: 'idle' | 'connecting' | 'welcomed' | 'subscribed' | 'reconnecting' | 'revoked' | 'stopped';
  sessionId?: string;
  keepaliveSeconds?: number;
  subscribed: string[];
  failed: { type: string; error: string }[];
  revoked: Revocation[];
  reconnects: number;
  notifications: number;
  lastError?: string;
}

/** Plain text in, close codes out. Implemented by socket.ts; tests inject a fake. */
export interface EventSubSocket {
  onmessage?: (text: string) => void;
  onclose?: (code: number, reason: string) => void;
  onerror?: (error: Error) => void;
  close(code?: number): void;
}
export type SocketFactory = (url: string) => EventSubSocket;
