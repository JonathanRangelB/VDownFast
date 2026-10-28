import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { HTTPException } from 'hono/http-exception';
import { createHash, randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { isSupportedUrl, SUPPORTED_DOMAINS } from './domains.js';

type Strategy = 'direct' | 'proxy' | 'server';
type FormatKind = 'video' | 'audio' | 'image';
type DownloadOption = {
  key: string; kind: FormatKind; label: string; selector: string; ext: string;
  directUrl?: string; requiresProcessing: boolean; extractAudio?: boolean; height?: number; bitrate?: number;
};
type YtInfo = {
  title?: string; ext?: string; url?: string; thumbnail?: string;
  formats?: Array<Record<string, unknown>>;
  requested_formats?: Array<Record<string, unknown>>;
  http_headers?: Record<string, string>;
  thumbnails?: Array<Record<string, unknown>>;
};
type ResolveRecord = {
  source: string; title: string; ext: string; thumbnail?: string;
  headers: Record<string, string>; formats: DownloadOption[]; defaultFormat: string;
  defaultSelector: string; expires: number;
};
type ProxyRecord = {
  media: ResolveRecord; format: DownloadOption; directUrl: string; jobId: string; expires: number;
};
type DownloadJob = { status: 'waiting' | 'downloading' | 'complete' | 'error'; error?: string; createdAt: number; expires: number };

const PORT = Number(process.env.PORT || 3000);
const COOKIES_PATH = process.env.COOKIES_PATH || '/data/cookies.txt';
const DOWNLOAD_DIR = '/tmp/dl';
const SESSION_DB_PATH = path.resolve(process.env.SESSION_DB_PATH || '.data/sessions.sqlite');
const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 30);
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_COOKIE = IS_PRODUCTION ? '__Host-vdown_session' : 'vdown_session';
const CACHE_TTL = 5 * 60_000;
const VIDEO_FORMAT = 'bv*+ba/b';
const DEFAULT_1080_SELECTOR = 'bv*[height<=1080]+ba/b[height<=1080]';
const cache = new Map<string, ResolveRecord>();
const resolving = new Map<string, Promise<ResolveRecord>>();
const proxyTokens = new Map<string, ProxyRecord>();
const files = new Map<string, { path: string; title: string; expires: number }>();
const downloadJobs = new Map<string, DownloadJob>();

class ProcessQueue {
  private active = 0;
  private waiters: Array<() => void> = [];
  async acquire(): Promise<() => void> {
    if (this.active < 3) this.active++;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    };
  }
}
const processQueue = new ProcessQueue();

function createDownloadJob(id: string, status: DownloadJob['status'] = 'waiting'): void {
  const now = Date.now();
  downloadJobs.set(id, { status, createdAt: now, expires: now + 24 * 60 * 60_000 });
}
function updateDownloadJob(id: string, status: DownloadJob['status'], error?: string): void {
  const job = downloadJobs.get(id);
  if (!job) return;
  job.status = status;
  if (error) job.error = error;
  job.expires = Date.now() + 24 * 60 * 60_000;
}

class YtDlpFailure extends Error {
  constructor(message: string, readonly stderr: string) { super(message); }
}

const SCRYPT_OPTIONS = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const PASSWORD_KEY_LENGTH = 64;
type PasswordVerifier = { salt: Buffer; hash: Buffer };

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, PASSWORD_KEY_LENGTH, SCRYPT_OPTIONS, (error, derived) => {
      if (error) reject(error);
      else resolve(derived as Buffer);
    });
  });
}

function readPasswordVerifier(encoded: string): PasswordVerifier {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || parts[1] !== '32768' || parts[2] !== '8' || parts[3] !== '1') {
    throw new Error('AUTH_PASS_HASH no tiene el formato scrypt esperado. Genera uno con `npm run auth:hash`.');
  }
  const salt = Buffer.from(parts[4], 'base64url');
  const hash = Buffer.from(parts[5], 'base64url');
  if (salt.length !== 16 || hash.length !== PASSWORD_KEY_LENGTH) throw new Error('AUTH_PASS_HASH no es válido.');
  return { salt, hash };
}

const authUser = process.env.AUTH_USER?.trim() || '';
const configuredPassHash = process.env.AUTH_PASS_HASH?.trim() || '';
const legacyAuthPass = process.env.AUTH_PASS || '';
let passwordVerifier: PasswordVerifier | undefined;
if (configuredPassHash) passwordVerifier = readPasswordVerifier(configuredPassHash);
else if (legacyAuthPass && !IS_PRODUCTION) {
  const salt = randomBytes(16);
  passwordVerifier = { salt, hash: scryptSync(legacyAuthPass, salt, PASSWORD_KEY_LENGTH, SCRYPT_OPTIONS) };
  console.warn('[auth] AUTH_PASS está obsoleto; reemplázalo por AUTH_PASS_HASH generado con npm run auth:hash.');
}
if (IS_PRODUCTION && legacyAuthPass && !configuredPassHash) throw new Error('AUTH_PASS no se admite en producción; configura AUTH_PASS_HASH con un hash scrypt.');
if (Boolean(authUser) !== Boolean(passwordVerifier)) throw new Error('Configura juntos AUTH_USER y AUTH_PASS_HASH.');
const authEnabled = Boolean(authUser && passwordVerifier);
if (IS_PRODUCTION && !authEnabled) throw new Error('En producción se requiere AUTH_USER y AUTH_PASS_HASH.');
if (!Number.isInteger(SESSION_TTL_DAYS) || SESSION_TTL_DAYS < 1 || SESSION_TTL_DAYS > 90) {
  throw new Error('SESSION_TTL_DAYS debe ser un número entero entre 1 y 90.');
}

