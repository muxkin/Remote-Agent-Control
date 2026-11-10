import { defineComponent, onBeforeUnmount, onErrorCaptured, onMounted, shallowRef } from 'vue';
import { pageFailure, type PageFailure } from './page-failure';
export const PageLoading = defineComponent(
  (props: { label?: string }) => {
    const slow = shallowRef(false);
    let timer: ReturnType<typeof setTimeout>;
    onMounted(() => {
      timer = setTimeout(() => {
        slow.value = true;
      }, 8000);
    });
    onBeforeUnmount(() => clearTimeout(timer));
    return () => (
      <div class="module-empty" role="status">
        <p>{slow.value ? '页面加载较慢，请检查连接或重新加载。' : (props.label ?? '正在打开…')}</p>
        {slow.value && (
          <button class="secondary" onClick={() => location.reload()}>
            重新加载此页
          </button>
        )}
      </div>
    );
  },
  { props: ['label'] },
);

export const PageBoundary = defineComponent(
  (
    props: {
      page: string;
      onBack: () => void;
      backLabel: string;
    },
    { slots },
  ) => {
    const currentFailure = shallowRef<PageFailure>();
    const online = shallowRef(navigator.onLine);
    const connection = () => {
      online.value = navigator.onLine;
    };
    onMounted(() => {
      window.addEventListener('online', connection);
      window.addEventListener('offline', connection);
    });
    onBeforeUnmount(() => {
      window.removeEventListener('online', connection);
      window.removeEventListener('offline', connection);
    });
    onErrorCaptured((error) => {
      const failure = pageFailure(error);
      currentFailure.value = failure;
      try {
        sessionStorage.setItem(
          'pocket-page-failure',
          JSON.stringify({
            at: new Date().toISOString(),
            page: props.page,
            build: typeof __POCKET_WEB_BUILD_ID__ === 'string' ? __POCKET_WEB_BUILD_ID__ : 'dev',
            ...failure,
          }),
        );
      } catch {
        /* Diagnostics must never prevent recovery. */
      }
      return false;
    });
    return () => {
      const failure = currentFailure.value;
      if (!failure) return slots.default?.();
      return (
        <section class="module-empty page-failure" role="alert">
          <h2>{failure.kind === 'resource' ? '页面资源暂未加载成功' : '这个页面遇到了问题'}</h2>
          <p>
            {!online.value
              ? '当前处于离线状态，联网后可重新加载。'
              : failure.kind === 'resource'
                ? '连接中断可能导致页面没有加载完整，请重新加载此页。'
                : '重新加载后再试一次，也可以先返回其他页面。'}
          </p>
          <div class="page-failure-actions">
            <button class="primary" onClick={() => location.reload()}>
              重新加载此页
            </button>
            <button class="secondary" onClick={props.onBack}>
              {props.backLabel}
            </button>
          </div>
          <details class="page-failure-details">
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
    };
  },
  { props: ['page', 'onBack', 'backLabel'] },
);
