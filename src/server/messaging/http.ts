import type { IncomingHttpHeaders } from 'node:http';
import type { EventEmitter } from 'node:events';
import type { SerializeOptions } from '@fastify/cookie';

/** The message routes need only these HTTP operations on either runtime. */
export interface MessagingRequest {
  url: string;
  method: string;
  headers: IncomingHttpHeaders;
  cookies: Record<string, string | undefined>;
  params: unknown;
  query: unknown;
  body: unknown;
  clientAddress(): string;
}
export interface MessagingReply {
  raw: Pick<EventEmitter, 'once' | 'off'>;
  header(name: string, value: string): MessagingReply;
  code(status: number): MessagingReply;
  type(mime: string): MessagingReply;
  send(value?: unknown): unknown;
  redirect(url: string): unknown;
  setCookie(name: string, value: string, options: SerializeOptions): MessagingReply;
  clearCookie(name: string, options: SerializeOptions): MessagingReply;
}
export type MessageHandler = (request: MessagingRequest, reply: MessagingReply) => unknown;
export interface MessageRoute {
  (path: string, handler: MessageHandler): void;
  (path: string, options: { bodyLimit: number }, handler: MessageHandler): void;
}
export interface MessagingHttp {
  get: MessageRoute;
  post: MessageRoute;
  put: MessageRoute;
  patch: MessageRoute;
  delete: MessageRoute;
  addHook(name: 'onRequest', handler: MessageHandler): void;
  addHook(name: 'onClose' | 'preClose', handler: () => unknown): void;
  setErrorHandler(
    handler: (error: unknown, request: MessagingRequest, reply: MessagingReply) => unknown,
  ): void;
}