await mkdir(path.dirname(SESSION_DB_PATH), { recursive: true });
const sessionDb = new DatabaseSync(SESSION_DB_PATH);
sessionDb.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
`);
const sessionLookup = sessionDb.prepare('SELECT username, expires_at FROM sessions WHERE token_hash = ?');
const sessionInsert = sessionDb.prepare('INSERT INTO sessions (token_hash, username, created_at, expires_at) VALUES (?, ?, ?, ?)');
const sessionDelete = sessionDb.prepare('DELETE FROM sessions WHERE token_hash = ?');
const expiredSessionsDelete = sessionDb.prepare('DELETE FROM sessions WHERE expires_at <= ?');
const loginAttempts = new Map<string, { count: number; windowStart: number }>();

function sessionTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
function readSessionToken(cookieHeader?: string): string | undefined {
  const prefix = `${SESSION_COOKIE}=`;
  const entry = cookieHeader?.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
  const token = entry?.slice(prefix.length);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}
function getSession(token: string): { username: string; expiresAt: number } | undefined {
  const tokenHash = sessionTokenHash(token);
  const row = sessionLookup.get(tokenHash) as { username: string; expires_at: number } | undefined;
  if (!row) return undefined;
  if (row.expires_at <= Date.now()) {
    sessionDelete.run(tokenHash);
    return undefined;
  }
  return { username: row.username, expiresAt: row.expires_at };
}
function setSessionCookie(c: import('hono').Context, token: string, maxAgeSeconds: number): void {
  const secure = IS_PRODUCTION ? '; Secure' : '';
  c.header('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`);
}
function clearSessionCookie(c: import('hono').Context): void {
  const secure = IS_PRODUCTION ? '; Secure' : '';
  c.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}
function requestHasSameOrigin(c: import('hono').Context): boolean {
  const origin = c.req.header('origin');
  if (!origin) return true;
  try { return new URL(origin).host === c.req.header('host'); } catch { return false; }
}
function loginRateLimitKey(c: import('hono').Context): string {
  return c.req.header('cf-connecting-ip')
    || c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim()
    || 'unknown';
}
function consumeLoginAttempt(key: string): boolean {
  const now = Date.now();
  const old = loginAttempts.get(key);
  if (!old || now - old.windowStart >= 15 * 60_000) {
    loginAttempts.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (old.count >= 5) return false;
  old.count++;
  return true;
}

function cookieArgs(): string[] {
  return existsSync(COOKIES_PATH) ? ['--cookies', COOKIES_PATH] : [];
}

async function runYtDlp(args: string[], timeoutMs = 30_000, stdoutLimit = 12 * 1024 * 1024, captureStdout = true): Promise<string> {
  const release = await processQueue.acquire();
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', [...cookieArgs(), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (!captureStdout) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout) > stdoutLimit) child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk: string) => { if (stderr.length < 16_000) stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); release(); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      release();
      if (code === 0) resolve(stdout);
      else reject(timedOut ? new YtDlpFailure('La plataforma tardó demasiado en responder.', stderr) : new YtDlpFailure(friendlyYtError(stderr, code).message, stderr));
    });
  });
}

function friendlyYtError(stderr: string, code: number | null): Error {
  const value = stderr.toLowerCase();
  if (value.includes('private') || value.includes('login') || value.includes('sign in')) return new Error('El contenido es privado o requiere cookies válidas.');
  if (value.includes('unsupported url')) return new Error('Este enlace no es compatible o no contiene contenido descargable.');
  if (value.includes('404') || value.includes('not found')) return new Error('No se encontró el contenido; comprueba que el enlace siga disponible.');
  if (value.includes('429') || value.includes('too many requests')) return new Error('La plataforma limitó temporalmente las solicitudes. Inténtalo más tarde.');
  if (value.includes('timed out') || value.includes('timeout')) return new Error('La plataforma tardó demasiado en responder.');
  return new Error(code === null ? 'No se pudo completar la descarga.' : 'No se pudo obtener el contenido de esa URL.');
}

function cleanTitle(title?: string): string {
  const clean = (title || 'descarga').normalize('NFKC').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150);
  return clean || 'descarga';
}
function usableUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; } catch { return; }
}
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'tif', 'tiff']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'm4b', 'mka', 'aac', 'opus', 'ogg', 'wav', 'flac', 'wma', 'aif', 'aiff', 'ac3']);

