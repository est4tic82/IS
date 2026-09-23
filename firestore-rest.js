/**
 * A stand-in for the bits of the Firebase Firestore SDK that this app uses, talking to Firestore's
 * plain REST API instead of its realtime channel.
 *
 * The SDK streams changes over a long-lived "WebChannel" connection. On some networks that
 * connection is refused — the handshake succeeds and the streaming request that follows comes back
 * 400 — which leaves the app loading forever while the REST API answers perfectly well. This keeps
 * the same shape the app already calls (doc, setDoc, updateDoc, deleteDoc, onSnapshot…) and fetches
 * over ordinary HTTPS, polling for changes made elsewhere.
 *
 * What is given up: the SDK's offline cache. Writes go straight out and fail loudly if they can't.
 */
window.FirestoreRest = (function () {
  'use strict';

  const POLL_VISIBLE = 4000; // how often to look for changes from another device
  const POLL_HIDDEN = 20000; // …and while this tab is in the background

  /** A 20-character id in Firestore's own alphabet, generated here so writes can be optimistic. */
  function newId() {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
  }

  // --- Firestore's typed JSON, in and out ------------------------------------

  function encode(value) {
    if (value === null || value === undefined) return { nullValue: null };
    if (typeof value === 'string') return { stringValue: value };
    if (typeof value === 'boolean') return { booleanValue: value };
    if (typeof value === 'number') {
      return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
    }
    if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
    return { mapValue: { fields: encodeFields(value) } };
  }

  const encodeFields = (object) => Object.fromEntries(
    Object.entries(object).map(([key, value]) => [key, encode(value)]));

  function decode(value) {
    if ('stringValue' in value) return value.stringValue;
    if ('integerValue' in value) return Number(value.integerValue);
    if ('doubleValue' in value) return value.doubleValue;
    if ('booleanValue' in value) return value.booleanValue;
    if ('nullValue' in value) return null;
    if ('arrayValue' in value) return (value.arrayValue.values || []).map(decode);
    if ('mapValue' in value) return decodeFields(value.mapValue.fields || {});
    return null;
  }

  const decodeFields = (fields) => Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, decode(value)]));

  // --- The pieces the app asks for -------------------------------------------

  class FieldPath {
    constructor(...parts) { this.parts = parts; }
    // Segments are quoted, so an id that isn't a plain word still addresses one field.
    toString() { return this.parts.map((part) => '`' + String(part).replace(/`/g, '\\`') + '`').join('.'); }
  }

  const DELETE = { __deleteField: true };

  return function connect({ projectId, apiKey }) {
    const BASE = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const url = (path, params = '') => `${BASE}/${path}?key=${apiKey}${params}`;

    // A read that overlaps a write can come back describing the document as it was just before it,
    // which would undo the change on screen until the next poll. Reads are only trusted when no
    // write is in flight and none finished after they started.
    let lastWriteAt = 0;
    let writesInFlight = 0;

    async function request(method, path, { params = '', body } = {}) {
      const response = await fetch(url(path, params), {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        const error = new Error((detail && detail.error && detail.error.message) || `Firestore said ${response.status}.`);
        error.code = response.status === 403 ? 'permission-denied'
          : response.status === 404 ? 'not-found'
          : response.status >= 500 ? 'unavailable' : 'invalid-argument';
        throw error;
      }
      return response.status === 204 ? null : response.json();
    }

    async function listDocuments(collection) {
      const page = await request('GET', collection, { params: '&pageSize=300' });
      return (page.documents || []).map((document) => ({
        id: document.name.slice(document.name.lastIndexOf('/') + 1),
        fields: decodeFields(document.fields || {}),
      }));
    }

    const write = async (run) => {
      writesInFlight += 1;
      try {
        return await run();
      } finally {
        writesInFlight -= 1;
        lastWriteAt = Date.now();
      }
    };

    // --- The API the app calls ---

    const collection = (db, name) => ({ collection: name, filters: [] });
    const query = (ref, ...filters) => ({ collection: ref.collection, filters: [...ref.filters, ...filters] });
    const where = (field, op, value) => ({ field, op, value });

    function doc(first, name, id) {
      if (first && first.collection && name === undefined) return { collection: first.collection, id: newId() };
      return { collection: name, id: id || newId() };
    }

    const setDoc = (ref, data) => write(() =>
      request('PATCH', `${ref.collection}/${ref.id}`, { body: { fields: encodeFields(data) } }));

    function updateDoc(ref, first, second) {
      const paths = [];
      let fields;
      if (first instanceof FieldPath) {
        paths.push(first.toString());
        // Nest the value back under its own path, which is what a field-masked PATCH expects.
        fields = second === DELETE ? {} : first.parts.reduceRight(
          (inner, part) => ({ [part]: inner }), second);
      } else {
        Object.keys(first).forEach((key) => paths.push('`' + key.replace(/`/g, '\\`') + '`'));
        fields = first;
      }
      const params = paths.map((path) => `&updateMask.fieldPaths=${encodeURIComponent(path)}`).join('');
      return write(() => request('PATCH', `${ref.collection}/${ref.id}`,
        { params, body: { fields: encodeFields(fields) } }));
    }

    const deleteDoc = (ref) => write(() => request('DELETE', `${ref.collection}/${ref.id}`));

    const matches = (fields, filters) => filters.every(({ field, op, value }) =>
      (op === '==' ? fields[field] === value : true));

    const snapshotOf = (rows) => ({
      docs: rows.map((row) => ({ id: row.id, data: () => row.fields })),
      size: rows.length,
      metadata: { fromCache: false }, // there is no cache here: everything came from the server
    });

    /**
     * Every document in these collections as Firestore holds it, with the timestamps and sizes the
     * API reports. This is what the "Manage database" screen shows, so it goes to the server each
     * time rather than answering from anything kept here.
     */
    async function inspect(names) {
      const collections = [];
      for (const name of names) {
        try {
          const page = await request('GET', name, { params: '&pageSize=300' });
          collections.push({
            name,
            documents: (page.documents || []).map((document) => ({
              id: document.name.slice(document.name.lastIndexOf('/') + 1),
              path: document.name.slice(document.name.indexOf('/documents/') + 11),
              createTime: document.createTime,
              updateTime: document.updateTime,
              bytes: JSON.stringify(document.fields || {}).length,
              fields: decodeFields(document.fields || {}),
            })),
          });
        } catch (error) {
          collections.push({ name, error: error.message, documents: [] });
        }
      }
      return { projectId, collections };
    }

    /** One document by id, or null if it isn't there. */
    async function getDoc(ref) {
      try {
        const document = await request('GET', `${ref.collection}/${ref.id}`);
        return { id: ref.id, exists: () => true, data: () => decodeFields(document.fields || {}) };
      } catch (error) {
        if (error.code === 'not-found') return { id: ref.id, exists: () => false, data: () => undefined };
        throw error;
      }
    }

    async function getDocs(ref) {
      const rows = (await listDocuments(ref.collection)).filter((row) => matches(row.fields, ref.filters));
      return snapshotOf(rows);
    }

    /**
     * Watches a collection by asking for it again every few seconds, and reports what changed since
     * the last look in the shape the app expects from the SDK.
     */
    function onSnapshot(ref, next, onError) {
      let stopped = false;
      let timer = 0;
      let previous = new Map();
      let failures = 0;

      async function look() {
        if (stopped) return;
        const startedAt = Date.now();
        const quiet = writesInFlight === 0; // nothing was being written when this read set off
        try {
          const rows = (await listDocuments(ref.collection)).filter((row) => matches(row.fields, ref.filters));
          failures = 0;
          if (stopped) return;
          if (quiet && writesInFlight === 0 && startedAt >= lastWriteAt) {
            const current = new Map(rows.map((row) => [row.id, row.fields]));
            const changes = [];
            for (const [id, fields] of current) {
              const before = previous.get(id);
              if (!before) changes.push({ type: 'added', doc: { id, data: () => fields } });
              else if (JSON.stringify(before) !== JSON.stringify(fields)) {
                changes.push({ type: 'modified', doc: { id, data: () => fields } });
              }
            }
            for (const [id, fields] of previous) {
              if (!current.has(id)) changes.push({ type: 'removed', doc: { id, data: () => fields } });
            }
            previous = current;
            next(Object.assign(snapshotOf(rows), { docChanges: () => changes }));
          }
        } catch (error) {
          // One bad poll is not worth an error screen; several in a row is.
          if (!stopped && ++failures >= 3 && onError) onError(error);
        }
        if (!stopped) timer = setTimeout(look, document.hidden ? POLL_HIDDEN : POLL_VISIBLE);
      }

      look();
      // Coming back to the tab should show what changed elsewhere straight away.
      const wake = () => { if (!document.hidden && !stopped) { clearTimeout(timer); look(); } };
      document.addEventListener('visibilitychange', wake);

      return () => {
        stopped = true;
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', wake);
      };
    }

    return {
      // The SDK's setup calls, which have nothing to do here.
      initializeFirestore: () => ({ projectId }),
      persistentLocalCache: () => ({}),
      persistentMultipleTabManager: () => ({}),
      // The ones that do.
      collection, query, where, doc, FieldPath,
      deleteField: () => DELETE,
      setDoc, updateDoc, deleteDoc, getDoc, getDocs, onSnapshot,
      // Not part of the SDK: the "Manage database" screen.
      inspect,
    };
  };
})();
