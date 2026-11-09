import { createContext, useContext } from 'react';
export interface AttachmentResource {
  url: string;
  blob?: Blob;
  name: string;
  mime: string;
  size: number;
  expiresAt: number;
  downloadUrl?: string;
  width?: number;
  height?: number;
}
/** Presentation stays shared; the owning module supplies its own authorization and transport. */
export interface AttachmentAccess {
  load(threadId: string, path: string, signal?: AbortSignal, fullSize?: boolean): Promise<AttachmentResource>;
}
export const AttachmentAccessContext = createContext<AttachmentAccess | null>(null);
export const useAttachmentAccess = () => useContext(AttachmentAccessContext);
