import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EccLevel, QrCode } from '../src/qr.js';
import { alignmentPatternPositions, eccBlockInfo, encodeText, gfMultiply, maskBit, numDataCodewords, numRawDataModules, rsGenerator, rsRemainder, toSvg } from '../src/qr.js';

/* ---------- Decodificador independiente para verificar la salida ---------- */

const ECC_FROM_FORMAT: EccLevel[] = ['M', 'L', 'H', 'Q'];

function functionMask(size: number, version: number): boolean[][] {
  const f = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (x: number, y: number) => {
    if (x >= 0 && x < size && y >= 0 && y < size) f[y]![x] = true;
  };
  for (let i = 0; i < size; i++) {
    mark(6, i);
    mark(i, 6);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy);
  }
  const pos = alignmentPatternPositions(version);
  const last = pos.length - 1;
  pos.forEach((py, i) =>
    pos.forEach((px, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(px + dx, py + dy);
    }),
  );
  for (let i = 0; i < 9; i++) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i++) {
    mark(size - 1 - i, 8);
    mark(8, size - 1 - i);
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      mark(size - 11 + (i % 3), Math.floor(i / 3));
      mark(Math.floor(i / 3), size - 11 + (i % 3));
    }
  }
  return f;
}

/** Lee los 15 bits de formato y los valida contra las 32 palabras posibles. */
function readFormat(qr: QrCode): { ecc: EccLevel; mask: number } {
  const m = qr.modules;
  const bit = (x: number, y: number) => (m[y]![x] ? 1 : 0);
  let raw = 0;
  for (let i = 0; i <= 5; i++) raw |= bit(8, i) << i;
  raw |= bit(8, 7) << 6;
  raw |= bit(8, 8) << 7;
  raw |= bit(7, 8) << 8;
  for (let i = 9; i < 15; i++) raw |= bit(14 - i, 8) << i;
  // Segunda copia
  let raw2 = 0;
  for (let i = 0; i < 8; i++) raw2 |= bit(qr.size - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) raw2 |= bit(8, qr.size - 15 + i) << i;
  assert.equal(raw, raw2, 'las dos copias del formato deben coincidir');
  const unmasked = raw ^ 0x5412;
  for (let data = 0; data < 32; data++) {
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    if (((data << 10) | rem) === unmasked) return { ecc: ECC_FROM_FORMAT[data >> 3] as EccLevel, mask: data & 7 };
  }
  throw new Error('formato inválido');
}

function readVersion(qr: QrCode): number {
  if (qr.version < 7) return qr.version;
  let bits = 0;
  for (let i = 0; i < 18; i++) bits |= (qr.modules[Math.floor(i / 3)]![qr.size - 11 + (i % 3)] ? 1 : 0) << i;
  const version = bits >>> 12;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  assert.equal((version << 12) | rem, bits, 'información de versión corrupta');
  return version;
}

function readCodewords(qr: QrCode, mask: number): number[] {
  const f = functionMask(qr.size, qr.version);
  const bits: number[] = [];
  for (let right = qr.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < qr.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? qr.size - 1 - vert : vert;
        if (!f[y]![x]) bits.push((qr.modules[y]![x] ? 1 : 0) ^ (maskBit(mask, x, y) ? 1 : 0));
      }
    }
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));
  return bytes;
}


/** Comprueba que el polinomio del bloque es divisible por el generador (síndromes nulos). */
function checkSyndromes(block: number[], eccLen: number): void {
  let root = 1;
  for (let i = 0; i < eccLen; i++) {
    let acc = 0;
    for (const c of block) acc = gfMultiply(acc, root) ^ c;
    assert.equal(acc, 0, `síndrome ${i} distinto de cero`);
    root = gfMultiply(root, 2);
  }
}

function decode(qr: QrCode, expectedBlocks?: { numBlocks: number; eccLen: number }): string {
  const { ecc, mask } = readFormat(qr);
  assert.equal(ecc, qr.ecc);
  assert.equal(mask, qr.mask);
  const version = readVersion(qr);
  assert.equal(version, qr.version);
  const all = readCodewords(qr, mask);
  const raw = Math.floor(numRawDataModules(version) / 8);
  assert.equal(all.length, raw);

  const { numBlocks, eccLen } = expectedBlocks ?? eccBlockInfo(version, ecc);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const blocks: number[][] = Array.from({ length: numBlocks }, () => []);
  let k = 0;
  for (let i = 0; i < shortLen + 1; i++) {
    for (let j = 0; j < numBlocks; j++) {
      if (i === shortLen - eccLen && j < numShort) continue; // hueco de los bloques cortos
      blocks[j]!.push(all[k++] as number);
    }
  }
  assert.equal(k, raw);
  const data: number[] = [];
  blocks.forEach((block, j) => {
    const expectedLen = shortLen + (j < numShort ? 0 : 1);
    assert.equal(block.length, expectedLen);
    checkSyndromes(block, eccLen);
    data.push(...block.slice(0, block.length - eccLen));
  });
  assert.equal(data.length, numDataCodewords(version, ecc));

  const bits = data.flatMap((b) => Array.from({ length: 8 }, (_, i) => (b >>> (7 - i)) & 1));
  let pos = 0;
  const read = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | (bits[pos++] as number);
    return v;
  };
  assert.equal(read(4), 4, 'modo bytes');
  const len = read(version <= 9 ? 8 : 16);
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = read(8);
  if (pos + 4 <= bits.length) assert.equal(read(4), 0, 'terminador');
  return new TextDecoder().decode(bytes);
}

/* ---------- Pruebas ---------- */

