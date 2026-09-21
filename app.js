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

  // The Firebase SDK is loaded straight from Google's CDN, so there's no npm install or build step.
  const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/12.19.0';

  // Which story was open last is a per-device preference, so it stays in this browser.
  const OPEN_STORY_KEY = 'interactive-stories:open-story';

  // The entry codes and the part of the app each one opens. Anyone can read them in this file,
  // so they only choose a part of the app; Firestore's security rules are what protect the stories.
  const CODES = { '272610': 'read', '101129': 'write' };

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  // Local copy of the "stories" collection (with chapters as a sorted array), kept current by a
  // Firestore listener. Changes show up here at once and are written to Firestore in the background.
  const state = { stories: [], selectedId: readOpenStory() };

  let firestore = null; // the Firestore SDK functions, once loaded
  let db = null;
  let loaded = false; // whether the first batch of stories has arrived
  let part = null; // the part of the app the code opened: 'read' or 'write' (null on the entry screen)
  let readingId = null; // the story open in the reader

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const currentStory = () => state.stories.find((story) => story.id === state.selectedId);
  const byCreation = (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1);
  const storyRef = (id) => firestore.doc(db, 'stories', id);

  const countWords = (text) => (text.match(/\S+/g) || []).length;
  const plural = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
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

  /** The open story is the one remembered from last time, or the first one if that is gone. */
  function ensureSelection() {
    if (currentStory()) return;
    state.selectedId = state.stories.length ? state.stories[0].id : null;
    rememberOpenStory();
  }

  // --- Writing to Firestore ----------------------------------------------------

  /** Firestore applies a write locally straight away; if the server rejects it, say so. */
  function save(write) {
    write.catch((error) => showNotice(`Couldn’t save your changes. ${explain(error)}`));
  }

  function createStory(name) {
    const ref = firestore.doc(firestore.collection(db, 'stories')); // a new id, generated locally
    const story = { id: ref.id, name, createdAt: Date.now(), chapters: [] };
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
    chapter.widgets = chapter.widgets.filter((candidate) => candidate.id !== widget.id);
    save(firestore.updateDoc(
      storyRef(story.id),
      new firestore.FieldPath('chapters', chapter.id, 'widgets', widget.id),
      firestore.deleteField()
    ));
  }

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
      const [{ initializeApp }, sdk] = await Promise.all([
        import(`${FIREBASE_SDK}/firebase-app.js`),
        import(`${FIREBASE_SDK}/firebase-firestore.js`),
      ]);
      firestore = sdk;
      db = firestore.initializeFirestore(initializeApp(firebaseConfig), {
        // A copy kept in the browser makes the app open fast and keep working offline.
        localCache: firestore.persistentLocalCache({ tabManager: firestore.persistentMultipleTabManager() }),
      });
    } catch (error) {
      console.error(error);
      showStatus('Couldn’t load Firebase. Check your internet connection and reload the page.');
      return;
    }

    firestore.onSnapshot(firestore.collection(db, 'stories'), applySnapshot, (error) => {
      console.error(error);
      if (loaded) showNotice(`Your stories stopped syncing. ${explain(error)} Reload the page to try again.`);
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
    let changed = story.name !== latest.name;
    story.name = latest.name;
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
    pickBar: $('pick-bar'),
    pickCancel: $('pick-cancel'),
    rowHighlight: $('row-highlight'),
    widgetDialog: $('widget-dialog'),
    widgetForm: $('widget-form'),
    widgetDialogTitle: $('widget-dialog-title'),
    widgetQuestion: $('widget-question'),
    widgetWhere: $('widget-where'),
    widgetChangeLine: $('widget-change-line'),
    widgetLabels: $('widget-labels'),
    widgetError: $('widget-error'),
    widgetDelete: $('widget-delete'),
    widgetPopup: $('widget-popup'),
    popupQuestion: $('widget-popup-question'),
    popupLabel: $('widget-popup-label'),
    popupScale: $('widget-popup-scale'),
    popupClose: $('widget-popup-close'),
    deleteDialog: $('delete-dialog'),
    deleteTitle: $('delete-dialog-title'),
    deleteText: $('delete-dialog-text'),
    deleteConfirm: $('delete-dialog-confirm'),
    notice: $('notice'),
    noticeText: $('notice-text'),
    noticeClose: $('notice-close'),
    logout: $('logout'),
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
    const hasStories = state.stories.length > 0;
    ui.status.hidden = true;
    ui.welcome.hidden = hasStories;
    ui.workspace.hidden = !hasStories;

    if (hasStories) {
      renderStoryList();
      renderStory();
    } else {
      document.title = APP_NAME;
      closeNewStoryForm();
      ui.welcomeInput.focus();
    }
  }

  /** Replaces everything with an error, when the stories can't be loaded at all. */
  function showStatus(message) {
    for (const screen of [ui.gate, ui.welcome, ui.workspace, ui.reader]) screen.hidden = true;
    ui.status.hidden = false;
    ui.status.classList.add('is-error');
    ui.statusText.textContent = message;
  }

  function showNotice(message) {
    ui.noticeText.textContent = message;
    ui.notice.hidden = false;
  }

  /** Updates the sidebar in place, so a click on it is never lost to a re-render. */
  function renderStoryList() {
    const items = new Map([...ui.storyList.children].map((item) => [item.dataset.id, item]));

    state.stories.forEach((story, index) => {
      let item = items.get(story.id);
      if (item) {
        items.delete(story.id);
      } else {
        item = h('li', { 'data-id': story.id },
          h('button', { class: 'story-link', type: 'button', onclick: () => selectStory(story.id) },
            h('span', { class: 'story-link__name' }),
            h('span', { class: 'story-link__meta' })),
          h('button', { class: 'story-delete', type: 'button', title: 'Delete story', onclick: () => askToDeleteStory(story.id) },
            icon('trash')));
      }

      const [link, deleteButton] = item.children;
      link.title = story.name;
      link.children[0].textContent = story.name;
      link.children[1].textContent = chapterCount(story);
      deleteButton.setAttribute('aria-label', `Delete “${story.name}”`);
      if (story.id === state.selectedId) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');

      if (ui.storyList.children[index] !== item) {
        ui.storyList.insertBefore(item, ui.storyList.children[index] || null);
      }
    });

    items.forEach((item) => item.remove());
  }

  /** Shows the open story from scratch (after switching stories). */
  function renderStory() {
    draftChapter = null;
    closeReport();
    ui.chapterList.replaceChildren();
    syncStory();
  }

  /** Brings the open story on screen up to date without disturbing anything being edited. */
  function syncStory() {
    const story = currentStory();
    document.title = `${story.name} · ${APP_NAME}`;
    ui.storyTitle.textContent = story.name;
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
    ui.firstChapterButton.hidden = hasChapters || draftChapter !== null || picking;
    ui.addChapterButton.hidden = !hasChapters || draftChapter !== null || picking;
  }

  function updateMeta(story = currentStory()) {
    if (!story) return; // e.g. a late save after the last story was deleted
    ui.storyMeta.textContent = storySummary(story);
  }

  /** One chapter card: its number, its title (click to rename) and its content. */
  function chapterItem(story, chapter) {
    const head = h('div', { class: 'chapter__head' });
    const body = h('div', { class: 'chapter__body' });
    const widgets = h('div', { class: 'chapter__widgets' });
    const item = h('li', { class: 'chapter', 'data-id': chapter.id }, head, body, widgets);

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

    /** The widgets attached to this chapter's lines, and the button that adds another. */
    function showWidgets() {
      const rows = chapter.widgets.map((widget) => {
        const snippet = widgetSnippet(chapter, widget);
        return h('li', { class: 'widget-row' },
          h('button', { class: 'widget-row__open', type: 'button', onclick: () => editWidget(story, chapter, widget) },
            h('span', { class: 'widget-row__question' }, widget.question || 'Untitled question'),
            h('span', { class: 'widget-row__where' }, snippet
              ? `Pops up at: ${snippet}`
              : 'Its text is gone from the chapter: open it to pick a new spot')),
          h('button', {
            class: 'widget-row__remove',
            type: 'button',
            title: 'Remove widget',
            'aria-label': `Remove the widget “${widget.question}”`,
            onclick: () => {
              removeWidget(story, chapter, widget);
              showWidgets();
            },
          }, icon('trash')));
      });

      widgets.replaceChildren(...(rows.length ? [h('ul', { class: 'widget-list' }, ...rows)] : []));
    }

    /** Shows the chapter's current number, title and text, e.g. after a change on another device. */
    item.sync = (position) => {
      number = position; // still used to tell screen readers which chapter a field belongs to
      showWidgets();
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
    showWidgets();
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
          mark.onclick ? { title: `Edit the widget “${mark.widget.question}”`, onclick: mark.onclick } : null)));
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

  // ---------------------------------------------------------------------------
  // Widgets: the backend form
  // ---------------------------------------------------------------------------

  // The widget being added or edited: { story, chapter, widget, line, question, labels }.
  let widgetDraft = null;
  let picking = false; // the writer is clicking a line in the chapters

  /** The floating button is there whenever a story is open for writing. */
  function updateWidgetFab() {
    ui.addWidgetFab.hidden = !(part === 'write' && currentStory() && !picking && ui.report.hidden);
  }

  /** Step one: the chapters turn into clickable lines. */
  function startLinePicking(draft) {
    saveTyping(); // the preview replaces the text boxes, so send anything just typed
    widgetDraft = draft;
    picking = true;
    ui.pickBar.hidden = false;
    keepingScroll(syncStory); // syncStory, not renderStory: the writer stays where they were reading
  }

  function endLinePicking() {
    picking = false;
    ui.pickBar.hidden = true;
    keepingScroll(syncStory);
  }

  function cancelLinePicking() {
    const draft = widgetDraft;
    endLinePicking();
    // Keep whatever was already typed if this was a change of line rather than a new widget.
    if (draft && (draft.widget || draft.question)) showWidgetDialog(draft);
    else widgetDraft = null;
  }

  function chooseSpot(chapter, offset) {
    if (!widgetDraft) return;
    widgetDraft.chapter = chapter;
    widgetDraft.offset = offset;
    endLinePicking();
    showWidgetDialog(widgetDraft);
  }

  /** Step two: the question and the ten labels. */
  function showWidgetDialog(draft) {
    widgetDraft = draft;
    const from = draft.chapter.content.slice(draft.offset, draft.offset + 110).replace(/\n+/g, ' ');
    ui.widgetDialogTitle.textContent = draft.widget ? 'Edit widget' : 'Add a widget';
    ui.widgetQuestion.value = draft.question || '';
    ui.widgetWhere.textContent = `${draft.chapter.title} · “${truncate(from, 90)}”`;
    ui.widgetLabels.replaceChildren(...Array.from({ length: 10 }, (unused, index) =>
      h('label', { class: 'labels__option' },
        h('span', { class: 'labels__number' }, String(index + 1)),
        h('input', {
          class: 'field__input',
          type: 'text',
          maxlength: '60',
          autocomplete: 'off',
          'aria-label': `Label for ${index + 1}`,
          value: (draft.labels && draft.labels[index]) || '',
        }))));
    ui.widgetDelete.hidden = !draft.widget;
    ui.widgetError.textContent = '';
    ui.widgetDialog.returnValue = '';
    ui.widgetDialog.showModal();
    ui.widgetQuestion.focus();
  }

  /** Opens the form for a widget that already exists, from its row in the chapter. */
  function editWidget(story, chapter, widget) {
    const offset = widgetOffset(chapter, widget);
    const draft = { story, chapter, widget, offset, question: widget.question, labels: [...widget.labels] };
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
    widgetDraft.labels = [...ui.widgetLabels.querySelectorAll('input')].map((input) => input.value);
  }

  /** Saves the form. Returning without preventDefault lets the dialog close. */
  function saveWidgetDialog(event) {
    if (!widgetDraft) return;
    captureDialogValues();
    const { story, chapter, widget, offset } = widgetDraft;
    const question = widgetDraft.question.trim();

    if (!question) {
      event.preventDefault(); // keep the form open
      ui.widgetError.textContent = 'Give the widget a question.';
      return;
    }

    // A widget can be moved to a spot in another chapter, so drop it from the old one first.
    const from = widget && story.chapters.find((candidate) => candidate.widgets.some((each) => each.id === widget.id));
    if (from && from !== chapter) removeWidget(story, from, widget);

    saveWidget(story, chapter, {
      id: widget ? widget.id : newId(),
      type: 'scale',
      offset,
      anchor: chapter.content.slice(offset, offset + 80), // keeps the spot when text above it changes
      question,
      labels: widgetDraft.labels.map((label) => label.trim()),
      createdAt: widget ? widget.createdAt : Date.now(),
    });
    widgetDraft = null;
    syncStory();
  }

  // ---------------------------------------------------------------------------
  // Widgets: popping up while reading
  // ---------------------------------------------------------------------------

  let watchedSpots = [];
  const widgetQueue = [];
  const widgetsShown = new Set();
  let openWidgetEntry = null;
  let scrollFrame = 0;

  /** Collects the markers sitting at each widget's spot in the text that is on screen. */
  function watchWidgets(story) {
    watchedSpots = [];
    for (const chapter of story.chapters) {
      for (const widget of chapter.widgets) {
        if (!widget.question) continue;
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
    ui.popupQuestion.textContent = widget.question;
    ui.popupLabel.textContent = '';
    ui.popupLabel.hidden = true;
    ui.popupScale.replaceChildren(...Array.from({ length: 10 }, (unused, index) =>
      h('button', {
        class: 'scale__number',
        type: 'button',
        'aria-pressed': 'false',
        onclick: () => pickWidgetAnswer(chapter, widget, index + 1),
      }, String(index + 1))));
    ui.widgetPopup.showModal();
  }

  function pickWidgetAnswer(chapter, widget, value) {
    const label = widget.labels[value - 1] || '';
    ui.popupLabel.textContent = label;
    ui.popupLabel.hidden = !label;
    [...ui.popupScale.children].forEach((button, index) => {
      button.classList.toggle('is-picked', index === value - 1);
      button.setAttribute('aria-pressed', String(index === value - 1));
    });
    recordAnswer(chapter, widget, value, label);
  }

  // ---------------------------------------------------------------------------
  // Reading report
  // ---------------------------------------------------------------------------

  let reportWatch = null;
  let reportSessions = [];
  let reportSession = null; // the session being looked at, if any

  const storyWidgets = (story) => story.chapters.flatMap((chapter) => chapter.widgets.map((widget) => ({ chapter, widget })));
  const answerCount = (session) => Object.keys(session.answers ?? {}).length;

  function openReport() {
    const story = currentStory();
    if (!story) return;

    reportSession = null;
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
    ui.chapterList.hidden = false;
    reportSession = null;
    const story = currentStory();
    if (!story) return;
    updateChapterButtons(story);
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
    const questions = storyWidgets(story).length;
    const answered = reportSessions.filter((session) => answerCount(session) > 0);

    return h('div', {},
      h('h2', { class: 'report__heading' }, 'Reading reports'),
      h('p', { class: 'report__summary' },
        `${plural(reportSessions.length, 'reading session')} · ${answered.length} with answers`),
      reportSessions.length
        ? h('ul', { class: 'report__session-list' }, ...reportSessions.map((session) =>
          h('li', {},
            h('button', { class: 'report__session', type: 'button', onclick: () => showReportSession(session.id) },
              h('span', { class: 'report__when' }, timeAgo(Number(session.startedAt) || 0)),
              h('span', { class: 'report__answers' }, questions
                ? `${answerCount(session)} of ${plural(questions, 'question')} answered`
                : plural(answerCount(session), 'answer')),
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
    const started = Number(session.startedAt) || 0;

    return h('div', {},
      h('h2', { class: 'report__heading' }, sessionWhen(session)),
      h('p', { class: 'report__summary' },
        `${timeAgo(started)} · ${answerCount(session)} of ${plural(widgets.length, 'question')} answered`),

      h('section', { class: 'report__reading' },
        h('h3', { class: 'report__heading' }, 'Summary'),
        ...summarise(story, session).map((line) => h('p', { class: 'report__line' }, line))),

      widgets.length
        ? h('ul', { class: 'report__answer-list' }, ...widgets.map(({ chapter, widget }) => {
          const answer = (session.answers ?? {})[widget.id];
          return h('li', { class: 'report__answer' },
            h('span', { class: 'report__answer-text' },
              h('span', { class: 'report__question' }, widget.question),
              h('span', { class: 'report__chapter' }, chapter.title)),
            answer
              ? h('span', { class: 'report__value' }, `${answer.value}${answer.label ? ` · ${answer.label}` : ''}`)
              : h('span', { class: 'report__value report__value--none' }, 'Not answered'));
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
    const widgets = storyWidgets(story);
    if (!widgets.length) return ['This story has no widgets yet, so there was nothing to answer.'];

    const answers = (session.answers ?? {});
    const answered = widgets
      .map((entry) => ({ ...entry, answer: answers[entry.widget.id] }))
      .filter((entry) => entry.answer && Number(entry.answer.value) >= 1);
    if (!answered.length) return ['They opened the story but didn’t answer any of the questions.'];

    const values = answered.map((entry) => Number(entry.answer.value));
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    const named = (entry) => `“${truncate(entry.widget.question, 60)}” at ${entry.answer.value}`
      + (entry.answer.label ? ` (${entry.answer.label})` : '');
    const lines = [`They answered ${answered.length} of ${plural(widgets.length, 'question')}, averaging ${average.toFixed(1)} out of 10.`];

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

    const lastAnswered = widgets.reduce((last, entry, index) => (answers[entry.widget.id] ? index : last), -1);
    if (lastAnswered > -1 && lastAnswered < widgets.length - 1) {
      lines.push(`They stopped after “${truncate(widgets[lastAnswered].widget.question, 60)}”, `
        + `leaving ${plural(widgets.length - lastAnswered - 1, 'question')} untouched.`);
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
    readingId = null;
    picking = false;
    widgetDraft = null;
    ui.pickBar.hidden = true;
    ui.addWidgetFab.hidden = true;
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
    state.selectedId = id;
    rememberOpenStory();
    render();
    window.scrollTo(0, 0);
    animateIn(ui.editor);
  }

  function selectStory(id) {
    if (id !== state.selectedId) showStory(id);
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

  // What to do if the user confirms the deletion they were asked about.
  let deleteConfirmed = null;

  /** Asks before deleting something that can't be brought back. */
  function askToDelete({ title, text, confirm, then }) {
    deleteConfirmed = then;
    ui.deleteTitle.textContent = title;
    ui.deleteText.textContent = text;
    ui.deleteConfirm.textContent = confirm;
    ui.deleteDialog.returnValue = ''; // closing with Escape keeps the old value, so clear it
    ui.deleteDialog.showModal();
  }

  function askToDeleteStory(id) {
    const story = state.stories.find((candidate) => candidate.id === id);
    const chapters = story.chapters.length;
    askToDelete({
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
    askToDelete({
      title: started ? `Delete the report from ${sessionWhen(session)}?` : 'Delete this reading report?',
      text: answers
        ? `Its ${plural(answers, 'answer')} will be deleted too. This can’t be undone.`
        : 'This can’t be undone.',
      confirm: 'Delete report',
      then: () => deleteSession(session.id),
    });
  }

  /** Removes a story. With no stories left, the welcome screen comes back. */
  function deleteStory(id) {
    const index = state.stories.findIndex((story) => story.id === id);
    if (index === -1) return; // already deleted, e.g. on another device
    state.stories.splice(index, 1);
    save(firestore.deleteDoc(storyRef(id)));

    if (!state.stories.length) {
      render();
      return;
    }

    if (id === state.selectedId) {
      // Open the story that moved into its place (or the one above it).
      showStory((state.stories[index] || state.stories[index - 1]).id);
    } else {
      renderStoryList();
    }
    // Keep keyboard focus in the list, where the deleted story was.
    ui.storyList.children[Math.min(index, state.stories.length - 1)].firstElementChild.focus();
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

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

  ui.logout.addEventListener('click', logOut);

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
  ui.addWidgetFab.addEventListener('click', () => {
    const story = currentStory();
    if (!story) return;
    if (!story.chapters.some((chapter) => contentLines(chapter.content).length)) {
      showNotice('Write some text in a chapter first, then pick the line where the widget appears.');
      return;
    }
    startLinePicking({ story, chapter: null, widget: null, line: 0, question: '', labels: [] });
  });

  ui.pickCancel.addEventListener('click', cancelLinePicking);

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
    openWidgetEntry = null;
    showNextWidget(); // any widget that came up while this one was open
  });

  // Reading report
  ui.reportButton.addEventListener('click', openReport);
  ui.reportBack.addEventListener('click', () => (reportSession ? showReportList() : closeReport()));

  // Delete confirmation
  ui.deleteDialog.addEventListener('close', () => {
    const confirmed = deleteConfirmed;
    deleteConfirmed = null;
    if (ui.deleteDialog.returnValue === 'delete' && confirmed) confirmed();
  });

  // A click on the dialog element itself (not its form) is a click on the dimmed backdrop: cancel.
  ui.deleteDialog.addEventListener('click', (event) => {
    if (event.target === ui.deleteDialog) ui.deleteDialog.close();
  });

  ui.noticeClose.addEventListener('click', () => {
    ui.notice.hidden = true;
  });

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

  // The entry screen shows first; the stories load in the background meanwhile.
  updateCodeCells();
  ui.codeInput.focus();
  start();
})();
