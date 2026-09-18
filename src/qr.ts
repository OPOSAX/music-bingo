/**
 * Generador de códigos QR (modo bytes, versiones 1–40, niveles L/M/Q/H).
 * Implementación autocontenida basada en la especificación ISO/IEC 18004,
 * siguiendo la estructura de la biblioteca de referencia "QR Code generator" de Nayuki.
 */

export type EccLevel = 'L' | 'M' | 'Q' | 'H';

const ECC_ORDINAL: Record<EccLevel, number> = { L: 0, M: 1, Q: 2, H: 3 };
const ECC_FORMAT_BITS: Record<EccLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };
const ECC_BY_ORDINAL: EccLevel[] = ['L', 'M', 'Q', 'H'];

/** Codewords de corrección por bloque, indexado [nivel][versión]. */
const ECC_CODEWORDS_PER_BLOCK: number[][] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

/** Número de bloques de corrección, indexado [nivel][versión]. */
const NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

export interface QrCode {
  version: number;
  size: number;
  ecc: EccLevel;
  mask: number;
  /** modules[y][x] === true si el módulo es oscuro. */
  modules: boolean[][];
}

/* ---------- Tablas de tamaño ---------- */

export function numRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Número de bloques y codewords de corrección por bloque para una versión y nivel. */
export function eccBlockInfo(version: number, ecc: EccLevel): { numBlocks: number; eccLen: number } {
  const e = ECC_ORDINAL[ecc];
  return { numBlocks: NUM_ERROR_CORRECTION_BLOCKS[e]![version] as number, eccLen: ECC_CODEWORDS_PER_BLOCK[e]![version] as number };
}

export function numDataCodewords(version: number, ecc: EccLevel): number {
  const { numBlocks, eccLen } = eccBlockInfo(version, ecc);
  return Math.floor(numRawDataModules(version) / 8) - eccLen * numBlocks;
}

export function alignmentPatternPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result: number[] = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

/* ---------- Reed-Solomon sobre GF(2^8) ---------- */

export function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

export function rsGenerator(degree: number): number[] {
  const result: number[] = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j] as number, root);
      if (j + 1 < degree) result[j] = (result[j] as number) ^ (result[j + 1] as number);
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

export function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result: number[] = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] = (result[i] as number) ^ gfMultiply(coef, factor);
    });
  }
  return result;
}

/* ---------- Construcción del flujo de datos ---------- */

class BitBuffer {
  bits: number[] = [];
  append(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

function bytesNeededBits(byteCount: number, version: number): number {
  return 4 + charCountBits(version) + 8 * byteCount;
}

function addEccAndInterleave(data: readonly number[], version: number, ecc: EccLevel): number[] {
  const { numBlocks, eccLen: blockEccLen } = eccBlockInfo(version, ecc);
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks: number[][] = [];
  const generator = rsGenerator(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const rem = rsRemainder(dat, generator);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(rem));
  }

  const result: number[] = [];
  const blockLen = blocks[0]!.length;
  for (let i = 0; i < blockLen; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i] as number);
    });
  }
  return result;
}

/* ---------- Dibujo de módulos ---------- */

class Matrix {
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  private setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.isFunction[y]![x] = true;
  }

  drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);

    const positions = alignmentPatternPositions(this.version);
    const last = positions.length - 1;
    positions.forEach((py, i) => {
      positions.forEach((px, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        this.drawAlignment(px, py);
      });
    });

    this.drawFormatBits('L', 0); // marcador provisional: reserva las posiciones
    this.drawVersion();
  }

  private drawFinder(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.setFunction(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }

  private drawAlignment(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) this.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  drawFormatBits(ecc: EccLevel, mask: number): void {
    const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;

    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
    this.setFunction(8, 7, bit(6));
    this.setFunction(8, 8, bit(7));
    this.setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));

    for (let i = 0; i < 8; i++) this.setFunction(this.size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFunction(8, this.size - 15 + i, bit(i));
    this.setFunction(8, this.size - 8, true);
  }

  private drawVersion(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, bit);
      this.setFunction(b, a, bit);
    }
  }

  drawCodewords(data: readonly number[]): void {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y]![x] && i < data.length * 8) {
            this.modules[y]![x] = (((data[i >>> 3] as number) >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.isFunction[y]![x] && maskBit(mask, x, y)) this.modules[y]![x] = !this.modules[y]![x];
      }
    }
  }

  penaltyScore(): number {
    let result = 0;
    const m = this.modules;
    const n = this.size;

    for (let y = 0; y < n; y++) {
      let runColor = false;
      let runX = 0;
      const history = new RunHistory(n);
      for (let x = 0; x < n; x++) {
        if (m[y]![x] === runColor) {
          runX++;
          if (runX === 5) result += PENALTY_N1;
          else if (runX > 5) result++;
        } else {
          history.add(runX, runColor);
          if (!runColor) result += history.countPatterns() * PENALTY_N3;
          runColor = m[y]![x] as boolean;
          runX = 1;
        }
      }
      result += history.terminate(runX, runColor) * PENALTY_N3;
    }
    for (let x = 0; x < n; x++) {
      let runColor = false;
      let runY = 0;
      const history = new RunHistory(n);
      for (let y = 0; y < n; y++) {
        if (m[y]![x] === runColor) {
          runY++;
          if (runY === 5) result += PENALTY_N1;
          else if (runY > 5) result++;
        } else {
          history.add(runY, runColor);
          if (!runColor) result += history.countPatterns() * PENALTY_N3;
          runColor = m[y]![x] as boolean;
          runY = 1;
        }
      }
      result += history.terminate(runY, runColor) * PENALTY_N3;
    }

    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const c = m[y]![x];
        if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) result += PENALTY_N2;
      }
    }

    let dark = 0;
    for (const row of m) for (const cell of row) if (cell) dark++;
    const total = n * n;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;
    return result;
  }
}

