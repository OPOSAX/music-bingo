/**
 * Almacén de la plataforma Bingo Hit: fichero JSON con escritura atómica y migraciones por versión.
 * Sin dependencias: sirve para un servidor único. Para varios servidores, sustituir por SQL manteniendo
 * la misma interfaz (colecciones + save()).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const COLLECTIONS = ['users', 'events', 'players', 'cards', 'orders', 'payments', 'eventAccess', 'promotions', 'webhookLog', 'audit', 'sessions'];

/** Migraciones: cada entrada lleva el fichero de la versión n a la n+1. */
export const MIGRATIONS = [
  // 0 → 1: esquema inicial
  (db) => {
    for (const c of COLLECTIONS) db[c] ??= [];
    db.settings ??= defaultSettings();
    return db;
  },
  // 1 → 2: acceso con usuario y contraseña (sesiones) y nombre de usuario por animador
  (db) => {
    db.sessions ??= [];
    for (const u of db.users) {
      u.username ??= (u.email || u.name || u.id).toLowerCase().replace(/[^a-z0-9._-]+/g, '.').replace(/^\.+|\.+$/g, '') || u.id;
      u.passwordHash ??= null;
    }
    return db;
  },
];

export function defaultPermissions() {
  return {
    canCreateLocalEvents: true,
    canCreateOnlineEvents: true,
    canCreateHybridEvents: false,
    canCreateFreeEvents: true,
    canCreatePaidEvents: false,
    canSetCardPrice: false,
    canStartLive: true,
    maxEventCapacity: 500,
  };
}

export function defaultSettings() {
  return {
    payments: {
      provider: 'mock', // mock | transbank | mercadopago
      providers: { transbank: { commerceCode: '', apiKey: '', environment: 'integration' }, mercadopago: { accessToken: '', webhookSecret: '' } },
    },
    pricing: { hostCanSetPrice: false, minimumCardPrice: 0, maximumCardPrice: 0, fixedCardPrice: 3000, defaultCurrency: 'CLP' },
    limits: { maxEventCapacity: 5000, maxCardsPerPlayer: 10 },
    commission: { platformFeePct: 0 },
  };
}

export class Store {
  constructor(file) {
    this.file = file;
    this.db = null;
    this.load();
  }

  load() {
    let db = { schemaVersion: 0 };
    if (this.file && existsSync(this.file)) {
      try {
        db = JSON.parse(readFileSync(this.file, 'utf8'));
      } catch (err) {
        throw new Error(`No se pudo leer ${this.file}: ${err.message}`);
      }
    }
    db.schemaVersion ??= 0;
    const from = db.schemaVersion;
    while (db.schemaVersion < MIGRATIONS.length) {
      db = MIGRATIONS[db.schemaVersion](db);
      db.schemaVersion++;
    }
    this.db = db;
    if (this.file && from !== db.schemaVersion) this.save();
  }

  save() {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    renameSync(tmp, this.file);
  }

  get settings() {
    return this.db.settings;
  }

  list(collection, predicate = () => true) {
    return this.db[collection].filter(predicate);
  }

  find(collection, predicate) {
    return this.db[collection].find(predicate) ?? null;
  }

  get(collection, id) {
    return this.find(collection, (r) => r.id === id);
  }

  insert(collection, record) {
    this.db[collection].push(record);
    this.save();
    return record;
  }

  update(collection, id, patch) {
    const record = this.get(collection, id);
    if (!record) return null;
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return record;
  }

  audit(actor, action, details = {}) {
    this.db.audit.push({ t: new Date().toISOString(), actor, action, ...details });
    if (this.db.audit.length > 5000) this.db.audit.splice(0, this.db.audit.length - 5000);
    this.save();
  }
}
