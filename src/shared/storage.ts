/** A scoped, expiring upload grant. Permanent storage credentials must never enter this type. */
export type DirectUpload =
  | {
      url: string;
      method: 'POST';
      encoding: 'multipart';
      fields: Record<string, string>;
      fileField: string;
      headers?: Record<string, string>;
    }
  | { url: string; method: 'PUT'; encoding: 'raw'; headers?: Record<string, string> };
