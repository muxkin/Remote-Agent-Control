import type { ResourceEnvironment } from '../server/resources/lago.js';

export interface Env extends ResourceEnvironment {
  RELAY: DurableObjectNamespace;
  MESSAGING: DurableObjectNamespace;
  ASSETS: Fetcher;
  IM_MEDIA: R2Bucket;
  IMAGES: ImagesBinding;
  POCKET_PUBLIC_ORIGIN: string;
  POCKET_RELAY_ENROLLMENT: string;
  POCKET_IM_REGISTRATION_CODE?: string;
  POCKET_ASSET_BASE?: string;
  POCKET_UPLOAD_ORIGINS?: string;
}
