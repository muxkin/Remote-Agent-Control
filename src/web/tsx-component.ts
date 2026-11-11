import { defineComponent, type DefineComponent, type VNodeChild } from 'vue';

export function tsxComponent<Props extends object>(
  setup: (initialProps: Props) => (props: Props) => VNodeChild,
) {
  return defineComponent({
    name: setup.name,
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      const render = setup(attrs as Props);
      return () =>
        render(
          (slots.default && !Object.hasOwn(attrs, 'children')
            ? { ...attrs, children: slots.default() }
            : attrs) as Props,
        );
    },
  }) as unknown as DefineComponent<Props>;
}
