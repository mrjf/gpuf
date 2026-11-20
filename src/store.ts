/** Durable, mailbox-scoped store used by the source-membership synchronizer. */
export interface Store {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: string): Promise<unknown>;
}
