import { readFile } from 'node:fs/promises';
import { z } from 'zod';

export type AdminDirectoryQuery = {
  search: string;
  offset: number;
  limit: number;
};
export type AdminDirectoryResult = {
  status: 'available';
  admins: { id: string; username: string }[];
  total: number;
  offset: number;
  limit: number;
};
export interface AdminDirectory {
  list(query: AdminDirectoryQuery): Promise<AdminDirectoryResult>;
}

export class DirectoryUnavailable extends Error {
  constructor() {
    super('DIRECTORY_UNAVAILABLE');
  }
}

const upstreamAdmin = z.object({
  id: z.number().int().safe().nonnegative(),
  username: z.string().trim().min(1).max(100),
});
const upstreamList = z.object({
  admins: z.array(upstreamAdmin).max(50),
  total: z.number().int().safe().nonnegative().max(1_000_000_000),
});

// The upstream response may add properties. Only these two allowlisted fields cross
// the Owner API boundary; no upstream profile, role or private data is returned.
export class PasarguardAdminDirectory implements AdminDirectory {
  private readonly endpoint: string;
  constructor(
    baseUrl: string,
    private readonly keyFile: string,
    private readonly http: typeof fetch = fetch,
    private readonly keyReader: (
      path: string,
      encoding: 'utf8',
    ) => Promise<string> = readFile,
  ) {
    const url = new URL(baseUrl);
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      url.port
    )
      throw new Error('INVALID_DIRECTORY_BASE_URL');
    this.endpoint = new URL('/api/admins/simple', url).toString();
  }

  async list(query: AdminDirectoryQuery): Promise<AdminDirectoryResult> {
    try {
      const key = (await this.keyReader(this.keyFile, 'utf8')).trim();
      if (!key || key.length > 512 || /[\r\n\x00-\x1f\x7f]/.test(key))
        throw new DirectoryUnavailable();

      const url = new URL(this.endpoint);
      if (query.search) url.searchParams.set('search', query.search);
      url.searchParams.set('offset', String(query.offset));
      url.searchParams.set('limit', String(query.limit));
      const response = await this.http(url, {
        method: 'GET',
        headers: { 'X-Api-Key': key, Accept: 'application/json' },
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        signal: AbortSignal.timeout(3500),
      });
      if (!response.ok || !response.body) throw new DirectoryUnavailable();
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 65_536) {
            await reader.cancel();
            throw new DirectoryUnavailable();
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const data = upstreamList.parse(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      );
      if (data.admins.length > query.limit || data.admins.length > data.total)
        throw new DirectoryUnavailable();
      const admins = data.admins.map(({ id, username }) => ({
        id: String(id),
        username,
      }));
      if (new Set(admins.map((admin) => admin.id)).size !== admins.length)
        throw new DirectoryUnavailable();
      return {
        status: 'available',
        admins,
        total: data.total,
        offset: query.offset,
        limit: query.limit,
      };
    } catch {
      // No credentials, upstream response, or network diagnostics in logs or HTTP.
      throw new DirectoryUnavailable();
    }
  }
}
