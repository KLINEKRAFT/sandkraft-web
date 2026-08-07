// Save slots, in IndexedDB.
//
// Not localStorage, and the reason is arithmetic rather than taste: the sand
// field is one float per channel per texel, so a 384² beach is 2.4 MB raw.
// localStorage stores strings, so it would have to go through base64 at a third
// again in size, against a quota that is commonly 5 MB for the whole origin.
// IndexedDB takes the Float32Array as it stands.

const DB_NAME = 'sandkraft';
const STORE = 'beaches';
export const SLOT_COUNT = 3;

function open() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) { db.createObjectStore(STORE); }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/// What a slot holds. `resolution` is the reason this is a record and not just
/// a blob: a beach saved at one simulation resolution cannot be loaded into
/// another, and finding that out by uploading it and watching the shore come
/// out shredded is not a good way to find it out.
export async function save(slot, { resolution, field, props, camera }) {
    const db = await open();
    const record = {
        version: 1,
        resolution,
        savedAt: Date.now(),
        field: field.slice(),          // detach from the live readback buffer
        props,
        camera,
    };
    await tx(db, 'readwrite', (s) => s.put(record, `slot${slot}`));
    db.close();
    return record;
}

export async function load(slot) {
    const db = await open();
    const record = await tx(db, 'readonly', (s) => s.get(`slot${slot}`));
    db.close();
    return record || null;
}

export async function remove(slot) {
    const db = await open();
    await tx(db, 'readwrite', (s) => s.delete(`slot${slot}`));
    db.close();
}

/// Enough about every slot to draw the menu, without pulling megabytes of field
/// data across for a list nobody has clicked yet.
export async function summarise() {
    const out = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
        try {
            const r = await load(i);
            out.push(r
                ? { slot: i, empty: false, savedAt: r.savedAt, resolution: r.resolution,
                    props: (r.props || []).length }
                : { slot: i, empty: true });
        } catch (e) {
            out.push({ slot: i, empty: true, error: String(e) });
        }
    }
    return out;
}

export function describe(entry) {
    if (entry.empty) { return 'Empty'; }
    const d = new Date(entry.savedAt);
    const when = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
               + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `${when} · ${entry.props} props`;
}