function safeFormatId(format: Record<string, unknown>): string | undefined {
  return typeof format.format_id === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(format.format_id)
    ? format.format_id
    : undefined;
}
function formatBitrate(format: Record<string, unknown>): number {
  return Number(format.abr || format.tbr || format.preference || 0);
}
function formatQuality(format: Record<string, unknown>): number {
  const ext = String(format.ext || '').toLowerCase();
  const videoCodec = String(format.vcodec || '').toLowerCase();
  const audioCodec = String(format.acodec || '').toLowerCase();
  const compatibility = (ext === 'mp4' ? 4 : 0)
    + (/^(avc1|h264)/.test(videoCodec) ? 4 : 0)
    + (/^(mp4a|aac)/.test(audioCodec) ? 2 : 0);
  return compatibility * 1_000_000_000_000
    + Number(format.tbr || format.quality || format.preference || 0) * 1000
    + Number(format.fps || 0);
}
function optionFromFormat(
  key: string,
  kind: FormatKind,
  format: Record<string, unknown>,
  selector: string,
  label: string,
  requiresProcessing: boolean,
  extra: { height?: number; bitrate?: number; extractAudio?: boolean } = {}
): DownloadOption {
  const ext = typeof format.ext === 'string' ? format.ext.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() : '';
  const process = requiresProcessing || (kind === 'video' && Boolean(ext) && !['mp4', 'm4v'].includes(ext));
  return {
    key, kind, label, selector,
    ext: process ? (kind === 'video' ? 'mp4' : kind === 'audio' ? 'm4a' : ext || 'jpg') : ext || (kind === 'video' ? 'mp4' : kind === 'audio' ? 'm4a' : 'jpg'),
    directUrl: process ? undefined : usableUrl(format.url),
    requiresProcessing: process || !usableUrl(format.url), ...extra
  };
}

function buildFormatOptions(info: YtInfo): { formats: DownloadOption[]; defaultFormat: string; defaultSelector: string } {
  const raw = (info.formats || []).filter((format) => safeFormatId(format));
  const audioOnly = raw.filter((format) => format.vcodec === 'none' && format.acodec && format.acodec !== 'none');
  audioOnly.sort((a, b) => formatBitrate(b) - formatBitrate(a));
  const bestAudio = [...audioOnly].sort((a, b) => {
    const compatible = (format: Record<string, unknown>) => {
      const codec = String(format.acodec || '').toLowerCase();
      const ext = String(format.ext || '').toLowerCase();
      return codec.startsWith('mp4a') || codec === 'aac' || ext === 'm4a' ? 1 : 0;
    };
    return compatible(b) - compatible(a) || formatBitrate(b) - formatBitrate(a);
  })[0];
  const videoByHeight = new Map<number, Record<string, unknown>>();
  for (const format of raw) {
    if (!format.vcodec || format.vcodec === 'none') continue;
    const resolutionHeight = typeof format.resolution === 'string' ? Number(format.resolution.match(/x(\d+)$/)?.[1] || 0) : 0;
    const height = Number(format.height || resolutionHeight || 0);
    if (!height) continue;
    const previous = videoByHeight.get(height);
    if (!previous || formatQuality(format) > formatQuality(previous)) videoByHeight.set(height, format);
  }
  let videoFormats = [...videoByHeight.entries()].sort((a, b) => b[0] - a[0]);
  if (!bestAudio) videoFormats = videoFormats.filter(([, format]) => format.acodec && format.acodec !== 'none');

  const formats: DownloadOption[] = [];
  const videos = videoFormats.map(([height, format]) => {
    const id = safeFormatId(format)!;
    const hasAudio = Boolean(format.acodec && format.acodec !== 'none');
    const selector = hasAudio ? id : bestAudio ? `${id}+${safeFormatId(bestAudio)}` : id;
    const ext = typeof format.ext === 'string' ? format.ext.toUpperCase() : 'VIDEO';
    const fps = Number(format.fps || 0);
    const option = optionFromFormat(
      `v_${id}`, 'video', format, selector,
      `Vídeo · ${height}p${fps ? ` · ${fps} fps` : ''} · ${ext} · con audio`,
      !hasAudio,
      { height }
    );
    formats.push(option);
    return option;
  });

  audioOnly.forEach((format) => {
    const id = safeFormatId(format)!;
    const bitrate = formatBitrate(format);
    const ext = typeof format.ext === 'string' ? format.ext.toUpperCase() : 'AUDIO';
    formats.push(optionFromFormat(
      `a_${id}`, 'audio', format, id,
      `Solo audio · ${bitrate ? `${Math.round(bitrate)} kbps · ` : ''}${ext}`,
      false, { bitrate }
    ));
  });

  if (audioOnly.length === 0) {
    const combined = raw.filter((format) => format.vcodec && format.vcodec !== 'none' && format.acodec && format.acodec !== 'none')
      .sort((a, b) => formatQuality(b) - formatQuality(a))[0];
    if (combined) {
      const id = safeFormatId(combined)!;
      const ext = typeof combined.ext === 'string' ? combined.ext.toUpperCase() : 'VIDEO';
      formats.push(optionFromFormat(
        `a_extract_${id}`, 'audio', combined, id, `Solo audio · extraído de la mejor fuente (${ext})`,
        true, { extractAudio: true, bitrate: formatBitrate(combined) }
      ));
    }
  }

  const images = raw.filter((format) => {
    const ext = typeof format.ext === 'string' ? format.ext.toLowerCase() : '';
    return IMAGE_EXTENSIONS.has(ext) && (!format.acodec || format.acodec === 'none') && (!format.vcodec || format.vcodec === 'none');
  });
  images.forEach((format) => {
    const id = safeFormatId(format)!;
    const ext = typeof format.ext === 'string' ? format.ext.toUpperCase() : 'IMAGE';
    formats.push(optionFromFormat(`i_${id}`, 'image', format, id, `Imagen · ${ext}`, false));
  });
  if (formats.length === 0 && usableUrl(info.url)) {
    const ext = (info.ext || 'mp4').toLowerCase();
    const kind: FormatKind = IMAGE_EXTENSIONS.has(ext) ? 'image' : AUDIO_EXTENSIONS.has(ext) ? 'audio' : 'video';
    const requiresProcessing = kind === 'video';
    formats.push({
      key: kind === 'image' ? 'i0' : kind === 'audio' ? 'a0' : 'v0', kind,
      label: kind === 'image' ? `Imagen · ${ext.toUpperCase()}` : kind === 'audio' ? `Solo audio · ${ext.toUpperCase()}` : 'Vídeo · calidad disponible · con audio',
      selector: kind === 'video' ? `${DEFAULT_1080_SELECTOR}/${VIDEO_FORMAT}` : kind === 'audio' ? 'ba/b' : VIDEO_FORMAT,
      ext: requiresProcessing ? 'mp4' : ext,
      directUrl: requiresProcessing ? undefined : usableUrl(info.url), requiresProcessing, extractAudio: kind === 'audio'
    });
  }

  const defaultVideo = videos.find((format) => (format.height || 0) <= 1080) || videos.at(-1);
  const defaultOption = defaultVideo || formats.find((format) => format.kind === 'audio') || formats.find((format) => format.kind === 'image');
  const lowestVideo = videos.at(-1);
  const defaultSelector = defaultOption?.selector || VIDEO_FORMAT;
  return { formats, defaultFormat: defaultOption?.key || '', defaultSelector };
}
function chooseThumbnail(info: YtInfo): string | undefined {
  const thumbs = (info.thumbnails || []).filter((t) => usableUrl(t.url));
  thumbs.sort((a, b) => Number(b.width || 0) * Number(b.height || 0) - Number(a.width || 0) * Number(a.height || 0));
  return usableUrl(thumbs[0]?.url) || usableUrl(info.thumbnail);
}
function parseInfo(json: string): YtInfo {
  const firstLine = json.trim().split('\n').find(Boolean);
  if (!firstLine) throw new Error('No se encontró contenido descargable.');
  return JSON.parse(firstLine) as YtInfo;
}

