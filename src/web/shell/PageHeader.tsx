import { tsxComponent } from '../tsx-component';
import { type VNodeChild } from 'vue';

import { Icon } from '../Icon';
export const PageHeader = tsxComponent(function PageHeader(_props: {
  title: string;
  back?: () => void;
  children?: VNodeChild;
}) {
  return ({ title, back, children }) => {
    return (
      <header class="page-header">
        {back && (
          <button class="icon-button" aria-label="返回" onClick={back}>
            <Icon name="back" />
          </button>
        )}
        <h1>{title}</h1>
        {children}
      </header>
    );
  };
});
