// Room codes are read aloud, typed by hand and pasted into links, so the
// alphabet leaves out anything that looks like something else. Shared by the
// browser and the server so the two can never disagree about what is valid.

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const DEFAULT_ROOM = 'MAIN';

export const normaliseCode = (raw) => {
  const cleaned = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return cleaned || DEFAULT_ROOM;
};

export const makeCode = (length = 5) => Array.from(
  { length }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)],
).join('');
