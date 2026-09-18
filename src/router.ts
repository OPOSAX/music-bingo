/** Enrutador por hash: #/ruta?query. */

export interface Route {
  path: string;
  params: URLSearchParams;
}

export function currentRoute(): Route {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  const [path, query = ''] = hash.split('?', 2);
  return { path: path && path !== '' ? path : '/', params: new URLSearchParams(query) };
}

export function navigate(path: string): void {
  location.hash = `#${path}`;
}

export function onRouteChange(handler: (route: Route) => void): void {
  window.addEventListener('hashchange', () => handler(currentRoute()));
}
