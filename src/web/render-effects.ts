import { onMounted, onScopeDispose, shallowRef, watch, type ShallowRef } from 'vue';

type Dependencies = readonly unknown[];
type Effect = () => void | (() => void);

function sameDependencies(previous: Dependencies | undefined, next: Dependencies | undefined) {
  return (
    previous &&
    next &&
    previous.length === next.length &&
    previous.every((value, index) => Object.is(value, next[index]))
  );
}

/** Run work against the render snapshot that scheduled it, after Vue patches the DOM. */
export function watchRender() {
  const pending = shallowRef<{ run: Effect }>();
  let dependencies: Dependencies | undefined;
  watch(
    pending,
    (effect, _, onCleanup) => {
      const cleanup = effect?.run();
      if (cleanup) onCleanup(cleanup);
    },
    { flush: 'post' },
  );
  return (run: Effect, next?: Dependencies) => {
    if (sameDependencies(dependencies, next)) return;
    dependencies = next;
    pending.value = { run };
  };
}

export function writeRef<T>(state: ShallowRef<T>) {
  return (next: T | ((previous: T) => T)) => {
    state.value = typeof next === 'function' ? (next as (previous: T) => T)(state.value) : next;
  };
}

/** Track the latest value reported by an external subscription. */
export function useExternalSnapshot<T>(subscribe: (notify: () => void) => () => void, read: () => T) {
  const snapshot = shallowRef(read());
  let unsubscribe: (() => void) | undefined;
  const update = () => {
    snapshot.value = read();
  };
  onMounted(() => {
    unsubscribe = subscribe(update);
    update();
  });
  onScopeDispose(() => unsubscribe?.());
  return snapshot;
}

/** Preserve the identity of a callback or provider value while its inputs are unchanged. */
export function memoizeRender() {
  let dependencies: Dependencies | undefined;
  let value: unknown;
  return <T>(read: () => T, next: Dependencies): T => {
    if (!sameDependencies(dependencies, next)) {
      value = read();
      dependencies = next;
    }
    return value as T;
  };
}
