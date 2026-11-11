import { onScopeDispose, shallowRef } from 'vue';
import { appearanceSnapshot, subscribeAppearance } from './store';

export function useAppearance() {
  const snapshot = shallowRef(appearanceSnapshot());
  onScopeDispose(
    subscribeAppearance(() => {
      snapshot.value = appearanceSnapshot();
    }),
  );
  return snapshot;
}
