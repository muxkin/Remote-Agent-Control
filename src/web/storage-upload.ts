import type { DirectUpload } from '../shared/storage.js';

export async function uploadToStorage(plan: DirectUpload, file: File) {
  let body: FormData | File = file;
  if (plan.encoding === 'multipart') {
    const form = new FormData();
    for (const [name, value] of Object.entries(plan.fields)) form.set(name, value);
    form.set(plan.fileField, file);
    body = form;
  }
  const response = await fetch(plan.url, {
    method: plan.method,
    headers: plan.headers,
    body,
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) throw Error('对象存储上传失败');
}
