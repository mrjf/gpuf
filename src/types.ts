export type ArchiveSearch = {
  query?: string;
  text?: string;
  mode?: 'gmail' | 'exact' | 'words' | 'semantic' | 'hybrid';
  from?: string;
  to?: string;
  participant?: string;
  messageId?: string;
  thread?: string;
  labels?: string[];
  after?: string;
  before?: string;
  unread?: boolean;
  hasAttachment?: boolean;
  limit?: number;
  cursor?: string;
};
