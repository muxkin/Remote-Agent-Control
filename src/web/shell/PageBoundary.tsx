import { Component, useEffect, useState, type ReactNode } from 'react';
import { pageFailure, type PageFailure } from './page-failure';
export function PageLoading({ label = '正在打开…' }: { label?: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="module-empty" role="status">
      <p>{slow ? '页面加载较慢，请检查连接或重新加载。' : label}</p>
      {slow && (
        <button className="secondary" onClick={() => location.reload()}>
          重新加载此页
        </button>
      )}
    </div>
  );
}
export class PageBoundary extends Component<
  {
    children: ReactNode;
    page: string;
    onBack: () => void;
    backLabel: string;
  },
  { failure?: PageFailure; online: boolean }
> {
  state: { failure?: PageFailure; online: boolean } = { online: navigator.onLine };
  static getDerivedStateFromError(error: unknown) {
    return { failure: pageFailure(error) };
  }
  private connection = () => this.setState({ online: navigator.onLine });
  componentDidMount() {
    window.addEventListener('online', this.connection);
    window.addEventListener('offline', this.connection);
  }
  componentWillUnmount() {
    window.removeEventListener('online', this.connection);
    window.removeEventListener('offline', this.connection);
  }
  componentDidCatch(error: Error) {
    try {
      sessionStorage.setItem(
        'pocket-page-failure',
        JSON.stringify({
          at: new Date().toISOString(),
          page: this.props.page,
          build: typeof __POCKET_WEB_BUILD_ID__ === 'string' ? __POCKET_WEB_BUILD_ID__ : 'dev',
          ...pageFailure(error),
        }),
      );
    } catch {
      /* Diagnostics must never prevent recovery. */
    }
  }
  render() {
    const { failure, online } = this.state;
    if (!failure) return this.props.children;
    return (
      <section className="module-empty page-failure" role="alert">
        <h2>{failure.kind === 'resource' ? '页面资源暂未加载成功' : '这个页面遇到了问题'}</h2>
        <p>
          {!online
            ? '当前处于离线状态，联网后可重新加载。'
            : failure.kind === 'resource'
              ? '连接中断可能导致页面没有加载完整，请重新加载此页。'
              : '重新加载后再试一次，也可以先返回其他页面。'}
        </p>
        <div className="page-failure-actions">
          <button className="primary" onClick={() => location.reload()}>
            重新加载此页
          </button>
          <button className="secondary" onClick={this.props.onBack}>
            {this.props.backLabel}
          </button>
        </div>
        <details className="page-failure-details">
          <summary>诊断信息</summary>
          <p>
            类型：{failure.kind === 'resource' ? '资源加载失败' : '页面运行异常'}
            <br />
            版本：
            {typeof __POCKET_WEB_BUILD_ID__ === 'string' ? __POCKET_WEB_BUILD_ID__.slice(0, 8) : '开发版'}
          </p>
          {failure.resource && <code>{failure.resource}</code>}
        </details>
      </section>
    );
  }
}
