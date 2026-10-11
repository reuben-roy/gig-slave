import { EventEmitter } from "node:events";

// Channels: "event" (Event), "session" (Session), "invite" (Invite).
export const bus = new EventEmitter();
bus.setMaxListeners(0);
