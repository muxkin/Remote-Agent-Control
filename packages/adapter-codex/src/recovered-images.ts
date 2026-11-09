import { itemMedia, inlineExtensions } from '../../../src/server/content-media.js';
import { resolveAttachmentPath } from '../../../src/server/media.js';

/** Recover only a uniquely paired native ImageView and its own tool result. */
export async function viewedImage(
  records: AsyncIterable<any>,
  threadId: string,
  reference: string,
  cwd: string,
): Promise<string | null> {
  const requested = resolveAttachmentPath(reference, cwd);
  const calls = new Map<string, { paths: string[]; ambiguous: boolean }>();
  for await (const record of records) {
    const payload = record.payload;
    if (!payload) continue;
    if (record.type === 'response_item') {
      if (['function_call', 'custom_tool_call'].includes(payload.type) && payload.call_id) {
        // Parallel calls have no reliable association with native ImageView events.
        for (const call of calls.values()) call.ambiguous = true;
        calls.set(payload.call_id, { paths: [], ambiguous: calls.size > 0 });
      } else if (['function_call_output', 'custom_tool_call_output'].includes(payload.type)) {
        const call = calls.get(payload.call_id);
        calls.delete(payload.call_id);
        if (!call || call.ambiguous || call.paths.length !== 1) continue;
        try {
          if (resolveAttachmentPath(call.paths[0], cwd) !== requested) continue;
        } catch {
          continue;
        }
        const sources = itemMedia(payload);
        if (sources.length !== 1) continue;
        const source = sources[0];
        const match = /^data:(image\/[^;]+);base64,([A-Za-z0-9+/=]+)$/.exec(source);
        if (match && Object.hasOwn(inlineExtensions, match[1]) && source.length <= 24 * 1024 * 1024)
          return source;
      }
    } else if (
      record.type === 'event_msg' &&
      payload.type === 'item_completed' &&
      payload.thread_id === threadId &&
      payload.item?.type === 'ImageView' &&
      typeof payload.item.path === 'string' &&
      calls.size === 1
    ) {
      calls.values().next().value!.paths.push(payload.item.path);
    }
  }
  return null;
}
