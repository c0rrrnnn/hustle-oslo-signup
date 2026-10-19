import { handleRequest } from "./handler.ts";
import { retryUnpostedBookings } from "./sheet-sync.ts";
import type { Env } from "./types.ts";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, {
      waitUntil: (promise) => ctx.waitUntil(promise),
    });
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(retryUnpostedBookings(env, { now: () => new Date(controller.scheduledTime) }));
  },
};
