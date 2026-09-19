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

  function readOpenStory() {
    try {
      return localStorage.getItem(OPEN_STORY_KEY);
    } catch (error) {
      return null; // storage is blocked: the first story opens instead
    }
  }

  function rememberOpenStory() {
    try {
      localStorage.setItem(OPEN_STORY_KEY, state.selectedId);
    } catch (error) {
      // Not remembering the open story is harmless.
    }
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
    const chapter = { id: newId(), title, content: '', createdAt: Date.now() };
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
      if (!currentStory() && state.stories.length) state.selectedId = state.stories[0].id;
      showPart();
      return;
    }
    if (!changed) return; // only this device's own writes, which are already on screen
    if (part === 'read') renderReadPart();
    if (part !== 'write') return;

    if (!state.stories.length) {
      render(); // every story was deleted elsewhere: back to the welcome screen
    } else if (!currentStory()) {
      // The open story was deleted elsewhere (or these are the first stories): open the nearest one.
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
    deleteDialog: $('delete-dialog'),
    deleteTitle: $('delete-dialog-title'),
    deleteText: $('delete-dialog-text'),
    notice: $('notice'),
    noticeText: $('notice-text'),
    noticeClose: $('notice-close'),
  };

  // The <li> of a chapter whose title is being typed but hasn't been saved yet.
  let draftChapter = null;

  function render() {
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
    ui.firstChapterButton.hidden = hasChapters || draftChapter !== null;
    ui.addChapterButton.hidden = !hasChapters || draftChapter !== null;
  }

  function updateMeta(story = currentStory()) {
    if (!story) return; // e.g. a late save after the last story was deleted
    ui.storyMeta.textContent = storySummary(story);
  }

  /** One chapter card: its number, its title (click to rename) and its content. */
  function chapterItem(story, chapter) {
    const label = h('p', { class: 'chapter__label' });
    const head = h('div', { class: 'chapter__head' });
    const body = h('div', { class: 'chapter__body' });
    const item = h('li', { class: 'chapter', 'data-id': chapter.id }, label, head, body);

    let number = 0;
    let titleText = null; // the title's text node (null while the title is being renamed)
    let textarea = null; // the content box, once there is content or it is being written

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
      body.replaceChildren(
        h('button', { class: 'btn btn--soft chapter__add-content', type: 'button', onclick: () => showContent(true) },
          icon('pen'), 'Add chapter content'));
    }

    function showContent(focus) {
      textarea = h('textarea', {
        class: 'chapter__content',
        rows: '3',
        placeholder: 'Start writing…',
        'aria-label': `Chapter ${number} content`,
        value: chapter.content,
        oninput: () => {
          chapter.content = textarea.value;
          autosize(textarea);
          contentChanged(story, chapter);
        },
      });
      body.replaceChildren(textarea);
      if (item.isConnected) autosize(textarea);
      if (focus) textarea.focus();
    }

    /** Shows the chapter's current number, title and text, e.g. after a change on another device. */
    item.sync = (position) => {
      number = position;
      label.textContent = `Chapter ${number}`;
      if (titleText && titleText.data !== chapter.title) titleText.data = chapter.title;
      if (!textarea && chapter.content) showContent(false);
      if (!textarea) return;

      textarea.setAttribute('aria-label', `Chapter ${number} content`);
      if (textarea.value !== chapter.content && !unsaved.has(chapter.id)) {
        const { selectionStart, selectionEnd } = textarea;
        textarea.value = chapter.content;
        if (document.activeElement === textarea) textarea.setSelectionRange(selectionStart, selectionEnd);
      }
      autosize(textarea);
    };

    showTitle();
    if (chapter.content) showContent(false);
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
    readingId = id;
    renderReader();
    window.scrollTo(0, 0);
    animateIn(ui.readerInner);
    ui.readerTitle.focus();
  }

  function renderReader() {
    const story = state.stories.find((candidate) => candidate.id === readingId);
    document.title = `${story.name} · ${APP_NAME}`;
    ui.gate.hidden = true;
    ui.reader.hidden = false;
    ui.readerTitle.textContent = story.name;
    ui.readerMeta.textContent = storySummary(story);
    ui.readerChapters.replaceChildren(...story.chapters.map((chapter, index) =>
      h('section', { class: 'reader__chapter' },
        h('p', { class: 'chapter__label' }, `Chapter ${index + 1}`),
        h('h2', { class: 'reader__chapter-title' }, chapter.title),
        chapter.content.trim()
          ? h('div', { class: 'reader__text' }, chapter.content)
          : h('p', { class: 'reader__empty' }, 'This chapter has no text yet.'))));
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
      h('p', { class: 'chapter__label' }, `Chapter ${story.chapters.length + 1}`),
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

  // The story waiting for the user to confirm its deletion.
  let storyToDelete = null;

  function askToDeleteStory(id) {
    storyToDelete = state.stories.find((story) => story.id === id);
    const chapters = storyToDelete.chapters.length;
    ui.deleteTitle.textContent = `Delete “${storyToDelete.name}”?`;
    ui.deleteText.textContent = chapters
      ? `Its ${plural(chapters, 'chapter')} will be deleted too. This can’t be undone.`
      : 'This can’t be undone.';
    ui.deleteDialog.returnValue = ''; // closing with Escape keeps the old value, so clear it
    ui.deleteDialog.showModal();
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

  // Delete confirmation
  ui.deleteDialog.addEventListener('close', () => {
    if (ui.deleteDialog.returnValue === 'delete') deleteStory(storyToDelete.id);
    storyToDelete = null;
  });

  // A click on the dialog element itself (not its form) is a click on the dimmed backdrop: cancel.
  ui.deleteDialog.addEventListener('click', (event) => {
    if (event.target === ui.deleteDialog) ui.deleteDialog.close();
  });

  ui.noticeClose.addEventListener('click', () => {
    ui.notice.hidden = true;
  });

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