async function resolve(url: string): Promise<ResolveRecord> {
  const old = cache.get(url);
  if (old && old.expires > Date.now()) return old;
  let task = resolving.get(url);
  if (!task) {
    task = (async () => {
      const info = parseInfo(await runYtDlp(['--no-playlist', '--no-warnings', '--dump-single-json', url]));
      const selection = buildFormatOptions(info);
      if (selection.formats.length === 0) throw new Error('No se encontraron formatos de video, audio o imagen para este contenido.');
      const thumbnail = chooseThumbnail(info);
      if (thumbnail) {
        for (const format of selection.formats) {
          if (format.kind === 'video') {
            format.directUrl = undefined;
            format.requiresProcessing = true;
            format.ext = 'mp4';
          }
        }
      }
      const record: ResolveRecord = {
        source: url, title: cleanTitle(info.title), ext: (info.ext || selection.formats.find((format) => format.key === selection.defaultFormat)?.ext || 'mp4').replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'mp4',
        thumbnail, headers: safeHeaders(info.http_headers), ...selection, expires: Date.now() + CACHE_TTL
      };
      cache.set(url, record);
      return record;
    })();
    resolving.set(url, task);
  }
  try { return await task; }
  finally { if (resolving.get(url) === task) resolving.delete(url); }
}

function chooseFormat(record: ResolveRecord, requestedKey?: string): DownloadOption {
  const option = requestedKey
    ? record.formats.find((format) => format.key === requestedKey)
    : record.formats.find((format) => format.key === record.defaultFormat);
  if (!option) throw new Error('La opción elegida no está disponible. Vuelve a analizar el enlace.');
  if (!requestedKey && option.key === record.defaultFormat && record.defaultSelector !== option.selector) {
    return {
      ...option, selector: record.defaultSelector, directUrl: undefined, requiresProcessing: true,
      ext: option.kind === 'video' ? 'mp4' : option.kind === 'audio' ? 'm4a' : option.ext
    };
  }
  return option;
}

const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'flv', 'ts', '3gp', 'ogv']);
const AUDIO_FORMAT_EXTENSIONS = new Set(['mp3', 'm4a', 'm4b', 'mka', 'aac', 'opus', 'ogg', 'wav', 'flac', 'wma', 'aif', 'aiff', 'ac3']);

async function runFfmpeg(args: string[]): Promise<void> {
  const release = await processQueue.acquire();
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 3 * 60_000);
    child.stderr.resume();
    child.on('error', (error) => { clearTimeout(timer); release(); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      release();
      if (code === 0) resolve();
      else reject(new Error(timedOut ? 'La incrustación de la miniatura tardó demasiado.' : 'No se pudo incrustar la miniatura en el MP4.'));
    });
  });
}

