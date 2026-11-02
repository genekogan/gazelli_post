export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
  BOARD_PASSWORD?: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET: string;
  DEV_DIRECT_UPLOAD?: string;
}

export interface Agent {
  id: number;
  handle: string;
  pubkey: string;
  display_name: string;
  bio: string;
  website: string | null;
  avatar_sha256: string;
  webhook_url: string | null;
  status: 'active' | 'revoked';
  registered_at: string;
  updated_at: string;
}

export type AppEnv = { Bindings: Env; Variables: { agent: Agent; rawBody: string } };
