const mem = new Map();
let available = false;
try {
  const k = "__maps_test__";
  if (typeof window !== "undefined" && window.localStorage) {
    window.localStorage.setItem(k, "1");
    window.localStorage.removeItem(k);
    available = true;
  }
} catch {}

export const safeStorage = {
  getItem(key) {
    if (available) {
      try { return window.localStorage.getItem(key); } catch {}
    }
    return mem.has(key) ? mem.get(key) : null;
  },
  setItem(key, val) {
    if (available) {
      try { window.localStorage.setItem(key, String(val)); return; } catch {}
    }
    mem.set(key, String(val));
  },
  removeItem(key) {
    if (available) {
      try { window.localStorage.removeItem(key); return; } catch {}
    }
    mem.delete(key);
  },
};
