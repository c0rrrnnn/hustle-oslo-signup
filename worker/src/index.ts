import { handleRequest, reconcilePayments } from "./handler.ts";
import type { Env } from "./types.ts";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, {
      waitUntil: (promise) => ctx.waitUntil(promise),
    });
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(reconcilePayments(env, { now: () => new Date(controller.scheduledTime) }));
  },
};
