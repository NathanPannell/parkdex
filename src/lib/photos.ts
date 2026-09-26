// Check-in photos live in IndexedDB: localStorage is too small for more than a
// handful of JPEGs, and IndexedDB survives app restarts inside the Android WebView.
const DB = "parkdex";
const STORE = "photos";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function savePhoto(parkId: string, dataUrl: string) {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(dataUrl, parkId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadPhotos(): Promise<Record<string, string>> {
  const db = await open();
  const out: Record<string, string> = {};
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      out[String(cursor.key)] = cursor.value as string;
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
  db.close();
  return out;
}

export async function clearPhotos() {
  const db = await open();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
  });
  db.close();
}
