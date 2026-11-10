import { tsxComponent } from './tsx-component';
import type { UploadProgress as Progress } from '../shared/upload-progress';
import { Icon } from './Icon';
import { browserId } from './browser-id';

export type UploadItem = Progress & {
  id: string;
  name: string;
  state: 'queued' | 'active' | 'done' | 'failed';
  error?: string;
};
export function uploadItems(files: File[]): UploadItem[] {
  return files.map((file) => ({
    id: browserId(),
    name: file.name,
    total: file.size,
    loaded: 0,
    phase: 'preparing',
    state: 'queued',
  }));
}
function size(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export const UploadProgress = tsxComponent(function UploadProgress(_props: {
  items: UploadItem[];
  onDismiss?: () => void;
}) {
  return ({ items, onDismiss }) => {
    const visible = items.filter((item) => item.state !== 'done');
    if (!visible.length) return null;
    const failed = items.filter((item) => item.state === 'failed').length;
    const active = items.some((item) => item.state === 'active' || item.state === 'queued');
    return (
      <section class="upload-progress-panel" aria-label="附件上传进度" aria-busy={active}>
        <div class="upload-progress-list">
          {visible.map((item) => {
            const percent = Math.min(100, Math.round((item.loaded / Math.max(1, item.total)) * 100));
            const label =
              item.state === 'failed'
                ? '上传失败，请重新添加'
                : item.state === 'queued'
                  ? '等待上传'
                  : item.phase === 'preparing'
                    ? '正在准备'
                    : item.phase === 'finalizing'
                      ? '正在校验'
                      : `上传中 ${percent}%`;
            return (
              <div class={`upload-progress-file ${item.state}`} key={item.id}>
                <span class="upload-file-type" aria-hidden="true">
                  {item.name.split('.').at(-1)?.slice(0, 5).toUpperCase() || 'FILE'}
                </span>
                <div class="upload-file-details">
                  <span class="upload-file-name" title={item.name}>
                    {item.name}
                  </span>
                  <span class="upload-file-meta">
                    {size(item.total)}
                    <span>{label}</span>
                  </span>
                  {(item.state === 'active' || item.state === 'queued') && (
                    <progress
                      aria-label={`${item.name} 上传进度`}
                      max={100}
                      value={item.state === 'queued' ? 0 : item.phase === 'uploading' ? percent : undefined}
                    />
                  )}
                  {item.error && (
                    <span class="upload-file-error" role="alert">
                      {item.error}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {!active && failed > 0 && onDismiss && (
          <button type="button" class="upload-progress-dismiss text-button" onClick={onDismiss}>
            <Icon name="close" size={14} /> 清除上传错误
          </button>
        )}
      </section>
    );
  };
});
