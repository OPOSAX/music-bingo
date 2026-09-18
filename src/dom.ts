/** Ayudas mínimas para construir DOM sin frameworks. */

type Child = Node | string | number | null | undefined | false | Child[];

type Props<K extends keyof HTMLElementTagNameMap> = Partial<Omit<HTMLElementTagNameMap[K], 'style' | 'dataset' | 'children'>> & {
  class?: string;
  style?: Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
  attrs?: Record<string, string>;
  onClick?: (ev: MouseEvent) => void;
};

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props<K> | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    const { class: className, style, dataset, attrs, onClick, ...rest } = props;
    if (className) el.className = className;
    if (style) Object.assign(el.style, style);
    if (dataset) Object.assign(el.dataset, dataset);
    if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (onClick) el.addEventListener('click', onClick as EventListener);
    Object.assign(el, rest);
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function button(label: string, onClick: () => void, className = 'btn'): HTMLButtonElement {
  return h('button', { class: className, type: 'button', onClick }, label);
}

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Muestra un aviso temporal en la esquina de la pantalla. */
export function toast(message: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  let host = document.getElementById('toasts');
  if (!host) {
    host = h('div', { id: 'toasts' });
    document.body.appendChild(host);
  }
  const el = h('div', { class: `toast toast-${kind}` }, message);
  host.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, kind === 'error' ? 6000 : 3000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
