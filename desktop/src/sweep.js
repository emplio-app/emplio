// Which browsers the app ends by itself: past their time limit, or all of them once the server has been out of reach too long.
// entries: [id, { timeoutAt: Date }][]
export const LINK_LOST_MS = 15 * 60_000;

export function overdue(entries, now, offlineSince) {
  const lost = !!offlineSince && now - offlineSince > LINK_LOST_MS;
  return entries.filter(([, b]) => lost || now > b.timeoutAt.getTime()).map(([id]) => id);
}
