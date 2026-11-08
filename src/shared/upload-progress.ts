export type UploadProgress = {
  phase: 'preparing' | 'uploading' | 'finalizing';
  loaded: number;
  total: number;
};