async function downloadToTemp(source: string, fileId: string, option: DownloadOption, embedThumbnail = false): Promise<string> {
  await mkdir(DOWNLOAD_DIR, { recursive: true });
  const template = path.join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);
  const args = ['--no-playlist', '--no-warnings', '--no-simulate'];
  if (option.kind !== 'image') args.push('-f', option.selector);
  if (option.kind === 'video') args.push('--merge-output-format', 'mp4', '--remux-video', 'mp4');
  if (option.extractAudio) args.push('-x', '--audio-format', 'best');
  if (embedThumbnail && option.kind === 'video') args.push('--write-thumbnail', '--convert-thumbnails', 'jpg');
  args.push('--print', 'after_move:filepath', '-o', template, source);
  try {
    const output = await runYtDlp(args, 30 * 60_000, 64 * 1024);
    const reportedPath = output.trim().split(/\r?\n/).at(-1);
    const safeReportedPath = reportedPath ? path.resolve(reportedPath) : '';
    const validExtensions = option.kind === 'image' ? IMAGE_EXTENSIONS : option.kind === 'audio' ? AUDIO_FORMAT_EXTENSIONS : VIDEO_EXTENSIONS;
    const validReportedPath = safeReportedPath.startsWith(`${path.resolve(DOWNLOAD_DIR)}${path.sep}`)
      && path.basename(safeReportedPath).startsWith(`${fileId}.`)
      && validExtensions.has(path.extname(safeReportedPath).slice(1).toLowerCase());
    let mediaPath: string | undefined;
    if (validReportedPath) {
      const info = await stat(safeReportedPath);
      if (info.isFile() && info.size > 0) mediaPath = safeReportedPath;
    }
    const names = await readdir(DOWNLOAD_DIR);
    const candidate = mediaPath ? undefined : names.find((name) => {
      const ext = path.extname(name).slice(1).toLowerCase();
      return name.startsWith(`${fileId}.`) && validExtensions.has(ext) && !name.endsWith('.part');
    });
    if (candidate) {
      const candidatePath = path.join(DOWNLOAD_DIR, candidate);
      const info = await stat(candidatePath);
      if (info.isFile() && info.size > 0) mediaPath = candidatePath;
    }
    if (!mediaPath) throw new Error('yt-dlp no generó un archivo multimedia válido.');

    if (embedThumbnail && option.kind === 'video') {
      const thumbnailPath = names
        .filter((name) => name.startsWith(`${fileId}.`) && IMAGE_EXTENSIONS.has(path.extname(name).slice(1).toLowerCase()))
        .map((name) => path.join(DOWNLOAD_DIR, name))
        .sort((a, b) => Number(path.extname(a).toLowerCase() !== '.jpg') - Number(path.extname(b).toLowerCase() !== '.jpg'))[0];
      if (thumbnailPath) {
        const embeddedPath = path.join(DOWNLOAD_DIR, `${fileId}.embedded.mp4`);
        await runFfmpeg([
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
          '-i', mediaPath, '-i', thumbnailPath,
          '-map', '0:v:0', '-map', '0:a?', '-map', '1:v:0', '-c', 'copy',
          '-disposition:v:1', 'attached_pic',
          '-metadata:s:v:1', 'title=Cover',
          '-metadata:s:v:1', 'comment=Cover (front)',
          '-movflags', '+faststart', embeddedPath
        ]);
        const embeddedInfo = await stat(embeddedPath);
        if (!embeddedInfo.isFile() || embeddedInfo.size === 0) throw new Error('ffmpeg generó un video vacío al incrustar la miniatura.');
        await unlink(mediaPath);
        await rename(embeddedPath, mediaPath);
      }
    }
    const leftovers = await readdir(DOWNLOAD_DIR);
    await Promise.all(leftovers.filter((name) => name.startsWith(`${fileId}.`) && path.join(DOWNLOAD_DIR, name) !== mediaPath)
      .map((name) => unlink(path.join(DOWNLOAD_DIR, name)).catch(() => {})));
    return mediaPath;
  } catch (error) {
    const names = await readdir(DOWNLOAD_DIR).catch(() => []);
    await Promise.all(names.filter((name) => name.startsWith(`${fileId}.`)).map((name) => unlink(path.join(DOWNLOAD_DIR, name)).catch(() => {})));
    throw error;
  }
}

function safeHeaders(input?: Record<string, string>): Record<string, string> {
  const allowed = new Set(['user-agent', 'referer', 'accept', 'accept-language']);
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input || {})) if (allowed.has(key.toLowerCase()) && typeof value === 'string' && value.length < 2000) output[key] = value;
  return output;
}

const app = new Hono();
app.use('*', compress());
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  await next();
});

const publicApiPaths = new Set(['/api/auth/login', '/api/auth/session', '/api/auth/logout']);
app.use('/api/*', async (c, next) => {
  if (!authEnabled || publicApiPaths.has(c.req.path)) return next();
  const token = readSessionToken(c.req.header('cookie'));
  const session = token ? getSession(token) : undefined;
  if (!session) {
    clearSessionCookie(c);
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'La sesión expiró. Inicia sesión nuevamente.' }, 401);
  }
  if (c.req.method === 'POST' && !requestHasSameOrigin(c)) return c.json({ error: 'Origen de solicitud no permitido.' }, 403);
  await next();
});

app.get('/api/auth/session', (c) => {
  c.header('Cache-Control', 'no-store');
  if (!authEnabled) return c.json({ authenticated: true, authEnabled: false });
  const token = readSessionToken(c.req.header('cookie'));
  const session = token ? getSession(token) : undefined;
  return c.json(session
    ? { authenticated: true, authEnabled: true, username: session.username, expiresAt: session.expiresAt }
    : { authenticated: false, authEnabled: true });
});

