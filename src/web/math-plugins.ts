import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { copyFormulaFromEvent, copyMathSelection, rehypeMathCopy } from './math-copy';

// Copy can be dispatched outside the message itself when the selection crosses messages.
document.addEventListener('copy', copyMathSelection);
if (import.meta.hot) import.meta.hot.dispose(() => document.removeEventListener('copy', copyMathSelection));
export default { remarkMath, rehypeKatex, rehypeMathCopy, copyFormulaFromEvent };
