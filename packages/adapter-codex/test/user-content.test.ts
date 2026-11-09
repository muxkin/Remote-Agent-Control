import { describe, it, expect } from 'vitest';
import { nativeUserInput, userContent } from '../src/user-content.js';
import { messagesOf } from '../src/timeline.js';
import { rolloutMessage } from '../src/history.js';
import { state } from '../../../test/helpers.js';
const path = '/home/test/.local/state/codex-pocket-remote/uploads/00000000-0000-4000-8000-000000000001/a.jpg';
const file = { name: 'a.jpg', path };
const raw = `说明\n\n手机上传的附件（保留原始文件）：\n${JSON.stringify(file)}`;
describe('Native attachment messages', () => {
  it('uses desktop context and native images without putting raw metadata in the displayed prompt', () => {
    const native = nativeUserInput('看图片\n## My request:\n这也是我的原文', [
      file,
      { name: 'x.txt', path: '/tmp/x.txt' },
    ]);
    expect(native.input).toContainEqual({ type: 'localImage', path });
    expect(native.attachments).toContainEqual({
      label: 'a.jpg',
      path,
      fsPath: path,
      isImageAttachment: true,
    });
    expect(userContent('text' in native.input[0] ? native.input[0].text : '')).toEqual({
      text: '看图片\n## My request:\n这也是我的原文',
      attachments: [file, { name: 'x.txt', path: '/tmp/x.txt' }],
    });
    expect('text' in native.input[0] ? native.input[0].text : '').not.toContain('手机上传的附件');
  });
  it('cleans only recognized legacy upload footers and retains both images and files', () => {
    expect(userContent(raw)).toEqual({ text: '说明', attachments: [file] });
    for (const text of [
      '提到\n\n手机上传的附件（保留原始文件）：\n不是 JSON',
      raw.replace(path, '/etc/passwd'),
      '# Files mentioned by the user:\n## My request:\n文本',
    ])
      expect(userContent(text)).toEqual({ text });
  });
  it('keeps native images together under their owning text in live and stored history', () => {
    const extra = '/tmp/wide-screenshot.png';
    const content = [
      { type: 'text', text: raw },
      { type: 'localImage', path },
      { type: 'localImage', path: extra },
    ];
    const expected = {
      text: '说明',
      attachments: [
        { ...file, media: 'image' },
        { name: 'wide-screenshot.png', path: extra, media: 'image' },
      ],
    };
    const snapshot = state();
    snapshot.turnHistory.history.entitiesByKey.one.items = [
      {
        id: 'image',
        type: 'userMessage',
        content,
      },
    ];
    const messages = messagesOf(snapshot);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject(expected);
    expect(
      rolloutMessage(
        {
          type: 'response_item',
          payload: { type: 'message', role: 'user', content },
        },
        'old',
      ),
    ).toMatchObject(expected);
  });
});