app.post('/api/auth/login', async (c) => {
  c.header('Cache-Control', 'no-store');
  if (!requestHasSameOrigin(c)) return c.json({ error: 'Origen de solicitud no permitido.' }, 403);
  const key = loginRateLimitKey(c);
  if (!consumeLoginAttempt(key)) {
    c.header('Retry-After', '900');
    return c.json({ error: 'Demasiados intentos. Espera 15 minutos e inténtalo nuevamente.' }, 429);
  }
  if (!authEnabled || !passwordVerifier) return c.json({ error: 'El inicio de sesión no está configurado.' }, 503);
  if (Number(c.req.header('content-length') || 0) > 16_384) return c.json({ error: 'La solicitud es demasiado grande.' }, 413);
  let body: { username?: unknown; password?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Solicitud inválida.' }, 400); }
  if (typeof body.username !== 'string' || typeof body.password !== 'string' || body.username.length > 256 || body.password.length > 1024) {
    return c.json({ error: 'Usuario o contraseña incorrectos.' }, 401);
  }
  const passwordHash = await derivePassword(body.password, passwordVerifier.salt);
  const passwordMatches = timingSafeEqual(passwordHash, passwordVerifier.hash);
  if (body.username !== authUser || !passwordMatches) return c.json({ error: 'Usuario o contraseña incorrectos.' }, 401);

  loginAttempts.delete(key);
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  expiredSessionsDelete.run(now);
  sessionInsert.run(sessionTokenHash(token), authUser, now, expiresAt);
  setSessionCookie(c, token, SESSION_TTL_DAYS * 24 * 60 * 60);
  return c.json({ authenticated: true, username: authUser, expiresAt });
});

app.post('/api/auth/logout', (c) => {
  c.header('Cache-Control', 'no-store');
  if (!requestHasSameOrigin(c)) return c.json({ error: 'Origen de solicitud no permitido.' }, 403);
  const token = readSessionToken(c.req.header('cookie'));
  if (token) sessionDelete.run(sessionTokenHash(token));
  clearSessionCookie(c);
  return c.json({ ok: true });
});

app.post('/api/formats', async (c) => {
  c.header('Cache-Control', 'no-store');
  let body: { url?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Solicitud inválida.' }, 400); }
  if (typeof body.url !== 'string' || body.url.length > 8192) return c.json({ error: 'Introduce una URL válida.' }, 400);
  const parsed = isSupportedUrl(body.url);
  if (!parsed || parsed.username || parsed.password) return c.json({ error: 'La URL debe pertenecer a una plataforma compatible.' }, 400);
  try {
    const record = await resolve(parsed.href);
    return c.json({
      title: record.title,
      defaultFormat: record.defaultFormat,
      formats: record.formats.map(({ key, kind, label, ext, height, bitrate }) => ({ key, kind, label, ext, height, bitrate }))
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'No se pudieron analizar los formatos.' }, 502);
  }
});

app.get('/api/downloads/:id/status', (c) => {
  c.header('Cache-Control', 'no-store');
  const id = c.req.param('id');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return c.notFound();
  const job = downloadJobs.get(id);
  if (!job || job.expires <= Date.now()) { downloadJobs.delete(id); return c.notFound(); }
  return c.json({ status: job.status, error: job.error });
});

const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');
let html = (await readFile(htmlPath, 'utf8')).replace('__SUPPORTED_DOMAINS__', JSON.stringify(SUPPORTED_DOMAINS));
const htmlEtag = `"${createHash('sha256').update(html).digest('hex')}"`;
app.get('/', (c) => {
  c.header('ETag', htmlEtag);
  c.header('Cache-Control', 'private, no-cache, must-revalidate');
  const validators = c.req.header('if-none-match')?.split(',').map((value) => value.trim()) || [];
  if (validators.includes('*') || validators.includes(htmlEtag) || validators.includes(`W/${htmlEtag}`)) return c.body(null, 304);
  c.header('Content-Type', 'text/html; charset=utf-8');
  return c.body(html);
});

app.post('/api/resolve', async (c) => {
  let body: { url?: unknown; strategy?: unknown; format?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'La solicitud no contiene JSON válido.' }, 400); }
  if (typeof body.url !== 'string' || body.url.length > 8192) return c.json({ error: 'Introduce una URL válida.' }, 400);
  const parsed = isSupportedUrl(body.url);
  if (!parsed || parsed.username || parsed.password) return c.json({ error: 'La URL debe pertenecer a una plataforma compatible.' }, 400);
  const strategy = body.strategy;
  if (!['direct', 'proxy', 'server'].includes(String(strategy))) return c.json({ error: 'Estrategia de descarga no válida.' }, 400);
  if (body.format !== undefined && typeof body.format !== 'string') return c.json({ error: 'Formato de descarga no válido.' }, 400);
  const source = parsed.href;
  try {
    const record = await resolve(source);
    const format = chooseFormat(record, body.format as string | undefined);
    if (strategy === 'server') {
      const fileId = randomUUID();
      createDownloadJob(fileId);
      let filePath: string;
      try { filePath = await downloadToTemp(source, fileId, format, format.kind === 'video' && Boolean(record.thumbnail)); }
      catch (error) {
        updateDownloadJob(fileId, 'error', error instanceof Error ? error.message : 'No se pudo descargar el archivo.');
        throw error;
      }
      files.set(fileId, { path: filePath, title: record.title, expires: Date.now() + 15 * 60_000 });
      const token = randomUUID();
      proxyTokens.set(token, { media: record, format, directUrl: format.directUrl || source, jobId: fileId, expires: Date.now() + CACHE_TTL });
      return c.json({ mode: 'server', jobId: fileId, fileId, title: record.title, ext: path.extname(filePath).slice(1), thumbnail: record.thumbnail, token, kind: format.kind, formatLabel: format.label });
    }
    const mode = 'proxy';
    const token = randomUUID();
    const directUrl = format.directUrl || source;
    const jobId = randomUUID();
    createDownloadJob(jobId);
    proxyTokens.set(token, { media: record, format, directUrl, jobId, expires: Date.now() + CACHE_TTL });
    return c.json({ title: record.title, ext: format.ext, directUrl, thumbnail: record.thumbnail, mode, token, jobId, kind: format.kind, formatLabel: format.label });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'No se pudo resolver el enlace.';
    const status = message.includes('La opción elegida') ? 400 : message.startsWith('La URL') ? 400 : 502;
    return c.json({ error: message }, status);
  }
});

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0];
  if (isIP(normalized) === 4) {
    const nums = normalized.split('.').map(Number);
    const [a, b] = nums;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (isIP(normalized) === 6) {
    if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized)) return true;
    const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;
}
async function assertPublicHost(url: URL): Promise<void> {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('URL de streaming no permitida.');
  if (isIP(host)) { if (isPrivateAddress(host)) throw new Error('URL de streaming no permitida.'); return; }
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error('URL de streaming no permitida.');
}
function disposition(name: string): string {
  const safe = name.replace(/[\r\n"\\]/g, '_').slice(0, 240) || 'descarga';
  return `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

app.get('/api/proxy', async (c) => {
  const target = c.req.query('u');
  const name = c.req.query('name') || 'descarga';
  const token = c.req.query('t');
  const record = token ? proxyTokens.get(token) : undefined;
  if (!record || record.expires <= Date.now() || !target || target !== record.directUrl) {
    if (record) updateDownloadJob(record.jobId, 'error', 'El enlace de descarga caducó. Vuelve a intentarlo.');
    return c.json({ error: 'El enlace de streaming ha caducado. Vuelve a resolverlo.' }, 403);
  }
  updateDownloadJob(record.jobId, 'downloading');
  if (record.format.requiresProcessing || record.format.extractAudio) {
    try {
      const fileId = randomUUID();
      const filePath = await downloadToTemp(record.media.source, fileId, record.format, record.format.kind === 'video' && Boolean(record.media.thumbnail));
      files.set(fileId, { path: filePath, title: cleanTitle(name.replace(/\.[^.]+$/, '')), expires: Date.now() + 15 * 60_000 });
      const info = await stat(filePath);
      const outputExt = path.extname(filePath).slice(1).toLowerCase();
      const stream = createReadStream(filePath);
      c.header('Content-Disposition', disposition(`${name.replace(/\.[^.]+$/, '')}.${outputExt}`));
      c.header('Content-Type', outputExt === 'mp4' ? 'video/mp4' : 'application/octet-stream');
      c.header('Content-Length', String(info.size));
      c.header('Cache-Control', 'no-store');
      stream.on('end', () => updateDownloadJob(record.jobId, 'complete'));
      stream.on('error', () => updateDownloadJob(record.jobId, 'error', 'La transferencia del archivo falló.'));
      stream.on('close', () => {
        if (downloadJobs.get(record.jobId)?.status === 'downloading') updateDownloadJob(record.jobId, 'error', 'La descarga se interrumpió.');
        files.delete(fileId);
        void unlink(filePath).catch(() => {});
      });
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers: c.res.headers });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo generar el video MP4.';
      updateDownloadJob(record.jobId, 'error', message);
      return c.json({ error: message }, 502);
    }
  }
  try {
    let current = new URL(target);
    let upstream: Response | undefined;
    for (let redirects = 0; redirects <= 5; redirects++) {
      await assertPublicHost(current);
      const headers = new Headers(record.media.headers);
      const range = c.req.header('range');
      if (range) headers.set('Range', range);
      upstream = await fetch(current, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30 * 60_000)]) });
      if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
      const location = upstream.headers.get('location');
      if (!location || redirects === 5) {
        updateDownloadJob(record.jobId, 'error', 'El servidor de streaming redirigió demasiadas veces.');
        return c.json({ error: 'El servidor de streaming redirigió demasiadas veces.' }, 502);
      }
      current = new URL(location, current);
      if (!['http:', 'https:'].includes(current.protocol)) {
        updateDownloadJob(record.jobId, 'error', 'La URL de streaming no está permitida.');
        return c.json({ error: 'URL de streaming no permitida.' }, 403);
      }
    }
    if (!upstream) {
      updateDownloadJob(record.jobId, 'error', 'No se pudo abrir el archivo.');
      return c.json({ error: 'No se pudo abrir el archivo.' }, 502);
    }
    if (upstream.status < 200 || upstream.status >= 300) {
      updateDownloadJob(record.jobId, 'error', `La plataforma respondió con HTTP ${upstream.status}.`);
      return c.json({ error: 'La plataforma no pudo entregar el archivo.' }, 502);
    }
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(header);
      if (value) c.header(header, value);
    }
    c.header('Content-Disposition', disposition(name));
    c.header('Cache-Control', 'no-store');
    const body = upstream.body;
    if (!body) {
      updateDownloadJob(record.jobId, 'complete');
      return new Response(null, { status: upstream.status, headers: c.res.headers });
    }
    const reader = body.getReader();
    let finished = false;
    const monitoredBody = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) {
                finished = true;
                updateDownloadJob(record.jobId, 'complete');
                controller.close();
                return;
              }
              controller.enqueue(chunk.value);
            }
          } catch {
            finished = true;
            updateDownloadJob(record.jobId, 'error', 'La transferencia del archivo falló.');
            controller.error(new Error('La transferencia del archivo falló.'));
          }
        })();
      },
      async cancel() {
        if (!finished) updateDownloadJob(record.jobId, 'error', 'La descarga se interrumpió.');
        await reader.cancel();
      }
    });
    return new Response(monitoredBody, { status: upstream.status, headers: c.res.headers });
  } catch {
    updateDownloadJob(record.jobId, 'error', 'No se pudo transmitir el archivo de la plataforma.');
    return c.json({ error: 'No se pudo transmitir el archivo de la plataforma.' }, 502);
  }
});

app.get('/api/thumbnail', async (c) => {
  const token = c.req.query('t');
  const record = token ? proxyTokens.get(token) : undefined;
  if (!record || record.expires <= Date.now() || !record.media.thumbnail) return c.notFound();
  try {
    let url = new URL(record.media.thumbnail);
    await assertPublicHost(url);
    const response = await fetch(url, { headers: record.media.headers, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return c.notFound();
      url = new URL(location, url);
      await assertPublicHost(url);
      const redirected = await fetch(url, { headers: record.media.headers, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!redirected.ok) return c.notFound();
      c.header('Cache-Control', 'private, max-age=300');
      c.header('Content-Type', redirected.headers.get('content-type') || 'image/jpeg');
      return new Response(redirected.body, { headers: c.res.headers });
    }
    if (!response.ok) return c.notFound();
    c.header('Cache-Control', 'private, max-age=300');
    c.header('Content-Type', response.headers.get('content-type') || 'image/jpeg');
    return new Response(response.body, { headers: c.res.headers });
  } catch { return c.notFound(); }
});

app.get('/api/file/:id', async (c) => {
  const id = c.req.param('id');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return c.notFound();
  const entry = files.get(id);
  if (!entry || entry.expires <= Date.now()) {
    files.delete(id);
    if (downloadJobs.has(id)) updateDownloadJob(id, 'error', 'El archivo temporal ya no está disponible.');
    return c.notFound();
  }
  try {
    const info = await stat(entry.path);
    const stream = createReadStream(entry.path);
    updateDownloadJob(id, 'downloading');
    c.header('Content-Type', 'application/octet-stream');
    c.header('Content-Length', String(info.size));
    const ext = path.extname(entry.path).slice(1);
    c.header('Content-Disposition', disposition(`${entry.title}.${ext}`));
    c.header('Cache-Control', 'no-store');
    stream.on('end', () => updateDownloadJob(id, 'complete'));
    stream.on('error', () => updateDownloadJob(id, 'error', 'La transferencia del archivo falló.'));
    stream.on('close', () => {
      if (downloadJobs.get(id)?.status === 'downloading') updateDownloadJob(id, 'error', 'La descarga se interrumpió.');
      files.delete(id);
      void unlink(entry.path).catch(() => {});
    });
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers: c.res.headers });
  } catch {
    files.delete(id);
    updateDownloadJob(id, 'error', 'No se pudo abrir el archivo descargado.');
    return c.notFound();
  }
});

app.get('/healthz', (c) => c.text('ok'));
app.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
  console.error(`[request] ${error.message}`);
  return c.json({ error: 'Error interno al procesar la solicitud.' }, 500);
});

await mkdir(DOWNLOAD_DIR, { recursive: true });
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cache) if (value.expires <= now) cache.delete(key);
  for (const [key, value] of proxyTokens) if (value.expires <= now) proxyTokens.delete(key);
  for (const [key, value] of downloadJobs) if (value.expires <= now) downloadJobs.delete(key);
  for (const [id, value] of files) if (value.expires <= now) { files.delete(id); void unlink(value.path).catch(() => {}); }
}, 60_000).unref();
let updating = false;
const updateYtDlp = () => {
  if (updating) return;
  updating = true;
  void processQueue.acquire().then((release) => {
    const child = spawn('yt-dlp', ['-U'], { stdio: 'ignore' });
    child.on('close', (code) => { release(); updating = false; if (code !== 0) console.warn('[yt-dlp] actualización no disponible'); });
    child.on('error', () => { release(); updating = false; console.warn('[yt-dlp] actualización no disponible'); });
  }).catch(() => { updating = false; });
};
setInterval(updateYtDlp, 24 * 60 * 60_000).unref();
serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => console.log(`VDownFast escuchando en :${info.port}`));
