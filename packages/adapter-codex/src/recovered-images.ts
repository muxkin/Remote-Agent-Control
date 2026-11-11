import { inlineExtensions } from '../../../src/server/content-media.js';
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
    if (
      record.type === 'turn_context' ||
      (record.type === 'event_msg' && ['task_started', 'task_complete'].includes(payload.type))
    )
      calls.clear();
    if (record.type === 'response_item') {
      if (['function_call', 'custom_tool_call'].includes(payload.type) && payload.call_id) {
        // Parallel calls have no reliable association with native ImageView events.
        for (const call of calls.values()) call.ambiguous = true;
        calls.set(payload.call_id, { paths: [], ambiguous: calls.size > 0 });
      } else if (['function_call_output', 'custom_tool_call_output'].includes(payload.type)) {
        const call = calls.get(payload.call_id);
        calls.delete(payload.call_id);
        if (!call || call.ambiguous || !Array.isArray(payload.output)) continue;
        const matches = call.paths
          .map((path, index) => {
            try {
              return resolveAttachmentPath(path, cwd) === requested ? index : -1;
            } catch {
              return -1;
            }
          })
          .filter((index) => index >= 0);
        if (matches.length !== 1) continue;
        const images = payload.output
          .filter((item: any) => !['text', 'input_text', 'output_text'].includes(item?.type))
          .map((item: any) =>
            ['input_image', 'image_url'].includes(item?.type)
              ? typeof item.image_url === 'string'
                ? item.image_url
                : item.image_url?.url
              : undefined,
          );
        if (
          images.length === call.paths.length &&
          images.every((source: unknown) => {
            if (typeof source !== 'string' || source.length > 24 * 1024 * 1024) return false;
            const match = /^data:(image\/[^;]+);base64,[A-Za-z0-9+/=]+$/.exec(source);
            return match && Object.hasOwn(inlineExtensions, match[1]);
          })
        )
          return images[matches[0]];
      }
    } else if (
      record.type === 'event_msg' &&
      payload.type === 'item_completed' &&
      payload.item?.type === 'ImageView' &&
      typeof payload.item.path === 'string' &&
      calls.size === 1
    ) {
      const call = calls.values().next().value!;
      if (payload.thread_id === threadId && call.paths.length < 32) call.paths.push(payload.item.path);
      else call.ambiguous = true;
    }
  }
  return null;
}
