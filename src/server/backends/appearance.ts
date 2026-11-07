import { z } from 'zod';
import sharp from 'sharp';
import { backendIconNames, type BackendAppearancePatch } from '../../shared/backends.js';
import { RpcError } from '../../shared/rpc.js';

const emoji = z
  .string()
  .trim()
  .max(32)
  .refine(
    (s) =>
      [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].length === 1 &&
      /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(s),
    '请选择一个 Emoji',
  );
export const appearancePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).nullable().optional(),
    description: z.string().trim().max(160).nullable().optional(),
    icon: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('builtin'), value: z.enum(backendIconNames) }).strict(),
        z.object({ kind: z.literal('emoji'), value: emoji }).strict(),
        z
          .object({
            kind: z.literal('image'),
            value: z
              .string()
              .max(90000)
              .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
          })
          .strict(),
      ])
      .nullable()
      .optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, '没有需要保存的设置');
export const appearanceUpdateSchema = z
  .object({
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    patch: appearancePatchSchema,
  })
  .strict();

/** Only a small re-encoded raster is persisted; no remote URLs or executable SVG. */
export async function appearanceImage(bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > 5 * 1024 ** 2) throw new RpcError('图片不能超过 5 MB', 400);
  try {
    const image = sharp(bytes, { limitInputPixels: 24000000 });
    if (!['png', 'jpeg', 'webp'].includes((await image.metadata()).format ?? '')) throw Error();
    const result = await image
      .rotate()
      .resize(192, 192, { fit: 'cover', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    if (result.length > 48 * 1024) throw Error();
    return `data:image/webp;base64,${result.toString('base64')}`;
  } catch {
    throw new RpcError('图片无法读取，请选择 PNG、JPEG 或 WebP 图片', 400);
  }
}
export async function normalizeAppearancePatch(input: unknown): Promise<BackendAppearancePatch> {
  const patch = appearancePatchSchema.parse(input);
  if (patch.icon?.kind === 'image')
    patch.icon = {
      kind: 'image',
      value: await appearanceImage(Buffer.from(patch.icon.value.split(',')[1], 'base64')),
    };
  return patch;
}
