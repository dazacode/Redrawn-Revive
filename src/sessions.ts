/**
 * Tiny in-memory session store remembering which movie a client is editing,
 * so asset uploads (which carry no movie id) land in the right cache bucket.
 * Keyed by x-forwarded-for, else the socket address.
 */
export type Session = { movieId?: string };

const sessions = new Map<string, Session>();

export function sessionKey(req: Request, ip: string | null): string {
  const xff = req.headers.get("x-forwarded-for");
  return (xff ? xff.split(",")[0]!.trim() : ip) || "local";
}

export function setSession(key: string, data: Session): void {
  sessions.set(key, { ...sessions.get(key), ...data });
}

export function getSession(key: string): Session | undefined {
  return sessions.get(key);
}

export function removeSession(key: string): void {
  sessions.delete(key);
}
