import { useEffect, useState } from 'react';
import './donation.css';
import { Icon } from '../Icon';

const version = __POCKET_NATIVE_VERSION__;
const nativeRelease = `https://github.com/muxkin/Remote-Agent-Control/releases/download/native-v${version}`;
const nativeDownloads = [
  { name: 'Windows x64', suffix: 'windows-x64.zip' },
  { name: 'Linux x64', suffix: 'linux-x64.tar.xz' },
];

interface Download {
  platform: string;
  arch: string;
  version: string;
  file: string;
  size: number;
}
export default function DownloadsPage() {
  const [files, setFiles] = useState<Download[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(false),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    void fetch('/downloads/desktop/releases.json', { signal: controller.signal, cache: 'no-cache' })
      .then(async (r) => {
        if (r.status === 404) return { files: [] };
        if (!r.ok) throw Error();
        return r.json();
      })
      .then((data) => {
        if (!Array.isArray(data.files)) throw Error();
        setFiles(
          data.files.filter(
            (x: any) =>
              ['linux', 'darwin', 'win32'].includes(x.platform) &&
              ['x64', 'arm64'].includes(x.arch) &&
              /^AgentSpace-[0-9][A-Za-z0-9._-]*\.(exe|dmg|AppImage)$/.test(x.file) &&
              typeof x.version === 'string' &&
              Number.isFinite(x.size),
          ),
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);
  return (
    <div className="donation-page">
      <section className="donation-intro">
        <span className="donation-mark">
          <Icon name="monitor" size={32} />
        </span>
        <h2>连接你的电脑</h2>
        <p>
          安装适配器，打开已有的 Codex / Agent，
          <br />
          再用手机扫码配对。
        </p>
      </section>
      <section className="donation-card">
        <h3>原生托盘版 v{version}</h3>
        <p>解压即可运行，无需安装 Node 或 Python。关闭窗口后继续在托盘运行，可在托盘菜单退出。</p>
        {nativeDownloads.map(({ name, suffix }) => (
          <p key={suffix}>
            <a href={`${nativeRelease}/AgentSpace-Native-${version}-${suffix}`}>{name} · 下载便携包</a>
          </p>
        ))}
      </section>
      <h3>原有安装版</h3>
      {loading ? (
        <p role="status">正在读取安装包…</p>
      ) : error ? (
        <div role="status">
          <p>暂时无法读取安装包。</p>
          <button className="secondary" onClick={() => setAttempt((x) => x + 1)}>
            重试
          </button>
        </div>
      ) : (
        ['win32', 'darwin', 'linux'].map((platform) => (
          <section className="donation-card" key={platform}>
            <h3>{{ win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[platform]}</h3>
            {files.filter((f) => f.platform === platform).length ? (
              files
                .filter((f) => f.platform === platform)
                .map((f) => (
                  <p key={f.arch}>
                    <a href={`/downloads/desktop/${f.platform}/${f.arch}/${f.file}`} download>
                      {f.arch === 'arm64' ? 'ARM64 / Apple Silicon' : 'Intel / AMD 64 位'} · 下载 v{f.version}
                    </a>
                    <small> · {Math.ceil(f.size / 1024 / 1024)} MB</small>
                  </p>
                ))
            ) : (
              <p>此平台的正式安装包尚未发布。</p>
            )}
          </section>
        ))
      )}
    </div>
  );
}
