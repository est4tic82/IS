/*
 * Interactive Stories: plain JavaScript, no frameworks.
 *
 * Stories live in Cloud Firestore, so they sync across browsers and devices. Each story is one
 * document in the "stories" collection:
 *
 *   stories/{storyId}: {
 *     name: 'The Lighthouse Keeper',
 *     createdAt: 1789752158015,
 *     chapters: {
 *       '<chapterId>': { title: 'A Light in the Storm', content: '…', createdAt: 1789752160000 },
 *     },
 *   }
 *
 * Chapters are a map rather than an array so that every change writes only the field it touches
 * (one chapter's title or text), and edits made on two devices don't overwrite each other.
 */
(function () {
  'use strict';

  const APP_NAME = 'Interactive Stories';

  const firebaseConfig = {
    apiKey: 'AIzaSyDg1F_O-uYEZPjLoAgOyqC6ARpQCtgierM',
    authDomain: 'interactivestories-85a09.firebaseapp.com',
    projectId: 'interactivestories-85a09',
    storageBucket: 'interactivestories-85a09.firebasestorage.app',
    messagingSenderId: '346183277708',
    appId: '1:346183277708:web:68a38b15874fe2059e2fa9',
  };

  // Which story was open last is a per-device preference, so it stays in this browser.
  const OPEN_STORY_KEY = 'interactive-stories:open-story';
  // …and so is which part was open, so a reload doesn't ask for the code again.
  const OPEN_PART_KEY = 'interactive-stories:open-part';

  // The entry codes and the part of the app each one opens. Anyone can read them in this file,
  // so they only choose a part of the app; Firestore's security rules are what protect the stories.
  const CODES = { '272610': 'read', '101129': 'write' };

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  // Local copy of the "stories" collection (with chapters as a sorted array), kept current by a
  // Firestore listener. Changes show up here at once and are written to Firestore in the background.
  const state = { stories: [], selectedId: readOpenStory() };

  let firestore = null; // the Firestore client, once connected
  let activeConfig = null; // the Firebase project being talked to
  let storiesWatch = null; // stops the story listener when the project changes
  let db = null;
  let loaded = false; // whether the first batch of stories has arrived
  let part = null; // the part of the app the code opened: 'read' or 'write' (null on the entry screen)
  let readingId = null; // the story open in the reader

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const currentStory = () => state.stories.find((story) => story.id === state.selectedId);
  // Stories on show in the sidebar, and the ones put aside under "More stories".
  const openStories = () => state.stories.filter((story) => !story.hidden);
  const putAside = () => state.stories.filter((story) => story.hidden);
  const byCreation = (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1);
  const storyRef = (id) => firestore.doc(db, 'stories', id);

  const countWords = (text) => (text.match(/\S+/g) || []).length;
  /** "1 story", "2 stories", "3 widgets" — a -y ending takes -ies unless a vowel comes before it. */
  const plural = (count, word) => {
    const many = /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`;
    return `${count.toLocaleString()} ${count === 1 ? word : many}`;
  };
  const chapterCount = (story) =>
    story.chapters.length ? plural(story.chapters.length, 'chapter') : 'No chapters yet';

  /** "3 chapters · 1,204 words" */
  function storySummary(story) {
    const words = story.chapters.reduce((sum, chapter) => sum + countWords(chapter.content), 0);
    return words ? `${chapterCount(story)} · ${plural(words, 'word')}` : chapterCount(story);
  }

  /**
   * Splits chapter text into the lines a widget can be attached to, keeping the blank lines
   * between them so the reader can render the text exactly as it was written.
   */
  function splitContent(content) {
    const parts = [];
    let line = 0;
    let start = 0;
    for (const piece of content.split(/(\n+)/)) {
      if (!piece) continue;
      if (/^\n+$/.test(piece)) parts.push({ gap: piece, start });
      else parts.push({ text: piece, line: line++, start });
      start += piece.length;
    }
    return parts;
  }

  const contentLines = (content) => splitContent(content).filter((part) => part.text !== undefined);

  /**
   * Where in the chapter's text a widget sits, as a character offset. The snippet saved with the
   * widget is tried first, so edits elsewhere in the chapter don't drag the widget out of place.
   */
  function widgetOffset(chapter, widget) {
    const content = chapter.content;
    if (widget.anchor) {
      // The same words can appear more than once, so take the match nearest where it was pinned.
      const matches = [];
      for (let at = content.indexOf(widget.anchor); at !== -1; at = content.indexOf(widget.anchor, at + 1)) {
        matches.push(at);
      }
      const wanted = Number.isFinite(widget.offset) ? widget.offset : 0;
      if (matches.length) {
        return matches.reduce((best, at) => (Math.abs(at - wanted) < Math.abs(best - wanted) ? at : best));
      }
    }
    if (Number.isFinite(widget.offset) && widget.offset < content.length) return widget.offset;

    // Widgets saved before widgets were anchored to a character: fall back to their line.
    const line = contentLines(content)[widget.line];
    return line ? line.start : -1;
  }

  /** The text a widget is attached to, for showing the writer where it fires. */
  const widgetSnippet = (chapter, widget, length = 60) => {
    const offset = widgetOffset(chapter, widget);
    return offset === -1 ? '' : truncate(chapter.content.slice(offset, offset + length + 20).replace(/\n+/g, ' '), length);
  };

  const truncate = (text, length) => (text.length > length ? `${text.slice(0, length).trimEnd()}…` : text);

  function readOpenStory() {
    try {
      return localStorage.getItem(OPEN_STORY_KEY);
    } catch (error) {
      return null; // storage is blocked: the first story opens instead
    }
  }

  function rememberOpenStory() {
    try {
      localStorage.setItem(OPEN_STORY_KEY, state.selectedId || '');
    } catch (error) {
      // Not remembering the open story is harmless.
    }
  }

  /** The part left open last time, so a reload doesn't send the writer back to the code screen. */
  function readOpenPart() {
    try {
      const saved = localStorage.getItem(OPEN_PART_KEY);
      return saved === 'read' || saved === 'write' ? saved : null;
    } catch (error) {
      return null; // storage is blocked: the code screen comes up as before
    }
  }

  function rememberOpenPart() {
    try {
      if (part) localStorage.setItem(OPEN_PART_KEY, part);
      else localStorage.removeItem(OPEN_PART_KEY);
    } catch (error) {
      // Not remembering it just means typing the code again.
    }
  }

  /** The open story is the one remembered from last time, or the first one if that is gone. */
  function ensureSelection() {
    const open = currentStory();
    if (open && !open.hidden) return;
    const shown = openStories();
    state.selectedId = shown.length ? shown[0].id : null;
    rememberOpenStory();
  }

  // --- Writing to Firestore ----------------------------------------------------

  /** Firestore applies a write locally straight away; if the server rejects it, say so. */
  function save(write) {
    write.catch((error) => showNotice(`Couldn’t save your changes. ${explain(error)}`, { keep: true }));
  }

  function createStory(name) {
    const ref = firestore.doc(firestore.collection(db, 'stories')); // a new id, generated locally
    const story = { id: ref.id, name, createdAt: Date.now(), hidden: false, chapters: [] };
    state.stories.push(story);
    save(firestore.setDoc(ref, { name, createdAt: story.createdAt, chapters: {} }));
    return story;
  }

  function addChapter(story, title) {
    const chapter = { id: newId(), title, content: '', createdAt: Date.now(), widgets: [] };
    story.chapters.push(chapter);
    story.chapters.sort(byCreation);
    save(firestore.updateDoc(storyRef(story.id), new firestore.FieldPath('chapters', chapter.id), {
      title,
      content: '',
      createdAt: chapter.createdAt,
    }));
    return chapter;
  }

  /** Puts a story aside, or brings it back. Aside means out of the sidebar; readers still get it. */
  function setStoryHidden(story, hidden) {
    story.hidden = hidden;
    save(firestore.updateDoc(storyRef(story.id), { hidden }));
  }

  function renameStory(story, name) {
    story.name = name;
    save(firestore.updateDoc(storyRef(story.id), { name }));
  }

  function renameChapter(story, chapter, title) {
    chapter.title = title;
    save(firestore.updateDoc(storyRef(story.id), new firestore.FieldPath('chapters', chapter.id, 'title'), title));
  }

  /** Adds or updates a widget on one of a chapter's lines. */
  function saveWidget(story, chapter, widget) {
    const { id, ...fields } = widget;
    const existing = chapter.widgets.find((candidate) => candidate.id === id);
    if (existing) Object.assign(existing, widget);
    else chapter.widgets.push(widget);
    chapter.widgets.sort(byCreation);
    save(firestore.updateDoc(storyRef(story.id), new firestore.FieldPath('chapters', chapter.id, 'widgets', id), fields));
  }

  function removeWidget(story, chapter, widget) {
    if (widget.type === 'image' && widget.imageId) forgetImage(widget.imageId);
    chapter.widgets = chapter.widgets.filter((candidate) => candidate.id !== widget.id);
    save(firestore.updateDoc(
      storyRef(story.id),
      new firestore.FieldPath('chapters', chapter.id, 'widgets', widget.id),
      firestore.deleteField()
    ));
  }

  // --- Pictures ----------------------------------------------------------------
  //
  // A picture lives in its own document, not on the story, so the four-second poll that watches the
  // stories never has to carry it. A widget keeps only the id, and the picture is fetched when it
  // is about to be shown.

  const IMAGE_MAX_SIDE = 1400;
  const IMAGE_MAX_BYTES = 700 * 1024; // a Firestore document has to stay under a megabyte

  const readDataUrl = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('That file couldn’t be read.'));
    reader.readAsDataURL(file);
  });

  /**
   * A picked file, ready to store. One that already fits is kept exactly as it is, so a small PNG
   * keeps its transparency; anything larger is redrawn smaller until it fits.
   */
  async function prepareImage(file) {
    if (!file.type.startsWith('image/')) throw new Error('That file isn’t a picture.');

    const original = await readDataUrl(file);
    const bitmap = await createImageBitmap(file).catch(() => null);
    const side = bitmap ? Math.max(bitmap.width, bitmap.height) : 0;

    if (original.length <= IMAGE_MAX_BYTES && side <= IMAGE_MAX_SIDE) {
      return { data: original, width: bitmap ? bitmap.width : 0, height: bitmap ? bitmap.height : 0, shrunk: false };
    }
    if (!bitmap) throw new Error('That picture is too big, and this browser couldn’t resize it.');

    for (const [limit, quality] of [[IMAGE_MAX_SIDE, 0.85], [1100, 0.75], [800, 0.65], [600, 0.55]]) {
      const scale = Math.min(1, limit / Math.max(bitmap.width, bitmap.height));
      const canvas = h('canvas', {});
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/jpeg', quality);
      if (data.length <= IMAGE_MAX_BYTES) {
        return { data, width: canvas.width, height: canvas.height, shrunk: true };
      }
    }
    throw new Error('That picture is too big even after shrinking. Try a smaller one.');
  }

  async function storeImage(picture, name) {
    const ref = firestore.doc(firestore.collection(db, 'images'));
    await firestore.setDoc(ref, {
      data: picture.data,
      name: String(name || ''),
      width: picture.width,
      height: picture.height,
      createdAt: Date.now(),
    });
    return ref.id;
  }

  const imagesSeen = new Map(); // id → data url, so a picture is fetched once per visit

  async function loadImage(id) {
    if (!id) return null;
    if (imagesSeen.has(id)) return imagesSeen.get(id);
    const snapshot = await firestore.getDoc(firestore.doc(db, 'images', id));
    const data = snapshot.exists() ? String(snapshot.data().data || '') : null;
    imagesSeen.set(id, data);
    return data;
  }

  const forgetImage = (id) => {
    if (!id) return;
    imagesSeen.delete(id);
    save(firestore.deleteDoc(firestore.doc(db, 'images', id)));
  };

  // --- Reading sessions --------------------------------------------------------
  //
  // Opening a story to read starts a session; whatever the reader answers in the widgets is
  // written onto it, and the backend's report reads them back.

  let session = null;

  function startSession(story) {
    if (!db) return;
    const ref = firestore.doc(firestore.collection(db, 'sessions'));
    session = { id: ref.id };
    save(firestore.setDoc(ref, {
      storyId: story.id,
      storyName: story.name,
      startedAt: Date.now(),
      answers: {},
    }));
  }

  /** Removes one reading report. The report watches the collection, so the list updates itself. */
  function deleteSession(id) {
    if (reportSession === id) reportSession = null;
    save(firestore.deleteDoc(firestore.doc(db, 'sessions', id)));
  }

  const sessionStart = (session) => Number(session.startedAt) || 0;

  /**
   * Folds several reading reports into one, under the earliest of their times. A question answered
   * in only one of them keeps that answer; a question answered in more than one keeps the earliest,
   * since that is what the reader said the first time through. The reports folded in are removed.
   */
  function mergeSessions(sessions) {
    const order = [...sessions].sort((a, b) => sessionStart(a) - sessionStart(b));
    const [keep, ...rest] = order;
    if (!rest.length) return;

    const answers = {};
    const times = {};
    for (const each of order) {
      for (const [widgetId, answer] of Object.entries(each.answers ?? {})) {
        const at = Number(answer.answeredAt) || sessionStart(each);
        if (!(widgetId in answers) || at < times[widgetId]) {
          answers[widgetId] = answer;
          times[widgetId] = at;
        }
      }
    }

    // A report made of merged reports can be merged again, so count the readings, not the reports.
    const readings = order.reduce((total, each) => total + (Number(each.mergedFrom) || 1), 0);
    reportSession = keep.id;
    reportPicked.clear();
    save(firestore.updateDoc(firestore.doc(db, 'sessions', keep.id), {
      answers,
      mergedFrom: readings,
      mergedAt: Date.now(),
    }));
    for (const each of rest) save(firestore.deleteDoc(firestore.doc(db, 'sessions', each.id)));
  }

  /**
   * A picture has no answer, but whether it was uncovered and how long the reader stayed with it
   * are worth knowing, so they go on the session the same way an answer does.
   */
  function recordReveal(chapter, widget, seconds) {
    if (!session) return;
    save(firestore.updateDoc(firestore.doc(db, 'sessions', session.id), new firestore.FieldPath('answers', widget.id), {
      question: widget.alt || '',
      chapter: chapter.title,
      revealed: true,
      seconds,
      answeredAt: Date.now(),
    }));
  }

  function recordAnswer(chapter, widget, value, label) {
    if (!session) return;
    save(firestore.updateDoc(firestore.doc(db, 'sessions', session.id), new firestore.FieldPath('answers', widget.id), {
      question: widget.question,
      chapter: chapter.title,
      value,
      label,
      answeredAt: Date.now(),
    }));
  }

  // Chapter text that was typed but not sent yet (chapter id → { story, chapter }). It is sent once
  // typing pauses, and until then updates from other devices don't overwrite it.
  const unsaved = new Map();
  let typingTimer = 0;

  function contentChanged(story, chapter) {
    unsaved.set(chapter.id, { story, chapter });
    clearTimeout(typingTimer);
    typingTimer = setTimeout(saveTyping, 800);
  }

  function saveTyping() {
    clearTimeout(typingTimer);
    if (!unsaved.size) return;

    for (const { story, chapter } of unsaved.values()) {
      if (!state.stories.includes(story)) continue; // the story was deleted meanwhile
      save(firestore.updateDoc(storyRef(story.id), new firestore.FieldPath('chapters', chapter.id, 'content'), chapter.content));
    }
    unsaved.clear();
    updateMeta();
  }

  // --- Reading from Firestore --------------------------------------------------

  async function start() {
    try {
      // Firestore's REST API, not its realtime channel: the long-lived connection the Firebase SDK
      // needs is refused on some networks, which left this app loading for ever. See firestore-rest.js.
      connectTo(readConfig());
    } catch (error) {
      console.error(error);
      showStatus('Couldn’t reach your stories. Check your internet connection and reload the page.');
    }
  }

  // Set while the cache is empty and Firestore hasn't answered yet.
  let waitingTimer = 0;

  /** Says the stories are still on their way, so an unreachable server never reads as "none". */
  function waitForServer() {
    if (waitingTimer) return;
    waitingTimer = setTimeout(() => {
      ui.statusText.textContent = 'Still reaching for your stories. They are safe online — this page '
        + 'fills in as soon as it connects.';
    }, 6000);
  }

  function listenForStories() {
    waitForServer();
    storiesWatch = firestore.onSnapshot(firestore.collection(db, 'stories'), applySnapshot, (error) => {
      console.error(error);
      if (loaded) showNotice(`Your stories stopped syncing. ${explain(error)} Reload the page to try again.`, { keep: true });
      else showStatus(`Couldn’t load your stories. ${explain(error)}`);
    });
  }

  /** Turns a Firestore document into the shape the page works with (chapters as a sorted array). */
  function storyFromDoc(doc) {
    const data = doc.data();
    return {
      id: doc.id,
      name: String(data.name ?? 'Untitled story'),
      createdAt: Number(data.createdAt) || 0,
      hidden: data.hidden === true, // put aside: out of the sidebar, though readers still get it
      chapters: Object.entries(data.chapters ?? {})
        .map(([id, chapter]) => ({
          id,
          title: String(chapter.title ?? ''),
          content: String(chapter.content ?? ''),
          createdAt: Number(chapter.createdAt) || 0,
          widgets: Object.entries(chapter.widgets ?? {})
            .map(([widgetId, widget]) => ({
              id: widgetId,
              type: String(widget.type ?? 'scale'),
              line: Number(widget.line) || 0, // widgets saved before spots were characters
              offset: Number.isFinite(Number(widget.offset)) ? Number(widget.offset) : undefined,
              anchor: String(widget.anchor ?? ''),
              imageId: widget.imageId ? String(widget.imageId) : '',
              alt: String(widget.alt ?? ''),
              question: String(widget.question ?? ''),
              labels: Array.isArray(widget.labels) ? widget.labels.map((label) => String(label ?? '')) : [],
              createdAt: Number(widget.createdAt) || 0,
            }))
            .sort(byCreation),
        }))
        .sort(byCreation),
    };
  }

  /**
   * Copies the latest version of a story into the local one. The objects are updated in place
   * because the page holds on to them, and chapter text still being typed here is left alone.
   * Returns whether anything changed.
   */
  function mergeStory(story, latest) {
    let changed = story.name !== latest.name || story.hidden !== latest.hidden;
    story.name = latest.name;
    story.hidden = latest.hidden;
    story.createdAt = latest.createdAt;

    const known = new Map(story.chapters.map((chapter) => [chapter.id, chapter]));
    const chapters = latest.chapters.map((incoming) => {
      const chapter = known.get(incoming.id);
      if (!chapter) return incoming;
      if (chapter.title !== incoming.title) {
        chapter.title = incoming.title;
        changed = true;
      }
      if (chapter.content !== incoming.content && !unsaved.has(chapter.id)) {
        chapter.content = incoming.content;
        changed = true;
      }
      if (JSON.stringify(chapter.widgets) !== JSON.stringify(incoming.widgets)) {
        chapter.widgets = incoming.widgets;
        changed = true;
      }
      chapter.createdAt = incoming.createdAt;
      return chapter;
    });

    if (chapters.length !== story.chapters.length || chapters.some((chapter, i) => chapter !== story.chapters[i])) {
      changed = true;
    }
    story.chapters = chapters;
    return changed;
  }

  /** Applies changes from Firestore: the first load, edits and deletions from other devices, and this device's own writes coming back. */
  function applySnapshot(snapshot) {
    const openIndex = state.stories.findIndex((story) => story.id === state.selectedId);
    let changed = false;
    let openStoryChanged = false;

    for (const change of snapshot.docChanges()) {
      const index = state.stories.findIndex((story) => story.id === change.doc.id);
      if (change.type === 'removed') {
        if (index !== -1) {
          state.stories.splice(index, 1);
          changed = true;
        }
      } else if (index === -1) {
        state.stories.push(storyFromDoc(change.doc));
        changed = true;
      } else if (mergeStory(state.stories[index], storyFromDoc(change.doc))) {
        changed = true;
        if (change.doc.id === state.selectedId) openStoryChanged = true;
      }
    }
    state.stories.sort(byCreation);

    if (!loaded) {
      // An empty cache is not proof that there are no stories: a browser that can't reach Firestore
      // yet looks exactly the same. Wait for the server rather than offering a blank start, which
      // would invite writing a new story over a library that is merely out of reach.
      if (snapshot.metadata.fromCache && !snapshot.docs.length) {
        waitForServer();
        return;
      }
      clearTimeout(waitingTimer);
      loaded = true;
      ensureSelection();
      showPart();
      return;
    }
    if (!changed) return; // only this device's own writes, which are already on screen

    // Keep the open story valid even while the entry screen or the reader is up, so that going
    // (back) into the writing part always lands on a story.
    const openStoryGone = !currentStory();
    ensureSelection();

    if (part === 'read') renderReadPart();
    if (part !== 'write') return;

    if (!state.stories.length) {
      render(); // every story was deleted elsewhere: back to the welcome screen
    } else if (openStoryGone) {
      // The open story was deleted elsewhere: open the one that took its place.
      showStory(state.stories[Math.min(Math.max(openIndex, 0), state.stories.length - 1)].id);
    } else {
      renderStoryList();
      if (openStoryChanged) syncStory();
    }
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  const $ = (id) => document.getElementById(id);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /** h('button', { class: 'btn', onclick: fn }, 'Label') creates <button class="btn">Label</button>. */
  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'value') node.value = value;
      else node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
  }

  const ICONS = {
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    back: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    pen: '<path d="M4 20l1-4L16 5a2.1 2.1 0 0 1 3 3L8 19l-4 1Z"/><path d="m14 7 3 3"/>',
    trash: '<path d="M4 7h16M9 7V4.5h6V7M6 7l1 12.5h10L18 7M10 11v5M14 11v5"/>',
    aside: '<path d="M3 8h18v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M5 8V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3"/><path d="M10 13h4"/>',
  };

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONS[name];
    return svg;
  }

  function animateIn(node) {
    if (reducedMotion.matches) return;
    node.animate(
      [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }],
      { duration: 350, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' }
    );
  }

  function shake(node) {
    node.classList.remove('shake');
    void node.offsetWidth; // restart the animation
    node.classList.add('shake');
  }

  /** Grows a textarea to fit its text, so a chapter reads like a page rather than a scroll box. */
  function autosize(textarea) {
    const { scrollX, scrollY } = window;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight + textarea.offsetHeight - textarea.clientHeight}px`;
    // Collapsing to 'auto' can shorten the page for a moment and make it jump.
    if (window.scrollY !== scrollY) window.scrollTo(scrollX, scrollY);
  }

  /**
   * Runs an update that rebuilds part of the page without letting the page jump: swapping the
   * text boxes for the clickable lines, and back, briefly changes how tall the page is.
   */
  function keepingScroll(update) {
    const { scrollX, scrollY } = window;
    update();
    if (window.scrollY !== scrollY) window.scrollTo(scrollX, scrollY);
  }

  /** A short explanation of a Firestore error, with a hint for the common ones. */
  function explain(error) {
    switch (error.code) {
      case 'permission-denied':
        return 'Firestore denied access: check the security rules of your database in the Firebase console.';
      case 'unavailable':
        return 'Firestore can’t be reached right now.';
      default:
        return error.message;
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  const ui = {
    gate: $('gate'),
    gateInner: $('gate').firstElementChild,
    gateTitle: $('gate-title'),
    gateLead: $('gate-lead'),
    codeForm: $('code-form'),
    codeInput: $('code-input'),
    codeCells: $('code-cells'),
    codeMessage: $('code-message'),
    picker: $('picker'),
    pickerStatus: $('picker-status'),
    pickerList: $('picker-list'),
    reader: $('reader'),
    readerInner: $('reader-inner'),
    readerTitle: $('reader-title'),
    readerMeta: $('reader-meta'),
    readerChapters: $('reader-chapters'),
    readerBack: $('reader-back'),
    readerMore: $('reader-more'),
    status: $('status'),
    statusText: $('status-text'),
    statusReset: $('status-reset'),
    welcome: $('welcome'),
    welcomeForm: $('welcome-form'),
    welcomeInput: $('welcome-name'),
    welcomeSubmit: $('welcome-submit'),
    workspace: $('workspace'),
    storyList: $('story-list'),
    newStoryButton: $('new-story-btn'),
    newStoryForm: $('new-story-form'),
    newStoryInput: $('new-story-name'),
    editor: $('editor-inner'),
    noStory: $('no-story'),
    storyHeader: $('story-header'),
    storyTitle: $('story-title'),
    storyMeta: $('story-meta'),
    firstChapterButton: $('first-chapter-btn'),
    chapterList: $('chapter-list'),
    addChapterButton: $('add-chapter-btn'),
    reportButton: $('report-btn'),
    report: $('report'),
    reportBack: $('report-back'),
    reportBody: $('report-body'),
    addWidgetFab: $('add-widget-fab'),
    widgetCountFab: $('widget-count-fab'),
    widgetCount: $('widget-count'),
    widgetDrawer: $('widget-drawer'),
    widgetDrawerTitle: $('widget-drawer-title'),
    widgetDrawerBody: $('widget-drawer-body'),
    widgetDrawerClose: $('widget-drawer-close'),
    widgetDrawerClear: $('widget-drawer-clear'),
    pickBar: $('pick-bar'),
    pickCancel: $('pick-cancel'),
    rowHighlight: $('row-highlight'),
    kindDialog: $('kind-dialog'),
    kindChoices: $('kind-choices'),
    kindCancel: $('kind-cancel'),
    widgetDialog: $('widget-dialog'),
    widgetForm: $('widget-form'),
    widgetDialogTitle: $('widget-dialog-title'),
    widgetQuestion: $('widget-question'),
    widgetWhere: $('widget-where'),
    widgetChangeLine: $('widget-change-line'),
    widgetScaleFields: $('widget-scale-fields'),
    widgetImageFields: $('widget-image-fields'),
    widgetImageFile: $('widget-image-file'),
    widgetImagePreview: $('widget-image-preview'),
    widgetImageAlt: $('widget-image-alt'),
    widgetLabelsField: $('widget-labels-field'),
    widgetLabels: $('widget-labels'),
    widgetError: $('widget-error'),
    widgetDelete: $('widget-delete'),
    widgetPopup: $('widget-popup'),
    popupQuestion: $('widget-popup-question'),
    popupScale: $('widget-popup-scale'),
    popupActions: $('widget-popup-actions'),
    popupClose: $('widget-popup-close'),
    confirmDialog: $('delete-dialog'),
    confirmTitle: $('delete-dialog-title'),
    confirmText: $('delete-dialog-text'),
    confirmButton: $('delete-dialog-confirm'),
    notice: $('notice'),
    noticeText: $('notice-text'),
    noticeClose: $('notice-close'),
    logout: $('logout'),
    moreStoriesButton: $('more-stories-btn'),
    moreStories: $('more-stories'),
    moreStoriesBody: $('more-stories-body'),
    galleryButton: $('gallery-btn'),
    gallery: $('gallery'),
    galleryBody: $('gallery-body'),
    manageButton: $('manage-db-btn'),
    database: $('database'),
    databaseBody: $('database-body'),
  };

  // The entry screen's own heading and text, to put back after the story picker replaced them.
  const gateIntro = {
    title: [...ui.gateTitle.childNodes].map((node) => node.cloneNode(true)),
    lead: ui.gateLead.textContent,
  };

  // The <li> of a chapter whose title is being typed but hasn't been saved yet.
  let draftChapter = null;

  function render() {
    ensureSelection();
    // An empty library is the welcome screen. A library whose stories are all put aside is not
    // empty, so it keeps the workspace — the sidebar is the only way back to More stories.
    const hasStories = state.stories.length > 0;
    ui.status.hidden = true;
    ui.welcome.hidden = hasStories;
    ui.workspace.hidden = !hasStories;

    if (!hasStories) {
      document.title = APP_NAME;
      closeNewStoryForm();
      ui.welcomeInput.focus();
      return;
    }

    renderStoryList();
    renderEditor();
  }

  /** The right-hand side shows the open story, or says why there isn't one. */
  function renderEditor() {
    const story = currentStory();
    // A full-screen panel stands in for the story, so it decides what is on show while it is up.
    const panelUp = !(ui.report.hidden && ui.database.hidden && ui.gallery.hidden && ui.moreStories.hidden);

    ui.storyHeader.hidden = !story || panelUp;
    ui.chapterList.hidden = !story || panelUp;
    ui.noStory.hidden = Boolean(story) || panelUp;

    if (story) {
      renderStory();
      return;
    }

    draftChapter = null;
    ui.chapterList.replaceChildren();
    ui.firstChapterButton.hidden = true;
    ui.addChapterButton.hidden = true;
    document.title = APP_NAME;
    renderNoStory();
    updateWidgetFab();
  }

  /** Nothing is on show: say so, and point at where the rest of the library went. */
  function renderNoStory() {
    const aside = putAside().length;
    ui.noStory.replaceChildren(
      h('h1', { class: 'story-title' }, 'Nothing open'),
      h('p', { class: 'story-meta' }, aside
        ? `Every story is under More stories — ${plural(aside, 'story')} waiting there.`
        : 'Start one from the list on the left.'),
      ...(aside ? [h('p', { class: 'no-story__action' },
        h('button', { class: 'btn btn--soft', type: 'button', onclick: openMoreStories }, 'More stories'))] : []));
  }

  /** Replaces everything with an error, when the stories can't be loaded at all. */
  function showStatus(message) {
    for (const screen of [ui.gate, ui.welcome, ui.workspace, ui.reader]) screen.hidden = true;
    ui.status.hidden = false;
    ui.status.classList.add('is-error');
    ui.statusText.textContent = message;
    // This screen replaces the sidebar, so a connection typed in by hand that turns out to be wrong
    // would otherwise leave no way back to correct it — not even after a reload.
    ui.statusReset.hidden = usingDefaultConfig();
  }

  let noticeTimer = 0;

  /**
   * A line along the bottom of the screen. It clears itself after five seconds, unless it is
   * carrying bad news — something that didn't save is worth leaving on screen until it is read.
   */
  function showNotice(message, { keep = false } = {}) {
    clearTimeout(noticeTimer);
    ui.noticeText.textContent = message;
    ui.notice.hidden = false;
    if (!keep) noticeTimer = setTimeout(hideNotice, 5000);
  }

  function hideNotice() {
    clearTimeout(noticeTimer);
    ui.notice.hidden = true;
  }

  /** Updates the sidebar in place, so a click on it is never lost to a re-render. */
  function renderStoryList() {
    const items = new Map([...ui.storyList.children].map((item) => [item.dataset.id, item]));

    openStories().forEach((story, index) => {
      let item = items.get(story.id);
      if (item) {
        items.delete(story.id);
      } else {
        item = h('li', { 'data-id': story.id },
          h('button', { class: 'story-link', type: 'button', onclick: () => selectStory(story.id) },
            h('span', { class: 'story-link__name' }),
            h('span', { class: 'story-link__meta' })),
          h('div', { class: 'story-actions' },
            h('button', { class: 'story-action', type: 'button', title: 'Put this story aside', onclick: () => putStoryAside(story) },
              icon('aside')),
            h('button', { class: 'story-action', type: 'button', title: 'Delete story', onclick: () => askToDeleteStory(story.id) },
              icon('trash'))));
      }

      const [link, actions] = item.children;
      const [asideButton, deleteButton] = actions.children;
      link.title = story.name;
      link.children[0].textContent = story.name;
      link.children[1].textContent = chapterCount(story);
      asideButton.setAttribute('aria-label', `Put “${story.name}” aside`);
      deleteButton.setAttribute('aria-label', `Delete “${story.name}”`);
      // The database screen belongs to no story, so nothing in the list is current while it is up.
      if (story.id === state.selectedId && ui.database.hidden && ui.gallery.hidden && ui.moreStories.hidden) {
        link.setAttribute('aria-current', 'true');
      }
      else link.removeAttribute('aria-current');

      if (ui.storyList.children[index] !== item) {
        ui.storyList.insertBefore(item, ui.storyList.children[index] || null);
      }
    });

    items.forEach((item) => item.remove());
    // The aside list is another view of the same library, so it follows along.
    if (!ui.moreStories.hidden) renderMoreStories();
  }

  /** Shows the open story from scratch (after switching stories). */
  function renderStory() {
    draftChapter = null;
    ui.chapterList.replaceChildren();
    syncStory();
  }

  // The story title's text node, so a change from another device can be dropped straight into it.
  // Null while the title is being renamed here.
  let storyTitleText = null;

  /** The story's name, click to rename — the same as a chapter's title. */
  function showStoryTitle(story) {
    storyTitleText = document.createTextNode(story.name);
    ui.storyTitle.replaceChildren(
      h('button', { class: 'story-title-btn', type: 'button', title: 'Rename story', onclick: renameStoryTitle },
        storyTitleText, icon('pen')));
  }

  /** Keeps the heading current without interrupting a rename already under way. */
  function syncStoryTitle(story) {
    if (ui.storyTitle.querySelector('input')) return; // being renamed here: leave it alone
    if (storyTitleText && storyTitleText.isConnected) {
      if (storyTitleText.data !== story.name) storyTitleText.data = story.name;
      return;
    }
    showStoryTitle(story);
  }

  function renameStoryTitle() {
    const story = currentStory();
    if (!story) return;
    storyTitleText = null;
    const input = h('input', {
      class: 'story-title-input',
      type: 'text',
      maxlength: '120',
      placeholder: 'Story name',
      autocomplete: 'off',
      'aria-label': 'Story name',
      value: story.name,
    });
    ui.storyTitle.replaceChildren(input);
    input.focus();
    input.select();

    whenTitleDone(input, (name, byKeyboard) => {
      if (name && name !== story.name) {
        renameStory(story, name);
        renderStoryList(); // the sidebar carries the name too
        document.title = `${name} · ${APP_NAME}`;
      }
      showStoryTitle(currentStory() || story); // the input is still in place, so rebuild outright
      if (byKeyboard) ui.storyTitle.querySelector('button').focus();
    });
  }

  /** Brings the open story on screen up to date without disturbing anything being edited. */
  function syncStory() {
    const story = currentStory();
    document.title = `${story.name} · ${APP_NAME}`;
    syncStoryTitle(story);
    syncChapters(story);
    updateChapterButtons(story);
    updateMeta(story);
    updateWidgetFab();
  }

  /** Adds, updates, reorders and removes chapter cards to match the story. A new chapter still being named stays last. */
  function syncChapters(story) {
    const cards = new Map();
    for (const card of ui.chapterList.children) {
      if (card.dataset.id) cards.set(card.dataset.id, card);
    }

    let previous = null;
    story.chapters.forEach((chapter, index) => {
      const card = cards.get(chapter.id) || chapterItem(story, chapter);
      cards.delete(chapter.id);
      const expected = previous ? previous.nextSibling : ui.chapterList.firstChild;
      if (card !== expected) ui.chapterList.insertBefore(card, expected);
      card.sync(index + 1);
      previous = card;
    });

    cards.forEach((card) => card.remove());
  }

  /** "Add your first chapter" while there are none, "Add a new chapter" after that. */
  function updateChapterButtons(story) {
    const hasChapters = story.chapters.length > 0;
    // Hidden while naming a chapter, picking a line, or looking at the reports or the database.
    const busy = draftChapter !== null || picking
      || !ui.report.hidden || !ui.database.hidden || !ui.gallery.hidden || !ui.moreStories.hidden;
    ui.firstChapterButton.hidden = hasChapters || busy;
    ui.addChapterButton.hidden = !hasChapters || busy;
  }

  function updateMeta(story = currentStory()) {
    if (!story) return; // e.g. a late save after the last story was deleted
    ui.storyMeta.textContent = storySummary(story);
  }

  /** One chapter card: its number, its title (click to rename) and its content. */
  function chapterItem(story, chapter) {
    const head = h('div', { class: 'chapter__head' });
    const body = h('div', { class: 'chapter__body' });
    const item = h('li', { class: 'chapter', 'data-id': chapter.id }, head, body);

    let number = 0;
    let titleText = null; // the title's text node (null while the title is being renamed)
    let textarea = null; // the content box, once there is content or it is being written
    let showing = null; // what the body holds: 'content', 'add' or 'lines'
    let dots = null; // the widget dots laid over the text box

    function showTitle() {
      titleText = document.createTextNode(chapter.title);
      head.replaceChildren(
        h('h2', { class: 'chapter__title' },
          h('button', { class: 'chapter__title-btn', type: 'button', title: 'Rename chapter', onclick: renameTitle },
            titleText, icon('pen'))));
    }

    function renameTitle() {
      titleText = null;
      const input = titleInput(chapter.title, `Chapter ${number} title`);
      head.replaceChildren(input);
      input.focus();
      input.select();

      whenTitleDone(input, (title, byKeyboard) => {
        if (title && title !== chapter.title) renameChapter(story, chapter, title);
        showTitle();
        if (byKeyboard) head.querySelector('button').focus();
      });
    }

    function showAddContentButton() {
      textarea = null;
      dots = null;
      showing = 'add';
      body.replaceChildren(
        h('button', { class: 'btn btn--soft chapter__add-content', type: 'button', onclick: () => showContent(true) },
          icon('pen'), 'Add chapter content'));
    }

    /** Where each of this chapter's widgets sits in the text as it stands now. */
    function widgetMarks(onclick) {
      return chapter.widgets
        .map((widget) => ({ widget, at: widgetOffset(chapter, widget), className: 'chapter__mark', onclick: onclick && (() => onclick(widget)) }))
        .filter((mark) => mark.at >= 0);
    }

    /** While a spot is being picked, the chapter shows its text the way the reader will see it. */
    function showLines() {
      textarea = null;
      dots = null;
      showing = 'lines';
      body.replaceChildren(h('div', {
        class: 'chapter__preview',
        onmousemove: highlightRow,
        onmouseleave: hideRowHighlight,
        onclick: (event) => pickRow(chapter, event),
      }, ...contentNodes(chapter, { paragraphClass: 'chapter__para', marks: widgetMarks() })));
    }

    function showContent(focus) {
      showing = 'content';
      textarea = h('textarea', {
        class: 'chapter__content',
        rows: '3',
        placeholder: 'Start writing…',
        'aria-label': `Chapter ${number} content`,
        value: chapter.content,
        oninput: () => {
          chapter.content = textarea.value;
          autosize(textarea);
          showDots();
          contentChanged(story, chapter);
        },
      });
      dots = h('div', { class: 'chapter__dots', 'aria-hidden': 'true' });
      body.replaceChildren(textarea, dots);
      if (item.isConnected) autosize(textarea);
      showDots();
      if (focus) textarea.focus();
    }

    /**
     * A dot for every widget, out in the card's margin, level with the line it fires on. The text
     * box can't hold anything but text, so the dots ride on a hidden copy of it that wraps the same
     * way — which keeps each one beside its own line while the chapter is being written.
     */
    function showDots() {
      if (!dots) return;
      dots.replaceChildren(...contentNodes(chapter, { marks: widgetMarks((widget) => editWidget(story, chapter, widget)) }));
    }

    /** Shows the chapter's current number, title and text, e.g. after a change on another device. */
    item.sync = (position) => {
      number = position; // still used to tell screen readers which chapter a field belongs to
      if (titleText && titleText.data !== chapter.title) titleText.data = chapter.title;
      if (picking) {
        showLines();
        return;
      }
      if (!textarea) {
        if (chapter.content) showContent(false); // written here, or arrived from another device
        else if (showing !== 'add') showAddContentButton();
        return;
      }

      textarea.setAttribute('aria-label', `Chapter ${number} content`);
      if (textarea.value !== chapter.content && !unsaved.has(chapter.id)) {
        const { selectionStart, selectionEnd } = textarea;
        textarea.value = chapter.content;
        if (document.activeElement === textarea) textarea.setSelectionRange(selectionStart, selectionEnd);
      }
      autosize(textarea);
      showDots();
    };

    showTitle();
    if (picking) showLines();
    else if (chapter.content) showContent(false);
    else showAddContentButton();
    return item;
  }

  function titleInput(value, label) {
    return h('input', {
      class: 'chapter__title-input',
      type: 'text',
      maxlength: '160',
      placeholder: 'Chapter title',
      autocomplete: 'off',
      'aria-label': label,
      value,
    });
  }

  /**
   * Inline title editing: Enter saves, Escape cancels, clicking elsewhere saves
   * (or cancels if the field is empty). Calls done(title or null, byKeyboard) once.
   */
  function whenTitleDone(input, done) {
    let finished = false;
    const finish = (title, byKeyboard) => {
      if (finished) return;
      finished = true;
      done(title, byKeyboard);
    };

    input.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return; // still composing (IME)
      if (event.key === 'Enter') {
        event.preventDefault();
        if (input.value.trim()) finish(input.value.trim(), true);
        else shake(input);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(null, true);
      }
    });

    input.addEventListener('blur', () => {
      // Switching to another window or tab blurs the field too; keep it open in that case.
      if (document.hasFocus()) finish(input.value.trim() || null, false);
    });
  }

  // ---------------------------------------------------------------------------
  // Widgets: the text, its rendered rows, and the spot a widget is pinned to
  // ---------------------------------------------------------------------------

  /**
   * The chapter's text as nodes, with an empty marker span at each widget's spot. The markers take
   * no space, so the text reads the same, and both the writer's preview and the reader use this.
   */
  function contentNodes(chapter, { paragraphClass = null, marks = [] } = {}) {
    const parts = splitContent(chapter.content);
    const paragraphs = parts.filter((part) => part.text !== undefined);
    const byParagraph = new Map(paragraphs.map((part) => [part, []]));

    for (const mark of marks) {
      const holder = paragraphs.find((part) => mark.at >= part.start && mark.at < part.start + part.text.length)
        || paragraphs.find((part) => mark.at <= part.start) // a spot in the gap belongs to the next paragraph
        || paragraphs[paragraphs.length - 1];
      if (holder) byParagraph.get(holder).push(mark);
    }

    const nodes = [];
    for (const part of parts) {
      if (part.gap !== undefined) {
        nodes.push(part.gap);
        continue;
      }
      const end = part.start + part.text.length;
      const pieces = [];
      let cursor = part.start;
      for (const mark of byParagraph.get(part).sort((a, b) => a.at - b.at)) {
        const at = Math.min(Math.max(mark.at, part.start), end);
        if (at > cursor) pieces.push(chapter.content.slice(cursor, at));
        // A plain span, clickable or not: a button would sit on the baseline instead of across the
        // line, and the dot has to land in the same place here as it does in the reader's text.
        pieces.push(h('span', Object.assign(
          { class: mark.className, 'data-widget': mark.widget.id },
          mark.onclick ? { title: `Edit the widget “${widgetTitle(mark.widget)}”`, onclick: mark.onclick } : null)));
        cursor = at;
      }
      pieces.push(chapter.content.slice(cursor, end));
      if (paragraphClass) nodes.push(h('span', { class: paragraphClass, 'data-start': String(part.start) }, ...pieces));
      else nodes.push(...pieces);
    }
    return nodes;
  }

  /**
   * The rectangle of the rendered row at this height. A wrapped row also produces a sliver of a
   * rect for the space it broke on, so the widest rect at that height is the row itself.
   */
  const rowRectAt = (paragraph, y) => [...paragraph.getClientRects()]
    .filter((rect) => y >= rect.top && y <= rect.bottom)
    .sort((a, b) => b.width - a.width)[0] || null;

  /** Where a character sits inside a paragraph that may also hold marker spans. */
  function positionAt(paragraph, index) {
    let remaining = index;
    for (const node of paragraph.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      if (remaining <= node.length) return { node, offset: remaining };
      remaining -= node.length;
    }
    return null;
  }

  /** The character offset, inside a paragraph, where the row starting at `rowTop` begins. */
  function rowStartOffset(paragraph, rowTop) {
    const length = paragraph.textContent.length;
    const range = document.createRange();
    const topAt = (index) => {
      const from = positionAt(paragraph, index);
      const to = positionAt(paragraph, Math.min(index + 1, length));
      if (!from || !to) return Infinity;
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      return range.getBoundingClientRect().top;
    };

    let low = 0;
    let high = Math.max(length - 1, 0);
    while (low < high) { // tops only grow with the offset, so the first row start can be searched for
      const middle = (low + high) >> 1;
      if (topAt(middle) >= rowTop - 1) high = middle;
      else low = middle + 1;
    }
    return low;
  }

  /**
   * Whether a widget already pops up on this row. One line holds one widget, so a row with a dot
   * on it is not up for grabs — except by the widget whose line is being moved.
   */
  function rowIsTaken(preview, rect) {
    const moving = widgetDraft && widgetDraft.widget && widgetDraft.widget.id;
    return [...preview.querySelectorAll('.chapter__mark')].some((mark) => {
      if (mark.dataset.widget === moving) return false;
      const at = mark.getBoundingClientRect();
      const middle = at.top + at.height / 2;
      return middle >= rect.top && middle <= rect.bottom;
    });
  }

  /** Follows the pointer with a highlight behind the row it is on. */
  function highlightRow(event) {
    const preview = event.currentTarget;
    const paragraph = event.target.closest('[data-start]');
    const rect = paragraph && rowRectAt(paragraph, event.clientY);
    if (!rect) {
      hideRowHighlight();
      return;
    }

    const taken = rowIsTaken(preview, rect);
    const box = ui.rowHighlight;
    if (box.parentElement !== preview) preview.append(box); // positioned against this chapter's text
    const base = preview.getBoundingClientRect();
    box.hidden = false;
    box.classList.toggle('row-highlight--taken', taken);
    preview.classList.toggle('is-taken', taken);
    box.style.left = `${rect.left - base.left - 8}px`;
    box.style.top = `${rect.top - base.top - 3}px`;
    box.style.width = `${rect.width + 16}px`;
    box.style.height = `${rect.height + 6}px`;
  }

  function hideRowHighlight() {
    ui.rowHighlight.hidden = true;
    ui.rowHighlight.parentElement?.classList.remove('is-taken');
  }

  /** Pins the widget to the first character of the clicked row. */
  function pickRow(chapter, event) {
    const paragraph = event.target.closest('[data-start]');
    const rect = paragraph && rowRectAt(paragraph, event.clientY);
    if (!rect) return;
    if (rowIsTaken(event.currentTarget, rect)) {
      showNotice('That line already has a widget on it. Pick another line.');
      return;
    }
    hideRowHighlight();
    chooseSpot(chapter, Number(paragraph.dataset.start) + rowStartOffset(paragraph, rect.top));
  }

  /**
   * The kinds of widget that can be added. Each one appears in the gallery and in the chooser at the
   * top of the widget form; the samples are only for the preview and are never saved to a story.
   */
  const WIDGET_TYPES = [
    {
      type: 'scale',
      name: 'Scale of 1 to 10',
      about: 'A question with a slider from 1 to 10. Any number can carry a label, and the one the '
        + 'slider rests on is shown as it moves.',
      answers: true,
      sample: {
        question: 'How much would you want to go back there?',
        labels: ['Not at all', '', '', '', 'Some of me', '', '', '', '', 'All of me'],
      },
    },
    {
      type: 'image',
      name: 'Picture',
      about: 'A picture of your own, kept under a cover. The reader drags the line across to uncover '
        + 'it, and only then can they carry on.',
      answers: false,
      sample: {
        alt: 'The hills on the way back',
        data: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 400'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%23c98b6b'/%3E%3Cstop offset='1' stop-color='%238c4a32'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='640' height='400' fill='url(%23g)'/%3E%3Ccircle cx='470' cy='110' r='52' fill='%23f6e9df' opacity='.85'/%3E%3Cpath d='M0 300 L170 180 L300 270 L430 160 L640 300 L640 400 L0 400 Z' fill='%23472a1c' opacity='.55'/%3E%3Cpath d='M0 340 L200 250 L360 330 L520 245 L640 320 L640 400 L0 400 Z' fill='%232b1810' opacity='.7'/%3E%3C/svg%3E",
      },
    },
  ];

  const widgetKind = (widget) => WIDGET_TYPES.find((kind) => kind.type === (widget.type || 'scale')) || WIDGET_TYPES[0];

  /** What a widget is called in a list: its question, or its caption, or the kind it is. */
  const widgetTitle = (widget) => (widget.type === 'image'
    ? (widget.alt || 'Picture')
    : (widget.question || 'Untitled question'));

  // ---------------------------------------------------------------------------
  // Widgets: the backend form
  // ---------------------------------------------------------------------------

  // The widget being added or edited: { story, chapter, widget, line, question, labels }.
  let widgetDraft = null;
  let picking = false; // the writer is clicking a line in the chapters

  /** The floating buttons are there whenever a story is open for writing. */
  function updateWidgetFab() {
    const story = currentStory();
    const writing = part === 'write' && story
      && ui.report.hidden && ui.database.hidden && ui.gallery.hidden && ui.moreStories.hidden;
    // While a line is being picked, the prompt and Cancel stand in the button's place; the list of
    // widgets stays put, so it can be opened without giving up on the widget being added.
    ui.addWidgetFab.hidden = !writing;
    ui.addWidgetFab.classList.toggle('fab--standby', picking);
    ui.pickBar.hidden = !writing || !picking;

    const widgets = story ? storyWidgets(story).length : 0;
    ui.widgetCountFab.hidden = !writing || !widgets;
    ui.widgetCount.textContent = plural(widgets, 'widget');
    if (!widgets) closeWidgetDrawer();
    else if (!ui.widgetDrawer.hidden) renderWidgetDrawer();
  }

  // ---------------------------------------------------------------------------
  // Widgets: the drawer listing every one in the story
  // ---------------------------------------------------------------------------

  /** Starts a widget: the chapters turn into lines to click. */
  function startNewWidget() {
    const story = currentStory();
    if (!story) return;
    if (!story.chapters.some((chapter) => contentLines(chapter.content).length)) {
      showNotice('Write some text in a chapter first, then pick the line where the widget appears.');
      return;
    }
    startLinePicking({ story, chapter: null, widget: null, line: 0, question: '', labels: [] });
  }

  function openWidgetDrawer() {
    ui.widgetDrawer.hidden = false;
    document.body.classList.add('has-drawer');
    makeRoomForDrawer();
    renderWidgetDrawer();
    ui.widgetDrawerClose.focus();
  }

  function closeWidgetDrawer() {
    if (ui.widgetDrawer.hidden) return;
    ui.widgetDrawer.hidden = true;
    document.body.classList.remove('has-drawer');
    makeRoomForDrawer();
    if (!ui.widgetCountFab.hidden) ui.widgetCountFab.focus();
  }

  /**
   * The page narrows to make room for the drawer, so the chapter text rewraps and the boxes holding
   * it need measuring again — once now and once when the page has finished narrowing.
   */
  function makeRoomForDrawer() {
    refitTextareas();
    setTimeout(refitTextareas, 280);
  }

  const toggleWidgetDrawer = () => (ui.widgetDrawer.hidden ? openWidgetDrawer() : closeWidgetDrawer());

  function renderWidgetDrawer() {
    const story = currentStory();
    if (!story) return;
    const all = storyWidgets(story);
    ui.widgetDrawerTitle.textContent = plural(all.length, 'widget');
    ui.widgetDrawerClear.hidden = all.length < 2;

    ui.widgetDrawerBody.replaceChildren(all.length
      ? h('ul', { class: 'drawer__list' }, ...all.map(({ chapter, widget }) => {
        const snippet = widgetSnippet(chapter, widget);
        return h('li', { class: 'drawer__item' },
          h('button', { class: 'drawer__find', type: 'button', onclick: () => showWidgetSpot(chapter, widget) },
            h('span', { class: 'drawer__question' }, widgetTitle(widget)),
            h('span', { class: 'drawer__where' }, snippet
              ? `${chapter.title} · “${snippet}”`
              : `${chapter.title} · its text is gone from the chapter`)),
          h('button', {
            class: 'drawer__remove',
            type: 'button',
            title: 'Delete widget',
            'aria-label': `Delete the widget “${widgetTitle(widget)}”`,
            onclick: () => deleteWidgetFromDrawer(story, chapter, widget),
          }, icon('trash')));
      }))
      : h('p', { class: 'drawer__empty' }, 'This story has no widgets yet.'));
  }

  /**
   * Scrolls the chapter text to a widget's spot and makes its dot beat, so the writer can see where
   * it fires without opening it.
   */
  function showWidgetSpot(chapter, widget) {
    const card = ui.chapterList.querySelector(`[data-id="${chapter.id}"]`);
    const mark = card && card.querySelector(`.chapter__mark[data-widget="${widget.id}"]`);
    if (!mark) {
      showNotice('That widget’s line isn’t on screen: its text may have been removed from the chapter.');
      return;
    }

    const top = window.scrollY + mark.getBoundingClientRect().top - window.innerHeight / 3;
    window.scrollTo({ top, behavior: reducedMotion.matches ? 'auto' : 'smooth' });

    mark.classList.remove('is-found');
    void mark.offsetWidth; // restart the beat if the same widget is clicked again
    mark.classList.add('is-found');
  }

  function deleteWidgetFromDrawer(story, chapter, widget) {
    removeWidget(story, chapter, widget);
    syncStory(); // redraws the dots, the count and the drawer
  }

  function askToRemoveAllWidgets() {
    const story = currentStory();
    const all = story ? storyWidgets(story) : [];
    if (!all.length) return;
    askToConfirm({
      title: `Delete all ${plural(all.length, 'widget')}?`,
      text: `Every widget in “${story.name}” goes, along with the questions and labels on them. `
        + 'Answers already given stay in the reading reports. This can’t be undone.',
      confirm: 'Delete them all',
      then: () => {
        for (const { chapter, widget } of all) removeWidget(story, chapter, widget);
        syncStory();
      },
    });
  }

  /** Step one: the chapters turn into clickable lines. */
  function startLinePicking(draft) {
    saveTyping(); // the preview replaces the text boxes, so send anything just typed
    widgetDraft = draft;
    picking = true;
    keepingScroll(syncStory); // syncStory, not renderStory: the writer stays where they were reading
  }

  function endLinePicking() {
    picking = false;
    keepingScroll(syncStory);
  }

  function cancelLinePicking() {
    const draft = widgetDraft;
    endLinePicking();
    // Keep whatever was already set if this was a change of line rather than a new widget.
    if (draft && (draft.widget || draft.kindChosen)) showWidgetDialog(draft);
    else widgetDraft = null;
  }

  function chooseSpot(chapter, offset) {
    if (!widgetDraft) return;
    widgetDraft.chapter = chapter;
    widgetDraft.offset = offset;
    endLinePicking();
    // A brand-new widget is asked what kind it is first; everything else goes straight to the form.
    if (!widgetDraft.widget && !widgetDraft.kindChosen) showKindChooser();
    else showWidgetDialog(widgetDraft);
  }

  /** Step one and a half: the kinds on offer, as cards that come up one after another. */
  function showKindChooser() {
    ui.kindChoices.replaceChildren(...WIDGET_TYPES.map((kind, index) => {
      const card = h('button', {
        class: 'choices__one',
        type: 'button',
        onclick: () => {
          ui.kindDialog.returnValue = kind.type;
          ui.kindDialog.close();
        },
      }, h('span', { class: 'choices__name' }, kind.name));
      card.style.animationDelay = `${index * 70}ms`;
      return card;
    }));
    ui.kindDialog.returnValue = ''; // closing with Escape keeps the old value, so clear it
    ui.kindDialog.showModal();
  }

  /** Step two: the question and the ten labels. */
  function showWidgetDialog(draft) {
    widgetDraft = draft;
    draft.type = draft.type || 'scale';
    const from = draft.chapter.content.slice(draft.offset, draft.offset + 110).replace(/\n+/g, ' ');
    ui.widgetDialogTitle.textContent = draft.widget ? 'Edit widget' : 'Add a widget';
    ui.widgetQuestion.value = draft.question || '';
    ui.widgetImageAlt.value = draft.alt || '';
    ui.widgetImageFile.value = '';
    showKindFields();
    showImagePreview();
    ui.widgetWhere.textContent = `${draft.chapter.title} · “${truncate(from, 90)}”`;
    ui.widgetLabels.replaceChildren(...labelFields(draft.labels));
    ui.widgetDelete.hidden = !draft.widget;
    ui.widgetError.textContent = '';
    ui.widgetDialog.returnValue = '';
    ui.widgetDialog.showModal();
    if (draft.type === 'image') ui.widgetImageFile.focus();
    else ui.widgetQuestion.focus();
  }

  /** The ten label fields of a scale. */
  const labelFields = (labels) => Array.from({ length: 10 }, (unused, index) =>
    h('label', { class: 'labels__option' },
      h('span', { class: 'labels__number' }, String(index + 1)),
      h('input', {
        class: 'field__input',
        type: 'text',
        maxlength: '60',
        autocomplete: 'off',
        'aria-label': `Label for ${index + 1}`,
        value: (labels && labels[index]) || '',
      })));

  /** The kind was settled before the form opened, so only its own fields are shown. */
  function showKindFields() {
    const image = widgetDraft.type === 'image';
    ui.widgetScaleFields.hidden = image;
    ui.widgetLabelsField.hidden = image;
    ui.widgetImageFields.hidden = !image;
  }

  /** What the picked picture looks like, before it goes anywhere. */
  function showImagePreview() {
    const data = widgetDraft && widgetDraft.imageData;
    ui.widgetImagePreview.hidden = !data || widgetDraft.type !== 'image';
    ui.widgetImagePreview.replaceChildren(...(data
      ? [h('img', { class: 'image-preview__img', src: data, alt: '' }),
        h('p', { class: 'image-preview__note' }, widgetDraft.imageNote || '')]
      : []));
  }

  /** Reads the file the writer picked, shrinking it if it is too big to store. */
  async function pickImage(file) {
    if (!file || !widgetDraft) return;
    ui.widgetError.textContent = '';
    ui.widgetImagePreview.hidden = false;
    ui.widgetImagePreview.replaceChildren(h('p', { class: 'image-preview__note' }, 'Reading the picture…'));
    try {
      const picture = await prepareImage(file);
      if (!widgetDraft) return; // the form was closed while the file was being read
      widgetDraft.imageData = picture.data;
      widgetDraft.imageSize = picture;
      widgetDraft.imageNote = `${picture.width}×${picture.height}`
        + (picture.shrunk ? ' · shrunk to fit' : '')
        + ` · ${formatBytes(Math.round(picture.data.length * 0.75))}`;
    } catch (error) {
      widgetDraft.imageData = null;
      ui.widgetError.textContent = error.message;
    }
    showImagePreview();
  }

  /** Opens the form for a widget that already exists, from its row in the chapter. */
  function editWidget(story, chapter, widget) {
    const offset = widgetOffset(chapter, widget);
    const draft = {
      story,
      chapter,
      widget,
      offset,
      type: widget.type || 'scale',
      question: widget.question,
      alt: widget.alt || '',
      labels: [...widget.labels],
      imageData: null,
      imageNote: 'Fetching the picture…',
    };
    if (widget.type === 'image' && widget.imageId) {
      loadImage(widget.imageId).then((data) => {
        if (widgetDraft !== draft) return; // the form moved on while it was being fetched
        draft.imageData = data;
        draft.imageNote = data ? 'The picture as it is now' : 'That picture is no longer in the database.';
        showImagePreview();
      });
    }
    if (offset === -1) {
      showNotice('The text this widget was pinned to is gone. Pick a new spot for it.');
      startLinePicking(draft);
      return;
    }
    showWidgetDialog(draft);
  }

  function captureDialogValues() {
    if (!widgetDraft) return;
    widgetDraft.question = ui.widgetQuestion.value;
    widgetDraft.alt = ui.widgetImageAlt.value;
    widgetDraft.labels = [...ui.widgetLabels.querySelectorAll('input')].map((input) => input.value);
  }

  /** Saves the form. Returning without preventDefault lets the dialog close. */
  function saveWidgetDialog(event) {
    if (!widgetDraft) return;
    captureDialogValues();
    const { story, chapter, widget, offset, type } = widgetDraft;
    const stop = (message) => {
      event.preventDefault(); // keep the form open
      ui.widgetError.textContent = message;
    };

    const question = (widgetDraft.question || '').trim();
    if (type === 'scale' && !question) return stop('Give the widget a question.');
    if (type === 'image' && !widgetDraft.imageData) return stop('Pick a picture to show.');

    // A widget can be moved to a spot in another chapter, so drop it from the old one first.
    const from = widget && story.chapters.find((candidate) => candidate.widgets.some((each) => each.id === widget.id));
    if (from && from !== chapter) removeWidget(story, from, widget);

    const common = {
      id: widget ? widget.id : newId(),
      type,
      offset,
      anchor: chapter.content.slice(offset, offset + 80), // keeps the spot when text above it changes
      createdAt: widget ? widget.createdAt : Date.now(),
    };

    if (type === 'image') {
      saveImageWidget(story, chapter, widget, common);
      widgetDraft = null;
      return;
    }

    saveWidget(story, chapter, Object.assign(common, {
      question,
      labels: widgetDraft.labels.map((label) => label.trim()),
    }));
    widgetDraft = null;
    syncStory();
  }

  /**
   * Stores the picture, then the widget that points at it. The form closes straight away; if the
   * picture can't be stored the widget isn't written either, and the failure is said out loud.
   */
  async function saveImageWidget(story, chapter, widget, common) {
    const keptImage = widget && widget.type === 'image' ? widget.imageId : null;
    const picked = widgetDraft.imageData;
    const alt = (widgetDraft.alt || '').trim();
    const reuse = keptImage && picked === imagesSeen.get(keptImage);

    try {
      const imageId = reuse ? keptImage : await storeImage(widgetDraft.imageSize || { data: picked }, alt);
      if (!reuse && keptImage) forgetImage(keptImage); // the picture it used to show
      if (!reuse) imagesSeen.set(imageId, picked);
      saveWidget(story, chapter, Object.assign(common, { imageId, alt }));
      syncStory();
    } catch (error) {
      showNotice(`Couldn’t save the picture. ${explain(error)}`, { keep: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Widgets: popping up while reading
  // ---------------------------------------------------------------------------

  let watchedSpots = [];
  const widgetQueue = [];
  const widgetsShown = new Set();
  let openWidgetEntry = null;
  let revealedAt = 0; // when the picture in the open popup was uncovered
  let scrollFrame = 0;

  /** Collects the markers sitting at each widget's spot in the text that is on screen. */
  function watchWidgets(story) {
    watchedSpots = [];
    for (const chapter of story.chapters) {
      for (const widget of chapter.widgets) {
        if (!widget.question && widget.type !== 'image') continue; // nothing to show
        const element = ui.readerChapters.querySelector(`.reader__mark[data-widget="${widget.id}"]`);
        if (element) watchedSpots.push({ chapter, widget, element });
      }
    }
    checkWidgetSpots();
  }

  /** A widget pops up once its spot in the text has risen to a third of the way down the screen. */
  function checkWidgetSpots() {
    if (!watchedSpots.length) return;

    // At the very end of a story there is nothing left to scroll, so a spot near the end can never
    // rise to the third mark. Once the reader is at the bottom, anything still on screen counts.
    const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
    const mark = atBottom ? window.innerHeight : window.innerHeight / 3;

    for (const spot of watchedSpots) {
      if (widgetsShown.has(spot.widget.id)) continue;
      if (spot.element.getBoundingClientRect().top > mark) continue;
      widgetsShown.add(spot.widget.id);
      widgetQueue.push(spot);
    }
    if (widgetQueue.length && !openWidgetEntry) showNextWidget();
  }

  // Checked shortly after each burst of scrolling. A timer rather than an animation frame, because
  // frames stop in a hidden tab while timers keep running.
  function onReaderScroll() {
    if (scrollFrame) return;
    scrollFrame = setTimeout(() => {
      scrollFrame = 0;
      checkWidgetSpots();
    }, 60);
  }

  /** Stops watching, e.g. when the reader leaves the story. */
  function stopWidgets() {
    watchedSpots = [];
    widgetQueue.length = 0;
    widgetsShown.clear();
    openWidgetEntry = null;
    if (ui.widgetPopup.open) ui.widgetPopup.close();
  }

  function showNextWidget() {
    openWidgetEntry = widgetQueue.shift() || null;
    if (!openWidgetEntry) return;

    const { chapter, widget } = openWidgetEntry;

    if (widget.type === 'image') {
      // "Continue reading" waits until the cover is off, the way it waits for the slider.
      ui.popupQuestion.textContent = widget.alt || '';
      ui.popupQuestion.hidden = !widget.alt;
      ui.popupActions.hidden = true;
      revealedAt = 0;
      ui.popupScale.replaceChildren(imageWidget(widget, {
        onRevealed: () => {
          revealedAt = Date.now(); // the clock on how long they stay with it
          ui.popupActions.hidden = false;
        },
      }));
      ui.widgetPopup.showModal();
      return;
    }

    ui.popupQuestion.hidden = false;
    ui.popupQuestion.textContent = widget.question;
    ui.popupActions.hidden = true; // "Continue reading" waits until there is something to continue from
    ui.popupScale.replaceChildren(scaleWidget(widget.labels, {
      onPick: (value, label) => recordAnswer(chapter, widget, value, label),
      onHold: () => { ui.popupActions.hidden = false; },
    }));
    ui.widgetPopup.showModal();
  }

  /**
   * A picture as the reader meets it: covered, with a line to drag from left to right that wipes
   * the cover away. The picture is only fetched when the widget opens, so the story's own documents
   * stay small. `onRevealed` is called once the cover is all the way off.
   */
  function imageWidget(widget, { onRevealed } = {}) {
    const frame = h('div', { class: 'reveal' },
      h('p', { class: 'reveal__waiting' }, 'Fetching the picture…'));

    const build = (data) => {
      if (!data) {
        frame.replaceChildren(h('p', { class: 'reveal__waiting' }, 'That picture is no longer in the database.'));
        if (onRevealed) onRevealed(); // nothing to reveal, so don't trap the reader
        return;
      }

      const picture = h('img', { class: 'reveal__img', src: data, alt: widget.alt || '' });
      // The line lives inside the frame so the rounded corners cut it; the grip sits outside it so
      // it stays whole even when the line is hard against an edge.
      const frameInner = h('div', { class: 'reveal__frame' },
        picture,
        h('div', { class: 'reveal__line', 'aria-hidden': 'true' }));
      const grip = h('div', { class: 'reveal__grip', 'aria-hidden': 'true' });
      const range = h('input', {
        class: 'reveal__range',
        type: 'range',
        min: '0',
        max: '100',
        step: '0.1',
        value: '0',
        'aria-label': `Drag to reveal the picture${widget.alt ? `: ${widget.alt}` : ''}`,
      });

      let done = false;
      const paint = () => {
        frame.style.setProperty('--revealed', `${Number(range.value)}%`);
      };

      // Once it has been taken hold of, the grip fills in and the flash that beckons stops.
      const take = () => frame.classList.add('is-held');

      const finish = () => {
        if (done) return;
        done = true;
        range.value = '100';
        range.disabled = true;
        frame.classList.add('is-revealed');
        paint();
        if (onRevealed) onRevealed();
      };

      range.addEventListener('pointerdown', take);
      range.addEventListener('keydown', take);
      range.addEventListener('input', () => {
        take();
        paint();
        if (Number(range.value) >= 99) finish();
      });
      // Let go near the end and the rest of the cover goes with it.
      range.addEventListener('change', () => {
        if (Number(range.value) >= 85) finish();
      });

      frame.reset = () => {
        done = false;
        range.disabled = false;
        range.value = '0';
        frame.classList.remove('is-revealed', 'is-held');
        paint();
      };

      frame.replaceChildren(frameInner, grip, range);
      paint();
    };

    if (widget.data) build(widget.data); // a sample, already to hand
    else loadImage(widget.imageId).then(build, () => build(null));

    frame.reset = () => {}; // replaced once the picture is here and the cover exists
    return frame;
  }

  /**
   * The 1-to-10 scale as the reader meets it: a slider that slides freely, with the number it is
   * nearest and that number's label read out above it.
   *
   * The handle moves in hundredths so it follows the finger rather than jumping between ten stops,
   * while the answer is always one of the ten. An untouched slider is not an answer — it only ever
   * rests somewhere — so nothing is read from it until the reader takes hold. `onPick` is called
   * once the handle settles, not on every step of a drag. Leave it out for a preview that records
   * nothing.
   */
  function scaleWidget(labels, { onPick, onHold } = {}) {
    // Built once and then only written to: a drag fires hundreds of events, and rebuilding this on
    // each of them — worse, inside a live region — is what made the handle lag behind the pointer.
    // The slider's own aria-valuetext is what a screen reader reads as it moves.
    const labelNode = h('span', { class: 'scale__label', hidden: 'hidden' });
    const valueNode = h('span', { class: 'scale__value' });
    const readout = h('p', { class: 'scale__readout', hidden: 'hidden' }, labelNode, valueNode);
    const slider = h('input', {
      class: 'scale__slider',
      type: 'range',
      min: '1',
      max: '10',
      step: '0.01', // fine enough to glide; the answer is still rounded to a whole number
      value: '5.5', // dead centre of the track; 5 would sit a little to the left
      'aria-label': 'Choose a number from 1 to 10',
    });

    let held = false;
    let showing = null; // the whole number on show, so a move within one costs nothing
    const chosen = () => Math.min(10, Math.max(1, Math.round(Number(slider.value))));

    const show = () => {
      const value = chosen();
      if (value === showing) return; // the handle moved, but not onto a different number
      showing = value;
      const label = labels[value - 1] || '';
      labelNode.textContent = label;
      labelNode.hidden = !label;
      valueNode.textContent = String(value);
      readout.hidden = false; // rises into place, pushing the question up
      slider.setAttribute('aria-valuetext', label ? `${value}, ${label}` : String(value));
      slider.classList.add('is-set');
    };

    const settle = () => {
      take();
      show();
      if (onPick) onPick(chosen(), labels[chosen() - 1] || '');
    };

    const take = () => {
      if (held) return;
      held = true;
      show();
      if (onHold) onHold();
    };

    // Taking hold counts even when the handle doesn't move, so the number it rests on can be chosen.
    slider.addEventListener('pointerdown', take);
    slider.addEventListener('input', () => { take(); show(); });
    slider.addEventListener('change', settle);

    // Arrow keys move a whole number at a time; hundredths would be no use from a keyboard.
    const STEPS = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 };
    slider.addEventListener('keydown', (event) => {
      const step = STEPS[event.key];
      const edge = event.key === 'Home' ? 1 : event.key === 'End' ? 10 : null;
      if (step === undefined && edge === null) return;
      event.preventDefault();
      slider.value = String(edge !== null ? edge : Math.min(10, Math.max(1, chosen() + step)));
      settle();
    });

    const node = h('div', { class: 'scale' }, readout, slider);
    node.reset = () => {
      held = false;
      showing = null;
      slider.value = '5.5';
      slider.classList.remove('is-set');
      slider.removeAttribute('aria-valuetext');
      readout.hidden = true;
      labelNode.hidden = true;
    };
    return node;
  }

  // ---------------------------------------------------------------------------
  // Reading report
  // ---------------------------------------------------------------------------

  let reportWatch = null;
  let reportSessions = [];
  let reportSession = null; // the session being looked at, if any
  const reportPicked = new Set(); // sessions ticked in the list, waiting to be merged

  /**
   * Every widget in the story, in the order a reader meets them: chapter by chapter, and within a
   * chapter by where it sits in the text — not by when it was made.
   */
  const storyWidgets = (story) => story.chapters.flatMap((chapter) => chapter.widgets
    .map((widget) => ({ chapter, widget, at: widgetOffset(chapter, widget) }))
    // One whose text has gone from the chapter has no place in it, so it goes last.
    .sort((a, b) => (a.at < 0) - (b.at < 0) || a.at - b.at));

  // Only some kinds ask something, and answers are what a report counts, so it counts those alone.
  const storyQuestions = (story) => storyWidgets(story).filter(({ widget }) => widgetKind(widget).answers);

  // Uncovering a picture is noted alongside the answers, but it isn't one.
  const answerCount = (session) => Object.values(session.answers ?? {}).filter((one) => !one.revealed).length;
  const revealCount = (session) => Object.values(session.answers ?? {}).filter((one) => one.revealed).length;

  function openReport() {
    const story = currentStory();
    if (!story) return;

    reportSession = null;
    reportPicked.clear();
    ui.database.hidden = true;
    ui.gallery.hidden = true;
    ui.moreStories.hidden = true;
    ui.noStory.hidden = true;
    ui.report.hidden = false;
    ui.chapterList.hidden = true;
    ui.firstChapterButton.hidden = true;
    ui.addChapterButton.hidden = true;
    ui.reportBody.replaceChildren(h('p', { class: 'report__empty' }, 'Loading sessions…'));
    animateIn(ui.report);
    ui.reportBack.focus();
    updateWidgetFab();

    if (reportWatch) reportWatch();
    reportWatch = firestore.onSnapshot(
      firestore.query(firestore.collection(db, 'sessions'), firestore.where('storyId', '==', story.id)),
      (snapshot) => renderReport(story, snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))),
      (error) => ui.reportBody.replaceChildren(h('p', { class: 'report__empty' }, `Couldn’t load the report. ${explain(error)}`))
    );
  }

  function closeReport() {
    if (reportWatch) reportWatch();
    reportWatch = null;
    ui.report.hidden = true;
    reportSession = null;
    reportPicked.clear();
    renderEditor();
    updateWidgetFab();
  }

  function renderReport(story, sessions) {
    reportSessions = [...sessions].sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0));
    const open = reportSession && reportSessions.find((session) => session.id === reportSession);
    reportSession = open ? open.id : null; // the open report may have just been deleted
    // One button goes back one step: to the list of reports, or out of the reports altogether.
    ui.reportBack.replaceChildren(icon('back'), open ? 'All reading reports' : 'Back to writing');
    ui.reportBody.replaceChildren(open ? sessionPage(story, open) : sessionsPage(story));
  }

  const showReportList = () => {
    reportSession = null;
    renderReport(currentStory(), reportSessions);
  };

  const showReportSession = (id) => {
    reportSession = id;
    renderReport(currentStory(), reportSessions);
  };

  /** Every reading session of this story, newest first. */
  function sessionsPage(story) {
    const questions = storyQuestions(story).length;
    const pictures = storyWidgets(story).length - questions;
    const answered = reportSessions.filter((session) => answerCount(session) > 0);
    const picked = reportSessions.filter((session) => reportPicked.has(session.id));

    return h('div', {},
      // The merge controls sit on the heading's own line, appearing only once something is ticked.
      h('div', { class: 'report__head' },
        h('h2', { class: 'report__heading' }, 'Reading reports'),
        ...(picked.length ? [h('div', { class: 'report__merge', role: 'status' },
          h('span', { class: 'report__merge-count' }, picked.length < 2
            ? 'One ticked · tick another to merge'
            : `${plural(picked.length, 'report')} ticked`),
          ...(picked.length > 1
            ? [h('button', { class: 'btn btn--primary btn--small', type: 'button', onclick: () => askToMergeSessions(picked) }, 'Merge into one')]
            : []),
          h('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: clearSessionPicks }, 'Clear'))] : [])),
      h('p', { class: 'report__summary' },
        `${plural(reportSessions.length, 'reading session')} · ${answered.length} with answers`),

      reportSessions.length
        ? h('ul', { class: 'report__session-list' }, ...reportSessions.map((session) =>
          h('li', {},
            h('label', { class: 'report__pick' },
              h('input', Object.assign(
                { type: 'checkbox', 'aria-label': `Pick the report from ${sessionWhen(session)} to merge`,
                  onchange: (event) => pickSession(session.id, event.target.checked) },
                reportPicked.has(session.id) ? { checked: 'checked' } : null))),
            h('button', { class: 'report__session', type: 'button', onclick: () => showReportSession(session.id) },
              h('span', { class: 'report__when' }, timeAgo(Number(session.startedAt) || 0)),
              h('span', { class: 'report__answers' },
                [questions ? `${answerCount(session)} of ${plural(questions, 'question')} answered` : '',
                  pictures ? `${revealCount(session)} of ${plural(pictures, 'picture')} uncovered` : '']
                  .filter(Boolean).join(' · ') || 'nothing to answer'),
              ...(Number(session.mergedFrom) > 1
                ? [h('span', { class: 'report__merged' }, `${session.mergedFrom} merged`)] : []),
              icon('arrow')),
            h('button', {
              class: 'report__session-remove',
              type: 'button',
              title: 'Delete report',
              'aria-label': `Delete the report from ${sessionWhen(session)}`,
              onclick: () => askToDeleteSession(session),
            }, icon('trash')))))
        : h('p', { class: 'report__empty' }, 'No one has opened this story yet.'));
  }

  function pickSession(id, on) {
    if (on) reportPicked.add(id);
    else reportPicked.delete(id);
    renderReport(currentStory(), reportSessions);
  }

  function clearSessionPicks() {
    reportPicked.clear();
    renderReport(currentStory(), reportSessions);
  }

  /** What one entry on a session says: a number and its label, or how long a picture was looked at. */
  function answerReads(answer) {
    if (!answer.revealed) return `${answer.value}${answer.label ? ` · ${answer.label}` : ''}`;
    const seconds = Number(answer.seconds) || 0;
    return seconds < 1 ? 'Uncovered · a glance' : `Uncovered · ${plural(seconds, 'second')}`;
  }

  /** When a reading session started, written out in full. */
  function sessionWhen(session) {
    const started = Number(session.startedAt) || 0;
    return started
      ? new Date(started).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : 'Reading session';
  }

  /** One reading session: what the reader answered at each widget, and what that adds up to. */
  function sessionPage(story, session) {
    const widgets = storyWidgets(story);
    const questions = storyQuestions(story);
    const pictures = widgets.length - questions.length;
    const started = Number(session.startedAt) || 0;

    return h('div', {},
      h('h2', { class: 'report__heading' }, sessionWhen(session)),
      h('p', { class: 'report__summary' },
        `${timeAgo(started)} · ${answerCount(session)} of ${plural(questions.length, 'question')} answered`
        + (pictures ? ` · ${revealCount(session)} of ${plural(pictures, 'picture')} uncovered` : '')
        + (Number(session.mergedFrom) > 1 ? ` · ${plural(Number(session.mergedFrom), 'reading')} merged into one` : '')),

      h('section', { class: 'report__reading' },
        h('h3', { class: 'report__heading' }, 'Summary'),
        ...summarise(story, session).map((line) => h('p', { class: 'report__line' }, line))),

      widgets.length
        ? h('ul', { class: 'report__answer-list' }, ...widgets.map(({ chapter, widget }) => {
          const answer = (session.answers ?? {})[widget.id];
          return h('li', { class: 'report__answer' },
            h('span', { class: 'report__answer-text' },
              h('span', { class: 'report__question' }, widgetTitle(widget)),
              h('span', { class: 'report__chapter' }, chapter.title)),
            answer
              ? h('span', { class: 'report__value' }, answerReads(answer))
              : h('span', { class: 'report__value report__value--none' },
                widget.type === 'image' ? 'Not uncovered' : 'Not answered'));
        }))
        : h('p', { class: 'report__empty' }, 'This story has no widgets yet.'),

      h('p', { class: 'report__foot' },
        h('button', { class: 'btn btn--ghost report__delete', type: 'button', onclick: () => askToDeleteSession(session) },
          icon('trash'), 'Delete this report')));
  }

  /**
   * A few plain sentences about one reader's session. The app works these out from the answers
   * themselves; no AI is involved.
   */
  function summarise(story, session) {
    const questions = storyQuestions(story);
    const pictures = storyWidgets(story).filter(({ widget }) => widget.type === 'image');
    if (!questions.length && !pictures.length) return ['This story has no widgets yet.'];

    const answers = (session.answers ?? {});
    const answered = questions
      .map((entry) => ({ ...entry, answer: answers[entry.widget.id] }))
      .filter((entry) => entry.answer && Number(entry.answer.value) >= 1);
    const lines = [];

    if (!questions.length) {
      lines.push('There is nothing to answer in this story — only pictures.');
    } else if (!answered.length) {
      lines.push('They opened the story but didn’t answer any of the questions.');
    } else {
      const values = answered.map((entry) => Number(entry.answer.value));
      const average = values.reduce((sum, value) => sum + value, 0) / values.length;
      const named = (entry) => `“${truncate(entry.widget.question, 60)}” at ${entry.answer.value}`
        + (entry.answer.label ? ` (${entry.answer.label})` : '');
      lines.push(`They answered ${answered.length} of ${plural(questions.length, 'question')}, `
        + `averaging ${average.toFixed(1)} out of 10.`);

      const highest = answered.reduce((best, entry) => (Number(entry.answer.value) > Number(best.answer.value) ? entry : best));
      const lowest = answered.reduce((worst, entry) => (Number(entry.answer.value) < Number(worst.answer.value) ? entry : worst));
      if (highest !== lowest) lines.push(`Strongest: ${named(highest)}. Weakest: ${named(lowest)}.`);

      if (answered.length > 1) {
        const first = Number(answered[0].answer.value);
        const last = Number(answered[answered.length - 1].answer.value);
        lines.push(Math.abs(last - first) >= 2
          ? `Their answers ${last > first ? 'climbed' : 'fell'} as the story went on, from ${first} to ${last}.`
          : 'Their answers stayed at about the same level throughout.');
      }

      const lastAnswered = questions.reduce((last, entry, index) => (answers[entry.widget.id] ? index : last), -1);
      if (lastAnswered > -1 && lastAnswered < questions.length - 1) {
        lines.push(`They stopped after “${truncate(questions[lastAnswered].widget.question, 60)}”, `
          + `leaving ${plural(questions.length - lastAnswered - 1, 'question')} untouched.`);
      }
    }

    if (pictures.length) {
      const seen = pictures.map(({ widget }) => answers[widget.id]).filter((one) => one && one.revealed);
      const looked = seen.reduce((total, one) => total + (Number(one.seconds) || 0), 0);
      lines.push(seen.length
        ? `They uncovered ${seen.length} of ${plural(pictures.length, 'picture')}, `
          + `${looked < 1 ? 'barely pausing over them' : `looking for ${plural(looked, 'second')} in all`}.`
        : `They left ${pictures.length === 1 ? 'the picture' : `all ${pictures.length} pictures`} covered.`);
    }

    const times = answered.map((entry) => Number(entry.answer.answeredAt)).filter(Boolean);
    if (times.length > 1) {
      const minutes = Math.round((Math.max(...times) - Math.min(...times)) / 60000);
      lines.push(minutes >= 1
        ? `About ${plural(minutes, 'minute')} passed between their first and last answer.`
        : 'Their answers came within a minute of each other.');
    }
    return lines;
  }

  function timeAgo(time) {
    if (!time) return 'at an unknown time';
    const minutes = Math.round((Date.now() - time) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${plural(minutes, 'minute')} ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${plural(hours, 'hour')} ago`;
    const days = Math.round(hours / 24);
    return days <= 14 ? `${plural(days, 'day')} ago` : new Date(time).toLocaleDateString();
  }

  // ---------------------------------------------------------------------------
  // Entry screen
  // ---------------------------------------------------------------------------

  /** Fills the six boxes: a dot for each digit typed, and a highlight on the next one. */
  function updateCodeCells() {
    const typed = ui.codeInput.value.length;
    [...ui.codeCells.children].forEach((cell, index) => {
      cell.classList.toggle('is-filled', index < typed);
      cell.classList.toggle('is-next', index === Math.min(typed, 5));
    });
  }

  function checkCode() {
    const opens = CODES[ui.codeInput.value];
    if (opens) {
      openPart(opens);
      return;
    }
    ui.codeInput.value = '';
    updateCodeCells();
    ui.codeCells.classList.add('is-wrong');
    shake(ui.codeCells);
    ui.codeMessage.textContent = 'That code didn’t work. Try again.';
  }

  /** Opens the reading part or the writing part, depending on the code. */
  function openPart(which) {
    part = which;
    rememberOpenPart();
    ui.logout.hidden = false;
    if (which === 'read') {
      showPicker();
      animateIn(ui.gateInner);
      ui.gateTitle.focus(); // so screen readers announce "Pick your experience"
    } else {
      ui.gate.hidden = true;
      if (loaded) render();
      else ui.status.hidden = false; // "Loading your stories…" until they arrive
    }
  }

  /** Leaves the reading part or the writing part and shows the entry screen, which asks for a code again. */
  function logOut() {
    saveTyping(); // send any chapter text still waiting to be saved
    const gateWasShowing = !ui.gate.hidden; // the story picker lives on the entry screen
    part = null;
    rememberOpenPart(); // logging out is the one thing that forgets the code
    readingId = null;
    picking = false;
    widgetDraft = null;
    closeWidgetDrawer();
    updateWidgetFab(); // with no part open, every floating button goes
    closeNewStoryForm();
    for (const screen of [ui.welcome, ui.workspace, ui.reader, ui.status, ui.picker, ui.logout]) screen.hidden = true;

    ui.gateTitle.replaceChildren(...gateIntro.title.map((node) => node.cloneNode(true)));
    ui.gateLead.textContent = gateIntro.lead;
    ui.codeForm.reset();
    ui.codeForm.hidden = false;
    ui.codeCells.classList.remove('is-wrong');
    ui.codeMessage.textContent = '';
    updateCodeCells();
    ui.gate.hidden = false;
    document.title = APP_NAME;
    window.scrollTo(0, 0);
    if (gateWasShowing) animateIn(ui.gateInner); // otherwise its entrance animation replays by itself
    ui.codeInput.focus();
  }

  /** Shows the part that was opened, once the stories have loaded (nothing while the entry screen is up). */
  function showPart() {
    if (part === 'read') renderReadPart();
    else if (part === 'write') render();
  }

  // ---------------------------------------------------------------------------
  // Reading part
  // ---------------------------------------------------------------------------

  // Stories worth reading: the ones with at least one chapter.
  // Putting a story aside tidies the writing side only; readers are still offered it.
  const readableStories = () => state.stories.filter((story) => story.chapters.length > 0);

  /** Turns the entry screen into the story picker: "Pick your experience" and the list of stories. */
  function showPicker() {
    readingId = null;
    stopWidgets();
    document.title = APP_NAME;
    ui.reader.hidden = true;
    ui.gate.hidden = false;
    ui.gateTitle.replaceChildren('Pick your ', h('em', {}, 'experience'));
    ui.gateLead.textContent = 'Choose a story and start reading.';
    ui.codeForm.hidden = true;
    ui.picker.hidden = false;
    renderPicker();
  }

  function renderPicker() {
    const stories = readableStories();
    ui.pickerList.replaceChildren(...stories.map((story) =>
      h('li', {},
        h('button', { class: 'picker__item', type: 'button', 'data-id': story.id, onclick: () => openReader(story.id) },
          h('span', { class: 'picker__text' },
            h('span', { class: 'picker__name' }, story.name),
            h('span', { class: 'picker__meta' }, storySummary(story))),
          icon('arrow')))));
    ui.pickerStatus.textContent = loaded ? 'There are no stories to read yet.' : 'Loading stories…';
    ui.pickerStatus.hidden = loaded && stories.length > 0;
  }

  function openReader(id) {
    stopWidgets(); // a fresh story means its widgets can pop up again
    readingId = id;
    renderReader();
    startSession(state.stories.find((candidate) => candidate.id === id));
    window.scrollTo(0, 0);
    animateIn(ui.readerInner);
    ui.readerTitle.focus();

    // The page is still settling here (web font, entrance animation, scroll reset), so look at the
    // lines once more in a moment. Widgets that already popped up are remembered, so none repeat.
    setTimeout(() => {
      const story = state.stories.find((candidate) => candidate.id === id);
      if (story && readingId === id) watchWidgets(story);
    }, 500);
  }

  function renderReader() {
    const story = state.stories.find((candidate) => candidate.id === readingId);
    document.title = `${story.name} · ${APP_NAME}`;
    ui.gate.hidden = true;
    ui.reader.hidden = false;
    ui.readerTitle.textContent = story.name;
    ui.readerMeta.textContent = storySummary(story);
    ui.readerChapters.replaceChildren(...story.chapters.map((chapter) =>
      h('section', { class: 'reader__chapter' },
        h('h2', { class: 'reader__chapter-title' }, chapter.title),
        chapter.content.trim()
          ? h('div', { class: 'reader__text' }, ...readerLines(chapter))
          : h('p', { class: 'reader__empty' }, 'This chapter has no text yet.'))));
    watchWidgets(story);
  }

  /** The chapter's text with an invisible marker at each widget's spot, so the text reads as written. */
  function readerLines(chapter) {
    const marks = chapter.widgets
      .map((widget) => ({ widget, at: widgetOffset(chapter, widget), className: 'reader__mark' }))
      .filter((mark) => mark.at >= 0);
    return contentNodes(chapter, { marks });
  }

  /** Back from a story to the list, with focus on the story just read. */
  function closeReader() {
    const id = readingId;
    showPicker();
    window.scrollTo(0, 0);
    ui.pickerList.querySelector(`[data-id="${id}"]`)?.focus();
  }

  /** Keeps the reading part current when stories change, here or on another device. */
  function renderReadPart() {
    if (readableStories().some((story) => story.id === readingId)) renderReader();
    else showPicker(); // nothing open, or the open story was deleted
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /** Selects a story and shows it on the right. */
  function showStory(id) {
    closeReport();
    closeDatabase();
    closeGallery();
    closeMoreStories();
    closeWidgetDrawer();
    state.selectedId = id;
    rememberOpenStory();
    render();
    window.scrollTo(0, 0);
    animateIn(ui.editor);
  }

  function selectStory(id) {
    if (id !== state.selectedId) showStory(id);
    // Already on it: this is how you come back from the reports or the database screen.
    else {
      closeReport();
      closeDatabase();
      closeGallery();
      closeMoreStories();
      closeWidgetDrawer();
    }
  }

  /** Adds an empty chapter card whose title can be typed straight away. */
  function startNewChapter() {
    if (draftChapter) return;

    const story = currentStory();
    const input = titleInput('', `Chapter ${story.chapters.length + 1} title`);
    const draft = h('li', { class: 'chapter chapter--draft' },
      input,
      h('p', { class: 'chapter__hint' }, 'Press Enter to save · Esc to cancel'));

    draftChapter = draft;
    ui.chapterList.append(draft);
    updateChapterButtons(story);
    animateIn(draft);
    input.focus({ preventScroll: true });
    draft.scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' });

    whenTitleDone(input, (title, byKeyboard) => {
      if (!draft.isConnected) return; // another story was opened in the meantime
      draftChapter = null;
      draft.remove();

      let card = null;
      if (title) {
        const chapter = addChapter(story, title);
        syncChapters(story);
        renderStoryList(); // refreshes the chapter count in the sidebar
        card = ui.chapterList.querySelector(`[data-id="${chapter.id}"]`);
      }
      updateChapterButtons(story);
      updateMeta(story);

      if (byKeyboard) {
        if (card) card.querySelector('.chapter__add-content').focus();
        else (story.chapters.length ? ui.addChapterButton : ui.firstChapterButton).focus();
      }
    });
  }

  function closeNewStoryForm() {
    ui.newStoryForm.reset();
    ui.newStoryForm.hidden = true;
    ui.newStoryButton.hidden = false;
  }

  // What to do if the user says yes to what they were asked about.
  let confirmed = null;

  /** Asks before doing something that can't be undone. */
  function askToConfirm({ title, text, confirm, danger = true, then }) {
    confirmed = then;
    ui.confirmTitle.textContent = title;
    ui.confirmText.textContent = text;
    ui.confirmButton.textContent = confirm;
    ui.confirmButton.classList.toggle('btn--danger', danger);
    ui.confirmButton.classList.toggle('btn--primary', !danger);
    ui.confirmDialog.returnValue = ''; // closing with Escape keeps the old value, so clear it
    ui.confirmDialog.showModal();
  }

  function askToDeleteStory(id) {
    const story = state.stories.find((candidate) => candidate.id === id);
    const chapters = story.chapters.length;
    askToConfirm({
      title: `Delete “${story.name}”?`,
      text: chapters
        ? `Its ${plural(chapters, 'chapter')} will be deleted too. This can’t be undone.`
        : 'This can’t be undone.',
      confirm: 'Delete story',
      then: () => deleteStory(id),
    });
  }

  /** A reading report is one reader's visit, so deleting it takes their answers with it. */
  function askToDeleteSession(session) {
    const started = Number(session.startedAt) || 0;
    const answers = answerCount(session);
    askToConfirm({
      title: started ? `Delete the report from ${sessionWhen(session)}?` : 'Delete this reading report?',
      text: answers
        ? `Its ${plural(answers, 'answer')} will be deleted too. This can’t be undone.`
        : 'This can’t be undone.',
      confirm: 'Delete report',
      then: () => deleteSession(session.id),
    });
  }

  /** Asks before folding several reports into one, since the ones folded in are then gone. */
  function askToMergeSessions(sessions) {
    askToConfirm({
      title: `Merge ${plural(sessions.length, 'reading report')}?`,
      text: 'They become one report, kept under the earliest of their times. Where more than one '
        + 'of them answered the same question, the earliest answer is the one kept. This can’t be undone.',
      confirm: 'Merge reports',
      danger: false,
      then: () => mergeSessions(sessions),
    });
  }

  // ---------------------------------------------------------------------------
  // More stories: the ones put aside
  // ---------------------------------------------------------------------------

  /** Takes a story out of the sidebar and out of the reader's list. Nothing in it is lost. */
  function putStoryAside(story) {
    setStoryHidden(story, true);
    if (story.id === state.selectedId) {
      ensureSelection();
      render();
    } else {
      renderStoryList();
    }
    showNotice(`“${story.name}” is under More stories. Readers can still open it.`);
  }

  function bringStoryBack(story) {
    setStoryHidden(story, false);
    closeMoreStories();
    showStory(story.id);
  }

  function openMoreStories() {
    ui.moreStories.hidden = false;
    ui.noStory.hidden = true;
    ui.report.hidden = true;
    ui.database.hidden = true;
    ui.gallery.hidden = true;
    ui.storyHeader.hidden = true;
    ui.chapterList.hidden = true;
    ui.firstChapterButton.hidden = true;
    ui.addChapterButton.hidden = true;
    renderMoreStories();
    animateIn(ui.moreStories);
    ui.moreStories.focus();
    renderStoryList(); // no story is open, so none should look it
    updateWidgetFab();
  }

  function closeMoreStories() {
    if (ui.moreStories.hidden) return;
    ui.moreStories.hidden = true;
    renderStoryList();
    renderEditor();
    updateWidgetFab();
  }

  function renderMoreStories() {
    const aside = putAside();

    ui.moreStoriesBody.replaceChildren(h('div', {},
      h('header', { class: 'story-header' },
        h('h1', { class: 'story-title' }, 'More stories'),
        h('p', { class: 'story-meta' }, aside.length
          ? `${plural(aside.length, 'story')} put aside · out of the list on the left, still open to readers`
          : 'Nothing put aside')),

      aside.length
        ? h('ul', { class: 'aside-list' }, ...aside.map((story) => h('li', { class: 'aside-item' },
          h('div', { class: 'aside-text' },
            h('span', { class: 'aside-name' }, story.name),
            h('span', { class: 'aside-meta' }, storySummary(story))),
          h('button', { class: 'btn btn--soft btn--small', type: 'button', onclick: () => bringStoryBack(story) },
            'Bring it back'),
          h('button', {
            class: 'story-action',
            type: 'button',
            title: 'Delete story',
            'aria-label': `Delete “${story.name}”`,
            onclick: () => askToDeleteStory(story.id),
          }, icon('trash')))))
        : h('p', { class: 'report__empty' },
          'Put a story aside from the list on the left and it waits here until you want it again.')));
  }

  // ---------------------------------------------------------------------------
  // Widget gallery: every widget in the library, as a reader meets it
  // ---------------------------------------------------------------------------

  function openGallery() {
    ui.gallery.hidden = false;
    ui.noStory.hidden = true;
    ui.report.hidden = true;
    ui.database.hidden = true;
    ui.moreStories.hidden = true;
    ui.storyHeader.hidden = true; // the gallery spans every story, so no one story's heading
    ui.chapterList.hidden = true;
    ui.firstChapterButton.hidden = true;
    ui.addChapterButton.hidden = true;
    renderGallery();
    animateIn(ui.gallery);
    ui.gallery.focus();
    renderStoryList(); // no story is open, so none should look it
    updateWidgetFab();
  }

  function closeGallery() {
    if (ui.gallery.hidden) return;
    ui.gallery.hidden = true;
    renderStoryList();
    renderEditor();
    updateWidgetFab();
  }

  function renderGallery() {
    const inUse = state.stories.flatMap((story) => storyWidgets(story));

    ui.galleryBody.replaceChildren(h('div', {},
      h('header', { class: 'story-header' },
        h('h1', { class: 'story-title' }, 'Widget gallery'),
        h('p', { class: 'story-meta' }, WIDGET_TYPES.length === 1
          ? 'One kind of widget · shown as a reader meets it'
          : `${WIDGET_TYPES.length} kinds of widget · shown as a reader meets them`)),

      h('div', { class: 'gallery__grid' },
        ...WIDGET_TYPES.map((kind) => galleryCard(kind,
          inUse.filter((entry) => (entry.widget.type || 'scale') === kind.type).length)))));
  }

  /**
   * The form you fill in to add this kind of widget — the real one, cloned, so the gallery can't
   * show something the form doesn't. It is filled with the sample and made inert: a picture of the
   * form, not a second copy of it.
   */
  function previewForm(kind) {
    const copy = ui.widgetDialog.cloneNode(true);
    const part = (id) => copy.querySelector(`#${id}`);
    const image = kind.type === 'image';

    part('widget-dialog-title').textContent = 'Add a widget';
    part('widget-question').value = kind.sample.question || '';
    part('widget-labels').replaceChildren(...labelFields(kind.sample.labels));
    part('widget-image-alt').value = kind.sample.alt || '';
    part('widget-where').textContent = 'Chapter 1 · “The message lingers in your thoughts, sparking…”';
    part('widget-error').textContent = '';
    part('widget-delete').hidden = true;

    part('widget-scale-fields').hidden = image;
    part('widget-labels-field').hidden = image;
    part('widget-image-fields').hidden = !image;

    const shot = part('widget-image-preview');
    shot.hidden = !image;
    if (image) {
      shot.replaceChildren(
        h('img', { class: 'image-preview__img', src: kind.sample.data, alt: '' }),
        h('p', { class: 'image-preview__note' }, '1400×840 · shrunk to fit · 15.7 KB'));
    }

    // Ids belong to the real form, and nothing here is to be typed in.
    copy.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
    copy.removeAttribute('id');
    copy.removeAttribute('aria-labelledby');
    copy.setAttribute('open', '');
    copy.setAttribute('inert', '');
    copy.classList.add('gallery__form');
    return copy;
  }

  /** The popup as the reader gets it, working but recording nothing. */
  function previewPopup(kind) {
    if (kind.type === 'image') {
      const actions = h('div', { class: 'dialog__actions widget-actions', hidden: 'hidden' });
      const picture = imageWidget(kind.sample, { onRevealed: () => { actions.hidden = false; } });

      actions.append(h('button', {
        class: 'btn btn--primary',
        type: 'button',
        // In a story this closes the popup; here it covers the picture again for another go.
        onclick: () => {
          picture.reset();
          actions.hidden = true;
        },
      }, 'Continue reading'));

      return h('div', { class: 'dialog gallery__popup' },
        h('div', { class: 'dialog__body' },
          h('h2', { class: 'dialog__title' }, kind.sample.alt),
          picture,
          actions));
    }

    const actions = h('div', { class: 'dialog__actions widget-actions', hidden: 'hidden' });
    const scale = scaleWidget(kind.sample.labels, { onHold: () => { actions.hidden = false; } });

    actions.append(h('button', {
      class: 'btn btn--primary',
      type: 'button',
      // In a story this closes the popup; here it puts the sample back for another go.
      onclick: () => {
        scale.reset();
        actions.hidden = true;
      },
    }, 'Continue reading'));

    return h('div', { class: 'dialog gallery__popup' },
      h('div', { class: 'dialog__body' },
        h('h2', { class: 'dialog__title' }, kind.sample.question),
        scale,
        actions));
  }

  function galleryCard(kind, used) {
    return h('article', { class: 'gallery__card' },
      h('h2', { class: 'gallery__name' }, kind.name),
      h('p', { class: 'gallery__about' }, kind.about),

      h('p', { class: 'gallery__preview-label' }, 'As the reader sees it'),
      h('div', { class: 'gallery__stage' }, previewPopup(kind)),

      h('p', { class: 'gallery__preview-label' }, 'As you set it up'),
      h('div', { class: 'gallery__stage gallery__stage--form' }, previewForm(kind)),

      h('p', { class: 'gallery__note' }, used
        ? `${used === 1 ? 'Used once' : `Used ${used} times`} across your stories`
        : 'Not used in any story yet'));
  }

  // ---------------------------------------------------------------------------
  // Manage database: what Firestore is actually holding
  // ---------------------------------------------------------------------------

  const COLLECTIONS = ['stories', 'sessions', 'images'];

  // Which Firebase project to talk to. The one in this file is the default; anything saved on the
  // "Manage database" screen overrides it, and stays on this device only.
  const CONFIG_KEY = 'interactive-stories:firebase-config';
  const CONFIG_FIELDS = [
    { key: 'projectId', label: 'Project ID', used: true },
    { key: 'apiKey', label: 'API key', used: true },
    { key: 'authDomain', label: 'Auth domain' },
    { key: 'storageBucket', label: 'Storage bucket' },
    { key: 'messagingSenderId', label: 'Messaging sender ID' },
    { key: 'appId', label: 'App ID' },
  ];

  function readConfig() {
    try {
      const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
      return saved ? { ...firebaseConfig, ...saved } : { ...firebaseConfig };
    } catch (error) {
      return { ...firebaseConfig };
    }
  }

  const usingDefaultConfig = () => {
    try {
      return !localStorage.getItem(CONFIG_KEY);
    } catch (error) {
      return true;
    }
  };

  /** Points the app at a project and starts listening to it. Used at startup and on every change. */
  function connectTo(config) {
    if (storiesWatch) storiesWatch();
    storiesWatch = null;
    activeConfig = config;
    loaded = false;
    state.stories = [];
    firestore = window.FirestoreRest({ projectId: config.projectId, apiKey: config.apiKey });
    db = firestore.initializeFirestore();
    listenForStories();
  }

  function saveConfig(values) {
    const config = { ...firebaseConfig, ...values };
    if (!config.projectId.trim() || !config.apiKey.trim()) {
      showNotice('A project ID and an API key are both needed to reach a database.');
      return;
    }
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(values));
    } catch (error) {
      showNotice('This browser wouldn’t save the settings, so the change lasts until you reload.', { keep: true });
    }
    connectTo(config);
    ui.databaseBody.replaceChildren(h('p', { class: 'report__empty' }, `Connecting to ${config.projectId}…`));
    refreshDatabase();
  }

  function resetConfig() {
    try {
      localStorage.removeItem(CONFIG_KEY);
    } catch (error) { /* nothing saved to begin with */ }
    ui.status.classList.remove('is-error');
    ui.statusReset.hidden = true;
    ui.statusText.textContent = 'Loading your stories…';
    connectTo({ ...firebaseConfig });
    if (!ui.database.hidden) refreshDatabase();
  }

  /** The project this app is pointed at, and the fields to point it somewhere else. */
  function connectionSection() {
    const inputs = new Map();
    const form = h('form', {
      class: 'db__config',
      onsubmit: (event) => {
        event.preventDefault();
        saveConfig(Object.fromEntries([...inputs].map(([key, input]) => [key, input.value.trim()])));
      },
    });

    for (const field of CONFIG_FIELDS) {
      const input = h('input', {
        class: 'field__input',
        type: 'text',
        autocomplete: 'off',
        spellcheck: 'false',
        id: `config-${field.key}`,
        value: activeConfig[field.key] || '',
      });
      inputs.set(field.key, input);
      form.append(h('label', { class: 'db__config-field' },
        h('span', { class: 'field__label' }, field.label,
          ...(field.used ? [h('span', { class: 'db__used' }, 'used')] : [])),
        input));
    }

    form.append(h('div', { class: 'db__config-actions' },
      h('button', { class: 'btn btn--primary btn--small', type: 'submit' }, 'Save and reconnect'),
      ...(usingDefaultConfig()
        ? []
        : [h('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: resetConfig }, 'Back to the built-in one')])));

    return h('section', { class: 'db__collection' },
      h('h3', { class: 'db__collection-name' }, 'Connection',
        h('span', { class: 'db__count' }, usingDefaultConfig() ? 'built into this app' : 'saved on this device')),
      h('p', { class: 'db__note' },
        'Only the project ID and API key are used to reach Firestore; the rest are kept so a whole '
        + 'firebaseConfig can live here. Changes apply straight away and stay in this browser.'),
      form);
  }

  function openDatabase() {
    ui.database.hidden = false;
    ui.noStory.hidden = true;
    ui.report.hidden = true;
    // The database is not about one story, so the story's own heading has no place above it.
    ui.gallery.hidden = true;
    ui.moreStories.hidden = true;
    ui.storyHeader.hidden = true;
    ui.chapterList.hidden = true;
    renderStoryList(); // no story is open now, so none should look it
    ui.firstChapterButton.hidden = true;
    ui.addChapterButton.hidden = true;
    ui.databaseBody.replaceChildren(h('p', { class: 'report__empty' }, 'Reading the database…'));
    animateIn(ui.database);
    ui.database.focus();
    updateWidgetFab();
    refreshDatabase();
  }

  function closeDatabase() {
    if (ui.database.hidden) return;
    ui.database.hidden = true;
    renderStoryList();
    renderEditor();
    updateWidgetFab();
  }

  // Reads can come back in a different order than they were asked for — switching projects starts a
  // second one while the first is still out — so only the newest is allowed to draw.
  let newestRead = 0;

  async function refreshDatabase() {
    const read = ++newestRead;
    try {
      const data = await firestore.inspect(COLLECTIONS);
      if (read !== newestRead || ui.database.hidden) return;
      ui.databaseBody.replaceChildren(databasePage(data));
    } catch (error) {
      if (read !== newestRead) return;
      ui.databaseBody.replaceChildren(h('p', { class: 'report__empty' }, `Couldn’t read the database. ${explain(error)}`));
    }
  }

  /** The whole database on one page: every collection, every document, every field. */
  function databasePage(data) {
    const documents = data.collections.reduce((total, one) => total + one.documents.length, 0);
    const bytes = data.collections.reduce((total, one) =>
      total + one.documents.reduce((sum, document) => sum + document.bytes, 0), 0);
    const unreadable = data.collections.filter((one) => one.error);

    return h('div', {},
      // Set like a story's own heading, and in its place, since it is this page's title.
      h('header', { class: 'story-header' },
        h('h1', { class: 'story-title' }, 'Database'),
        h('p', { class: 'story-meta' }, unreadable.length
          // An unreachable project must never be mistaken for an empty one.
          ? `${data.projectId} · couldn’t be read`
          : `${data.projectId} · ${plural(data.collections.length, 'collection')} · `
            + `${plural(documents, 'document')} · ${formatBytes(bytes)}`)),
      ...(unreadable.length ? [h('p', { class: 'db__error' },
        `Firestore wouldn’t answer for “${data.projectId}”. ${unreadable[0].error} `
        + 'Nothing has been deleted — check the project ID and API key below.')] : []),

      connectionSection(),

      h('p', { class: 'db__tools' },
        h('button', { class: 'btn btn--soft btn--small', type: 'button', onclick: refreshDatabase }, 'Refresh'),
        h('button', { class: 'btn btn--soft btn--small', type: 'button', onclick: () => downloadBackup(data) },
          'Download a copy')),

      ...data.collections.map((one) => h('section', { class: 'db__collection' },
        h('h3', { class: 'db__collection-name' },
          one.name,
          h('span', { class: 'db__count' }, one.error ? 'couldn’t be read' : plural(one.documents.length, 'document'))),
        one.error
          ? h('p', { class: 'db__error' }, one.error)
          : one.documents.length
          // Oldest first, so a refresh never reshuffles the list either.
          ? h('ul', { class: 'db__docs' }, ...[...one.documents]
            .sort((a, b) => (a.createTime < b.createTime ? -1 : a.createTime > b.createTime ? 1 : 0))
            .map((document) => documentCard(one.name, document)))
            : h('p', { class: 'report__empty' }, 'Empty.'))),

      h('section', { class: 'db__danger' },
        h('h3', { class: 'db__collection-name' }, 'Danger zone'),
        h('p', { class: 'db__note' },
          'Deleting everything empties both collections. A copy is saved to your downloads first.'),
        h('button', { class: 'btn btn--ghost report__delete', type: 'button', onclick: askToWipeDatabase },
          icon('trash'), 'Delete everything')));
  }

  /** One document: its id, when it was written, and its fields laid open. */
  function documentCard(collection, document) {
    return h('li', { class: 'db__doc' },
      h('div', { class: 'db__doc-head' },
        h('code', { class: 'db__id' }, document.id),
        h('span', { class: 'db__meta' },
          `${formatBytes(document.bytes)} · written ${new Date(document.updateTime).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`),
        h('button', {
          class: 'db__delete',
          type: 'button',
          title: 'Delete this document',
          'aria-label': `Delete ${collection}/${document.id}`,
          onclick: () => askToDeleteDocument(collection, document),
        }, icon('trash'))),
      fieldTree(document.fields));
  }

  /** Fields, nested as deeply as they go. Long text is shortened but its full length is shown. */
  function fieldTree(value) {
    if (value === null || value === undefined) return h('span', { class: 'db__null' }, 'null');
    if (typeof value === 'string') {
      const long = value.length > 160;
      return h('span', Object.assign({ class: 'db__string' }, long ? { title: value } : null),
        `“${truncate(value.replace(/\n+/g, ' ⏎ '), 160)}”`,
        ...(long ? [h('span', { class: 'db__len' }, ` ${plural(value.length, 'char')}`)] : []));
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return h('span', { class: 'db__number' }, String(value));
    }
    if (Array.isArray(value)) {
      if (!value.length) return h('span', { class: 'db__null' }, 'empty list');
      return h('ul', { class: 'db__fields' }, ...value.map((item, index) =>
        h('li', {}, h('span', { class: 'db__key' }, `${index}`), fieldTree(item))));
    }
    const keys = orderedKeys(value);
    if (!keys.length) return h('span', { class: 'db__null' }, 'empty');
    return h('ul', { class: 'db__fields' }, ...keys.map((key) =>
      h('li', {}, h('span', { class: 'db__key' }, key), fieldTree(value[key]))));
  }

  // Firestore hands back the fields of a map in a different order on every call, which made this
  // screen look like it was changing when nothing had. Put them in an order of our own instead.
  const STAMPS = ['createdAt', 'startedAt', 'answeredAt'];

  function orderedKeys(object) {
    const keys = Object.keys(object).sort();
    const isRecord = (key) => object[key] && typeof object[key] === 'object' && !Array.isArray(object[key]);
    // Chapters, widgets and answers are keyed by random id, so show them oldest first instead.
    const stamp = STAMPS.find((name) => keys.length > 1
      && keys.every((key) => isRecord(key) && Number.isFinite(Number(object[key][name]))));
    return stamp ? keys.sort((a, b) => Number(object[a][stamp]) - Number(object[b][stamp])) : keys;
  }

  const formatBytes = (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

  function askToDeleteDocument(collection, document) {
    askToConfirm({
      title: `Delete ${collection}/${document.id}?`,
      text: 'This removes the document and everything in it. This can’t be undone.',
      confirm: 'Delete document',
      then: async () => {
        try {
          await firestore.deleteDoc(firestore.doc(db, collection, document.id));
        } catch (error) {
          showNotice(`Couldn’t delete it. ${explain(error)}`, { keep: true });
        }
        refreshDatabase();
      },
    });
  }

  /**
   * Empties the database: every story and every reading report. A copy of all of it goes to the
   * browser's downloads first, because nothing here can be undone once it is gone.
   */
  async function wipeDatabase() {
    let sessions = [];
    let images = [];
    try {
      sessions = (await firestore.getDocs(firestore.collection(db, 'sessions'))).docs;
      images = (await firestore.getDocs(firestore.collection(db, 'images'))).docs;
    } catch (error) {
      showNotice(`Couldn’t read the whole database, so nothing was deleted. ${explain(error)}`, { keep: true });
      return;
    }

    downloadBackup({
      exportedAt: new Date().toISOString(),
      stories: state.stories,
      sessions: sessions.map((entry) => ({ id: entry.id, ...entry.data() })),
      images: images.map((entry) => ({ id: entry.id, ...entry.data() })),
    });

    const gone = [
      ...state.stories.map((story) => firestore.deleteDoc(storyRef(story.id))),
      ...sessions.map((entry) => firestore.deleteDoc(firestore.doc(db, 'sessions', entry.id))),
      ...images.map((entry) => firestore.deleteDoc(firestore.doc(db, 'images', entry.id))),
    ];
    imagesSeen.clear();
    state.stories = [];
    state.selectedId = null;
    rememberOpenStory();
    closeReport();
    render();
    try {
      await Promise.all(gone);
    } catch (error) {
      showNotice(`Some of it couldn’t be deleted. ${explain(error)}`, { keep: true });
    }
  }

  /** Hands the whole database to the browser as a file, so a wipe is never the end of it. */
  function downloadBackup(data) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = h('a', { href: url, download: `interactive-stories-backup-${stamp}.json` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function askToWipeDatabase() {
    const stories = state.stories.length;
    const words = state.stories.reduce((total, story) =>
      total + story.chapters.reduce((sum, chapter) => sum + countWords(chapter.content), 0), 0);
    askToConfirm({
      title: 'Delete everything?',
      text: `This deletes ${plural(stories, 'story')} — ${plural(words, 'word')} of writing — every `
        + 'reading report and every picture, for good. A copy is saved to your downloads first. '
        + 'This can’t be undone.',
      confirm: 'Delete everything',
      then: wipeDatabase,
    });
  }

  /** Removes a story. With no stories left, the welcome screen comes back. */
  function deleteStory(id) {
    const index = state.stories.findIndex((story) => story.id === id);
    if (index === -1) return; // already deleted, e.g. on another device
    const wasOpen = id === state.selectedId;
    // Where it sat in the sidebar, which holds only the stories on show.
    const row = openStories().findIndex((story) => story.id === id);
    // The pictures its widgets point at belong to nothing once the story is gone.
    for (const { widget } of storyWidgets(state.stories[index])) {
      if (widget.type === 'image') forgetImage(widget.imageId);
    }
    state.stories.splice(index, 1);
    save(firestore.deleteDoc(storyRef(id)));

    if (!state.stories.length) {
      render();
      return;
    }

    if (wasOpen) {
      // Open the story that took its place in the list, or the one above it. Never one put aside.
      const shown = openStories();
      state.selectedId = shown.length ? shown[Math.min(row, shown.length - 1)].id : null;
      rememberOpenStory();
      render();
    } else {
      renderStoryList();
    }

    // Keep keyboard focus in the list, where the deleted story was.
    const next = ui.storyList.children[Math.min(Math.max(row, 0), ui.storyList.children.length - 1)];
    if (next) next.firstElementChild.focus();
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  // The stories are asked for before anything below is wired up: whatever else goes wrong on the
  // page, it must never be the reason they don't arrive.
  start();

  // Entry screen: the 6-digit code is checked as soon as the last digit is typed.
  ui.codeInput.addEventListener('input', () => {
    ui.codeInput.value = ui.codeInput.value.replace(/\D/g, '').slice(0, 6);
    ui.codeCells.classList.remove('is-wrong');
    ui.codeMessage.textContent = '';
    updateCodeCells();
    if (ui.codeInput.value.length === 6) checkCode();
  });

  ui.codeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (ui.codeInput.value.length === 6) checkCode();
    else ui.codeMessage.textContent = 'Enter all 6 digits.';
  });

  // The digits are hidden behind dots, so new ones always go at the end.
  const caretToEnd = () => ui.codeInput.setSelectionRange(6, 6);
  ui.codeInput.addEventListener('focus', caretToEnd);
  ui.codeInput.addEventListener('click', caretToEnd);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !ui.widgetDrawer.hidden) closeWidgetDrawer();
  });

  ui.logout.addEventListener('click', logOut);
  ui.statusReset.addEventListener('click', resetConfig);
  ui.moreStoriesButton.addEventListener('click', openMoreStories);
  ui.galleryButton.addEventListener('click', openGallery);
  ui.manageButton.addEventListener('click', openDatabase);

  // Reading part
  ui.readerBack.addEventListener('click', closeReader);
  ui.readerMore.addEventListener('click', closeReader);

  // Writing part, first screen: "Create your big story"
  ui.welcomeInput.addEventListener('input', () => {
    ui.welcomeSubmit.disabled = !ui.welcomeInput.value.trim();
  });

  ui.welcomeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = ui.welcomeInput.value.trim();
    if (!name) return;

    ui.welcomeForm.reset();
    ui.welcomeSubmit.disabled = true;
    showStory(createStory(name).id);
    ui.firstChapterButton.focus();
  });

  // Sidebar: "New story"
  ui.newStoryButton.addEventListener('click', () => {
    ui.newStoryButton.hidden = true;
    ui.newStoryForm.hidden = false;
    ui.newStoryInput.focus();
  });

  ui.newStoryForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = ui.newStoryInput.value.trim();
    if (!name) {
      shake(ui.newStoryForm);
      return;
    }

    closeNewStoryForm();
    showStory(createStory(name).id);
    ui.firstChapterButton.focus();
  });

  ui.newStoryInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeNewStoryForm();
      ui.newStoryButton.focus();
    }
  });

  ui.newStoryInput.addEventListener('blur', () => {
    if (document.hasFocus() && !ui.newStoryInput.value.trim()) closeNewStoryForm();
  });

  // Chapters
  ui.firstChapterButton.addEventListener('click', startNewChapter);
  ui.addChapterButton.addEventListener('click', startNewChapter);

  // Widgets
  ui.addWidgetFab.addEventListener('click', startNewWidget);

  ui.widgetCountFab.addEventListener('click', toggleWidgetDrawer);
  ui.widgetDrawerClose.addEventListener('click', closeWidgetDrawer);
  ui.widgetDrawerClear.addEventListener('click', askToRemoveAllWidgets);

  ui.pickCancel.addEventListener('click', cancelLinePicking);

  ui.kindCancel.addEventListener('click', () => ui.kindDialog.close());
  ui.kindDialog.addEventListener('close', () => {
    const kind = WIDGET_TYPES.find((one) => one.type === ui.kindDialog.returnValue);
    if (!kind || !widgetDraft) {
      widgetDraft = null; // cancelled, or closed with Escape
      return;
    }
    widgetDraft.type = kind.type;
    widgetDraft.kindChosen = true;
    showWidgetDialog(widgetDraft);
  });

  ui.widgetImageFile.addEventListener('change', (event) => pickImage(event.target.files[0]));

  ui.widgetChangeLine.addEventListener('click', () => {
    if (!widgetDraft) return;
    captureDialogValues();
    ui.widgetDialog.close();
    startLinePicking(widgetDraft);
  });

  ui.widgetForm.addEventListener('submit', (event) => {
    if (event.submitter && event.submitter.value !== 'save') return; // Cancel just closes
    saveWidgetDialog(event);
  });

  ui.widgetDelete.addEventListener('click', () => {
    if (!widgetDraft || !widgetDraft.widget) return;
    removeWidget(widgetDraft.story, widgetDraft.chapter, widgetDraft.widget);
    widgetDraft = null;
    ui.widgetDialog.close();
    syncStory();
  });

  ui.popupClose.addEventListener('click', () => ui.widgetPopup.close());
  ui.widgetPopup.addEventListener('close', () => {
    const entry = openWidgetEntry;
    openWidgetEntry = null;
    // A picture that was uncovered: note it, and how long they looked before moving on.
    if (entry && entry.widget.type === 'image' && revealedAt) {
      recordReveal(entry.chapter, entry.widget, Math.round((Date.now() - revealedAt) / 1000));
    }
    revealedAt = 0;
    showNextWidget(); // any widget that came up while this one was open
  });

  // Reading report
  ui.reportButton.addEventListener('click', openReport);
  ui.reportBack.addEventListener('click', () => (reportSession ? showReportList() : closeReport()));

  // Delete confirmation
  ui.confirmDialog.addEventListener('close', () => {
    const go = confirmed;
    confirmed = null;
    if (ui.confirmDialog.returnValue === 'delete' && go) go();
  });

  // A click on the dialog element itself (not its form) is a click on the dimmed backdrop: cancel.
  ui.confirmDialog.addEventListener('click', (event) => {
    if (event.target === ui.confirmDialog) ui.confirmDialog.close();
  });

  ui.noticeClose.addEventListener('click', hideNotice);

  // Widgets pop up as the reader scrolls their spot into the top third of the screen.
  window.addEventListener('scroll', onReaderScroll, { passive: true });
  window.addEventListener('resize', onReaderScroll);

  // Chapter text boxes depend on the page width and the web font, so re-fit them when either changes.
  const refitTextareas = () => ui.chapterList.querySelectorAll('textarea').forEach(autosize);
  let resizeFrame = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(refitTextareas);
  });
  if (document.fonts) {
    document.fonts.ready.then(refitTextareas);
    document.fonts.addEventListener('loadingdone', refitTextareas);
  }

  // Don't lose the last few keystrokes when the tab is closed or hidden.
  window.addEventListener('pagehide', saveTyping);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveTyping();
  });

  // The entry screen shows first; the stories load in the background meanwhile. Unless the last
  // visit ended without logging out, in which case carry straight on where it left off.
  updateCodeCells();
  const reopen = readOpenPart();
  if (reopen) openPart(reopen);
  else ui.codeInput.focus();
})();
