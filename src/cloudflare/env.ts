import type { ResourceEnvironment } from '../server/resources/lago.js';

export interface Env extends ResourceEnvironment {
  RELAY: DurableObjectNamespace;
  MESSAGING: DurableObjectNamespace;
  ASSETS: Fetcher;
  IM_MEDIA: R2Bucket;
  DESKTOP_RELEASES?: R2Bucket;
  POCKET_DESKTOP_DOWNLOAD_BASE?: string;
  IMAGES: ImagesBinding;
  POCKET_PUBLIC_ORIGIN: string;
  POCKET_RELAY_ENROLLMENT: string;
  POCKET_IM_REGISTRATION_CODE?: string;
  POCKET_IM_HUMAN_CONTACTS?: string;
  POCKET_IM_CALL_STUN_URLS?: string;
  POCKET_IM_CALL_TURN_URLS?: string;
  POCKET_IM_CALL_TURN_SECRET?: string;
  POCKET_ASSET_BASE?: string;
  POCKET_UPLOAD_ORIGINS?: string;
}