test('aritmética GF(256) y generador RS', () => {
  assert.equal(gfMultiply(2, 128), 0x1d);
  assert.equal(gfMultiply(0x8e, 0x02), 0x01, 'reducción módulo 0x11d: 0x8e es el inverso de 2');
  // Generador de grado 2: (x - 1)(x - 2) = x^2 + 3x + 2
  assert.deepEqual(rsGenerator(2), [3, 2]);
  // Generador de grado 7 (versión 1-L), coeficientes conocidos del estándar
  assert.deepEqual(rsGenerator(7), [127, 122, 154, 164, 11, 68, 117]);
  const rem = rsRemainder([0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11], rsGenerator(10));
  assert.deepEqual(rem, [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55], 'ejemplo "HELLO WORLD" 1-M del estándar');
});

test('tamaños y capacidades conocidas', () => {
  assert.equal(numRawDataModules(1), 208);
  assert.equal(numRawDataModules(2), 359);
  assert.equal(numRawDataModules(7), 1568);
  assert.equal(numDataCodewords(1, 'L'), 19);
  assert.equal(numDataCodewords(1, 'H'), 9);
  assert.equal(numDataCodewords(5, 'Q'), 62);
  assert.equal(numDataCodewords(10, 'L'), 274);
  assert.equal(numDataCodewords(40, 'L'), 2956);
  assert.equal(numDataCodewords(40, 'H'), 1276);
  assert.deepEqual(alignmentPatternPositions(1), []);
  assert.deepEqual(alignmentPatternPositions(2), [6, 18]);
  assert.deepEqual(alignmentPatternPositions(7), [6, 22, 38]);
  assert.deepEqual(alignmentPatternPositions(14), [6, 26, 46, 66]);
  assert.deepEqual(alignmentPatternPositions(32), [6, 34, 60, 86, 112, 138]);
  assert.deepEqual(alignmentPatternPositions(40), [6, 30, 58, 86, 114, 142, 170]);
});

test('patrones fijos: finders, temporización y módulo oscuro', () => {
  const qr = encodeText('hola');
  assert.equal(qr.version, 1);
  assert.equal(qr.size, 21);
  const m = qr.modules;
  const finder = [
    [1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1],
  ];
  for (const [ox, oy] of [[0, 0], [14, 0], [0, 14]] as const) {
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) assert.equal(m[oy + y]![ox + x], finder[y]![x] === 1, `finder en ${ox},${oy} celda ${x},${y}`);
  }
  for (let i = 8; i < 13; i++) {
    assert.equal(m[6]![i], i % 2 === 0, 'temporización horizontal');
    assert.equal(m[i]![6], i % 2 === 0, 'temporización vertical');
  }
  assert.equal(m[7]![8], false, 'separador');
  assert.equal(m[qr.size - 8]![8], true, 'módulo oscuro');
});

test('codifica y decodifica textos de distintas longitudes y niveles', () => {
  const samples = [
    'a',
    'Hola, mundo! ñ 🎵',
    'http://127.0.0.1:8888/#/card?d=zfdAxDsIwDAXQq6A_e0jitmmzoQrE',
    'x'.repeat(200),
    'https://example.com/bingo/#/card?d=' + 'Qw9_-Ab'.repeat(80),
    'y'.repeat(1200),
    'z'.repeat(2900),
  ];
  for (const text of samples) {
    for (const ecc of ['L', 'M', 'Q', 'H'] as EccLevel[]) {
      let qr: QrCode;
      try {
        qr = encodeText(text, { ecc });
      } catch (err) {
        if (text.length >= 2900 && ecc !== 'L') continue; // no cabe: esperado
        throw err;
      }
      assert.ok(qr.version >= 1 && qr.version <= 40);
      assert.equal(qr.size, qr.version * 4 + 17);
      assert.equal(decode(qr), text, `texto de ${text.length} chars con nivel ${ecc} (v${qr.version})`);
    }
  }
});

test('todas las máscaras decodifican', () => {
  for (let mask = 0; mask < 8; mask++) {
    const qr = encodeText('Bingo musical ' + mask, { mask, ecc: 'M' });
    assert.equal(qr.mask, mask);
    assert.equal(decode(qr), 'Bingo musical ' + mask);
  }
});

test('sube el nivel de corrección cuando cabe sin crecer', () => {
  const qr = encodeText('hola');
  assert.equal(qr.ecc, 'H', 'un texto corto cabe en 1-H');
});

test('la tabla de bloques coincide con el estándar en las versiones grandes', () => {
  // Versiones con bloques de dos tamaños: comprueba número de bloques y ecc por bloque.
  const known: [number, EccLevel, number, number][] = [
    [5, 'Q', 4, 18],
    [10, 'L', 4, 18],
    [13, 'H', 16, 22],
    [21, 'L', 8, 28],
    [25, 'M', 21, 28],
    [30, 'Q', 40, 30],
    [40, 'L', 25, 30],
    [40, 'H', 81, 30],
  ];
  for (const [version, ecc, blocks, eccLen] of known) {
    const raw = Math.floor(numRawDataModules(version) / 8);
    assert.equal(raw - numDataCodewords(version, ecc), blocks * eccLen, `v${version}-${ecc}`);
    assert.deepEqual(eccBlockInfo(version, ecc), { numBlocks: blocks, eccLen }, `tabla v${version}-${ecc}`);
    const text = 'q'.repeat(numDataCodewords(version, ecc) - 3);
    const qr = encodeText(text, { ecc, minVersion: version, maxVersion: version });
    assert.equal(decode(qr, { numBlocks: blocks, eccLen }), text);
  }
});

test('genera SVG', () => {
  const svg = toSvg(encodeText('hola'), { border: 2 });
  assert.match(svg, /^<svg /);
  assert.match(svg, /viewBox="0 0 25 25"/);
  assert.match(svg, /<path d="M/);
});
