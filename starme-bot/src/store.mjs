import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

export class Store {
  constructor(root) {
    this.root = root;
    this.sessionsDir = join(root, 'sessions');
    this.imagesDir = join(root, 'images');
  }

  async init() {
    mkdirSync(this.sessionsDir, { recursive: true });
    mkdirSync(this.imagesDir, { recursive: true });
  }

  _sessionPath(userId) {
    return join(this.sessionsDir, encodeURIComponent(String(userId)) + '.json');
  }

  getSession(userId) {
    const path = this._sessionPath(userId);
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  saveSession(session) {
    const path = this._sessionPath(session.userId);
    const tmp = path + '.tmp-' + randomUUID();
    writeFileSync(tmp, JSON.stringify(session, null, 2) + '\n');
    renameSync(tmp, path);
  }

  deleteSession(userId) {
    const path = this._sessionPath(userId);
    try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  async saveImage(kind, userId, buffer, meta = {}) {
    const ext = meta.mimeType && MIME_EXT[meta.mimeType] ? MIME_EXT[meta.mimeType]
      : (extname(meta.filename || '') || '.jpg');
    const name = `${kind}/${Date.now()}-${randomUUID()}${ext}`;
    const dir = join(this.imagesDir, kind);
    mkdirSync(dir, { recursive: true });
    const path = join(this.imagesDir, name);
    writeFileSync(path, buffer);
    return {
      path,
      kind,
      mimeType: meta.mimeType || 'image/jpeg',
      filename: meta.filename || `${kind}${ext}`,
      size: buffer.length,
      createdAt: new Date().toISOString(),
    };
  }

  loadImage(path) {
    return readFileSync(path);
  }

  deleteImage(path) {
    try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  imageSize(path) {
    try { return statSync(path).size; } catch { return null; }
  }
}
