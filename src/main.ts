/** Punto de entrada: gestiona el retorno de Spotify y enruta las pantallas. */

import { handleRedirect } from './auth.js';
import { errorMessage, h, toast } from './dom.js';
import { currentRoute, navigate, onRouteChange, type Route } from './router.js';
import { releaseCardSync, renderPlayerCard } from './views/card.js';
import { renderCards } from './views/cards.js';
import { renderDeal } from './views/deal.js';
import { renderJoin } from './views/join.js';
import { renderHome } from './views/home.js';
import { releasePlayer, renderHost } from './views/host.js';
import { renderSetup } from './views/setup.js';
import { releaseDj, renderDj } from './concert/views/dj.js';
import { releaseSing, renderSing } from './concert/views/sing.js';

const root = document.getElementById('app') as HTMLElement;

async function render(route: Route): Promise<void> {
  if (route.path !== '/host') releasePlayer();
  if (route.path !== '/card' && route.path !== '/join') releaseCardSync();
  if (route.path !== '/dj') await releaseDj();
  if (route.path !== '/sing') await releaseSing();
  try {
    switch (route.path) {
      case '/':
        await renderHome(root);
        break;
      case '/setup':
        await renderSetup(root);
        break;
      case '/host':
        await renderHost(root);
        break;
      case '/cards':
        await renderCards(root);
        break;
      case '/card':
        await renderPlayerCard(root, route.params);
        break;
      case '/deal':
        await renderDeal(root, route.params);
        break;
      case '/join':
        await renderJoin(root, route.params);
        break;
      case '/sing':
        await renderSing(root, route.params);
        break;
      case '/dj':
        await renderDj(root, route.params);
        break;
      default:
        navigate('/');
    }
  } catch (err) {
    root.replaceChildren(h('section', { class: 'panel' }, h('p', { class: 'alert alert-error' }, errorMessage(err))));
  }
  window.scrollTo(0, 0);
}

async function start(): Promise<void> {
  try {
    if (await handleRedirect()) toast('Sesión iniciada en Spotify', 'success');
  } catch (err) {
    toast(errorMessage(err), 'error');
  }
  onRouteChange((route) => void render(route));
  await render(currentRoute());
}

void start();
