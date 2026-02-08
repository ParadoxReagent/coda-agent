/**
 * Request correlation context using AsyncLocalStorage.
 * Propagates correlationId and userId through the async call stack.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { generateEventId } from "../utils/id.js";

export interface RequestContext {
  correlationId: string;
  userId?: string;
  channel?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function withContext<T>(
  ctx: RequestContext,
  fn: () => Promise<T>
): Promise<T> {
  return requestContext.run(ctx, fn);
}

export function getCurrentContext(): RequestContext | undefined {
  return requestContext.getStore();
}

export function createCorrelationId(): string {
  return generateEventId();
}