/** Historial de rachas para detectar patrones parecidos al finder (1:1:3:1:1). */
class RunHistory {
  private readonly runs = [0, 0, 0, 0, 0, 0, 0];
  constructor(private readonly size: number) {}

  add(runLength: number, color: boolean): void {
    if (this.runs[0] === 0 && !color) runLength += this.size; // borde claro implícito
    this.runs.pop();
    this.runs.unshift(runLength);
  }

  countPatterns(): number {
    const r = this.runs;
    const n = r[1] as number;
    const core = n > 0 && r[2] === n && r[3] === n * 3 && r[4] === n && r[5] === n;
    return (core && (r[0] as number) >= n * 4 && (r[6] as number) >= n ? 1 : 0) + (core && (r[6] as number) >= n * 4 && (r[0] as number) >= n ? 1 : 0);
  }

  terminate(currentRunLength: number, currentColor: boolean): number {
    if (currentColor) {
      this.add(currentRunLength, true);
      currentRunLength = 0;
    }
    currentRunLength += this.size;
    this.add(currentRunLength, false);
    return this.countPatterns();
  }
}

export function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      throw new Error('Máscara no válida');
  }
}

/* ---------- API pública ---------- */

export interface QrOptions {
  /** Nivel mínimo de corrección de errores (se sube si cabe sin aumentar la versión). */
  ecc?: EccLevel;
  minVersion?: number;
  maxVersion?: number;
  /** Máscara fija (0–7); por defecto se elige la de menor penalización. */
  mask?: number;
}

/** Codifica texto (UTF-8, modo bytes) en un código QR. */
export function encodeText(text: string, options: QrOptions = {}): QrCode {
  return encodeBytes(new TextEncoder().encode(text), options);
}

export function encodeBytes(bytes: Uint8Array, options: QrOptions = {}): QrCode {
  const minVersion = options.minVersion ?? 1;
  const maxVersion = options.maxVersion ?? 40;
  let ecc: EccLevel = options.ecc ?? 'L';

  let version = minVersion;
  for (;;) {
    if (bytesNeededBits(bytes.length, version) <= numDataCodewords(version, ecc) * 8) break;
    if (version >= maxVersion) throw new Error('El contenido es demasiado largo para un código QR.');
    version++;
  }
  for (const candidate of ECC_BY_ORDINAL) {
    if (ECC_ORDINAL[candidate] > ECC_ORDINAL[ecc] && bytesNeededBits(bytes.length, version) <= numDataCodewords(version, candidate) * 8) ecc = candidate;
  }

  const bb = new BitBuffer();
  bb.append(0x4, 4);
  bb.append(bytes.length, charCountBits(version));
  for (const b of bytes) bb.append(b, 8);

  const capacityBits = numDataCodewords(version, ecc) * 8;
  bb.append(0, Math.min(4, capacityBits - bb.bits.length));
  bb.append(0, (8 - (bb.bits.length % 8)) % 8);
  for (let pad = 0xec; bb.bits.length < capacityBits; pad ^= 0xec ^ 0x11) bb.append(pad, 8);

  const dataCodewords: number[] = new Array<number>(bb.bits.length / 8).fill(0);
  bb.bits.forEach((bit, i) => {
    dataCodewords[i >>> 3] = (dataCodewords[i >>> 3] as number) | (bit << (7 - (i & 7)));
  });

  const matrix = new Matrix(version);
  matrix.drawFunctionPatterns();
  matrix.drawCodewords(addEccAndInterleave(dataCodewords, version, ecc));

  let mask = options.mask ?? -1;
  if (mask === -1) {
    let best = Infinity;
    for (let i = 0; i < 8; i++) {
      matrix.applyMask(i);
      matrix.drawFormatBits(ecc, i);
      const penalty = matrix.penaltyScore();
      if (penalty < best) {
        best = penalty;
        mask = i;
      }
      matrix.applyMask(i); // deshacer (XOR)
    }
  }
  matrix.applyMask(mask);
  matrix.drawFormatBits(ecc, mask);

  return { version, size: matrix.size, ecc, mask, modules: matrix.modules };
}

/** Devuelve el QR como SVG (cadena) con zona de silencio de 4 módulos. */
export function toSvg(qr: QrCode, options: { border?: number; dark?: string; light?: string; className?: string } = {}): string {
  const border = options.border ?? 4;
  const dark = options.dark ?? '#000';
  const light = options.light ?? '#fff';
  const total = qr.size + border * 2;
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y]![x]) parts.push(`M${x + border} ${y + border}h1v1h-1z`);
    }
  }
  const cls = options.className ? ` class="${options.className}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="Código QR"${cls}><rect width="100%" height="100%" fill="${light}"/><path d="${parts.join('')}" fill="${dark}"/></svg>`;
}

/** Devuelve el QR como elemento SVG del DOM. */
export function toSvgElement(qr: QrCode, options?: Parameters<typeof toSvg>[1]): SVGSVGElement {
  const template = document.createElement('template');
  template.innerHTML = toSvg(qr, options);
  return template.content.firstElementChild as SVGSVGElement;
}
