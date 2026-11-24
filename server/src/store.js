// Tiny JSON file store. The whole file is rewritten atomically on every change
// (write a temp file next to it, then rename over the original).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function createStore(file) {
  let data = { bets: [] };
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.bets)) data = parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Keep a copy of an unreadable file rather than silently overwriting it.
      const backup = `${file}.corrupt-${Date.now()}`;
      try { fs.copyFileSync(file, backup); } catch { /* ignore */ }
      console.warn(`[store] could not read ${file} (${err.message}); starting empty, copy kept at ${backup}`);
    }
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  return {
    file,
    all() { return data.bets; },
    get(id) { return data.bets.find((b) => b.id === id) || null; },
    add(bet) { data.bets.push(bet); save(); return bet; },
    remove(id) {
      const before = data.bets.length;
      data.bets = data.bets.filter((b) => b.id !== id);
      if (data.bets.length !== before) { save(); return true; }
      return false;
    },
    update(id, fn) {
      const bet = this.get(id);
      if (!bet) return null;
      fn(bet);
      save();
      return bet;
    },
    save,
  };
}

export function newId() {
  return `b_${crypto.randomBytes(5).toString('hex')}`;
}
