/**
 * Listas de ejemplo con música de libre uso, importables desde "Mi biblioteca" con un clic: el servidor descarga los
 * archivos (archive.org), los guarda como canciones de la biblioteca y crea la lista para el animador que importa.
 *
 * Carlos Gardel (1890-1935): grabaciones publicadas en archive.org con marca de dominio público. Los derechos de intérprete
 * y de la mayoría de las composiciones han expirado; quien use la lista en público debe revisar la situación en su país.
 */

const GARDEL = 'Carlos Gardel';
const PD = 'Dominio público · archive.org';
const ia = (item, file) => `https://archive.org/download/${item}/${encodeURIComponent(file).replace(/%2F/g, '/')}`;
const CANARO = 'UnDiscodeCarlosGardelyFranciscoCanaro';

export const SAMPLE_LISTS = [
  {
    id: 'gardel',
    name: 'Carlos Gardel · tangos de dominio público',
    description: '10 tangos clásicos de Carlos Gardel (grabaciones 1927-1934, dominio público en archive.org). Ideal para probar el sistema sin Spotify.',
    source: 'https://archive.org/details/' + CANARO,
    songs: [
      { url: ia('CarlosGardelPorUnaCabeza', 'Carlos-Gardel-Por-una-cabeza.mp3'), title: 'Por una cabeza', artist: GARDEL, album: PD, durationMs: 160000 },
      { url: ia(CANARO, '02 Francisco Canaro & C.Gardel (1956) - Mi Noche Triste.mp3'), title: 'Mi noche triste', artist: GARDEL, album: PD, durationMs: 197000 },
      { url: ia(CANARO, '05 Francisco Canaro & C.Gardel (1956) - Yira Yira.mp3'), title: 'Yira yira', artist: GARDEL, album: PD, durationMs: 178000 },
      { url: ia(CANARO, '04 Francisco Canaro & C.Gardel (1956) - Madame Ivonne.mp3'), title: 'Madame Ivonne', artist: GARDEL, album: PD, durationMs: 183000 },
      { url: ia(CANARO, '01 Francisco Canaro & C.Gardel (1956) - Siga El Corso.mp3'), title: 'Siga el corso', artist: GARDEL, album: PD, durationMs: 176000 },
      { url: ia(CANARO, '03 Francisco Canaro & C.Gardel (1956) - Chorra++.mp3'), title: 'Chorra', artist: GARDEL, album: PD, durationMs: 172000 },
      { url: ia(CANARO, '06 Francisco Canaro & C.Gardel (1956) - Bandoneón Arrabalero.mp3'), title: 'Bandoneón arrabalero', artist: GARDEL, album: PD, durationMs: 161000 },
      { url: ia(CANARO, '07 Francisco Canaro & C.Gardel (1956) - Madre Hay Una Sola.mp3'), title: 'Madre hay una sola', artist: GARDEL, album: PD, durationMs: 178000 },
      { url: ia('UnDiscoDeCarlosGardelGardeleroViejoCd1', '01CaminitoSoleado-1934.mp3'), title: 'Caminito soleado', artist: GARDEL, album: PD, durationMs: 168000 },
      { url: ia('UnDiscoDeCarlosGardelGardeleroViejoCd2_201901', 'Gardelero Viejo (CD 2)/10 Ramona - 1928.mp3'), title: 'Ramona', artist: GARDEL, album: PD, durationMs: 169000 },
    ],
  },
];
