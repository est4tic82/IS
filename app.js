/*
 * Story Studio: plain JavaScript, no frameworks.
 *
 * Everything lives in one `state` object that is saved to localStorage:
 *   {
 *     selectedId: "…",
 *     stories: [{ id, name, createdAt, chapters: [{ id, title, content }] }]
 *   }
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'story-studio';

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  const state = loadState();

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && Array.isArray(saved.stories)) {
        if (!saved.stories.some((story) => story.id === saved.selectedId)) {
          saved.selectedId = saved.stories.length ? saved.stories[0].id : null;
        }
        return saved;
      }
    } catch (error) {
      console.warn('Could not read saved stories.', error);
    }
    return { selectedId: null, stories: [] };
  }

  function saveNow() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      console.warn('Could not save stories.', error);
    }
  }

  // While writing a chapter, save (and refresh the word count) once typing pauses.
  let typingTimer = 0;
  function saveAfterTyping() {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      saveNow();
      updateMeta();
    }, 400);
  }

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const currentStory = () => state.stories.find((story) => story.id === state.selectedId);

  function createStory(name) {
    const story = { id: newId(), name, createdAt: Date.now(), chapters: [] };
    state.stories.push(story);
    return story;
  }

  const countWords = (text) => (text.match(/\S+/g) || []).length;
  const plural = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
  const chapterCount = (story) =>
    story.chapters.length ? plural(story.chapters.length, 'chapter') : 'No chapters yet';

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

  function penIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = '<path d="M4 20l1-4L16 5a2.1 2.1 0 0 1 3 3L8 19l-4 1Z"/><path d="m14 7 3 3"/>';
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

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  const ui = {
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
  };

  // The <li> of a chapter whose title is being typed but hasn't been saved yet.
  let draftChapter = null;

  function render() {
    const hasStories = state.stories.length > 0;
    ui.welcome.hidden = hasStories;
    ui.workspace.hidden = !hasStories;

    if (hasStories) {
      renderStoryList();
      renderStory();
    } else {
      ui.welcomeInput.focus();
    }
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
            h('span', { class: 'story-link__meta' })));
      }

      const button = item.firstElementChild;
      button.title = story.name;
      button.children[0].textContent = story.name;
      button.children[1].textContent = chapterCount(story);
      if (story.id === state.selectedId) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');

      if (ui.storyList.children[index] !== item) {
        ui.storyList.insertBefore(item, ui.storyList.children[index] || null);
      }
    });

    items.forEach((item) => item.remove());
  }

  function renderStory() {
    const story = currentStory();
    draftChapter = null;

    document.title = `${story.name} · Story Studio`;
    ui.storyTitle.textContent = story.name;
    ui.chapterList.replaceChildren(
      ...story.chapters.map((chapter, index) => chapterItem(story, chapter, index + 1))
    );
    ui.chapterList.querySelectorAll('textarea').forEach(autosize);
    updateChapterButtons(story);
    updateMeta(story);
  }

  /** "Add your first chapter" while there are none, "Add a new chapter" after that. */
  function updateChapterButtons(story) {
    const hasChapters = story.chapters.length > 0;
    ui.firstChapterButton.hidden = hasChapters || draftChapter !== null;
    ui.addChapterButton.hidden = !hasChapters || draftChapter !== null;
  }

  function updateMeta(story = currentStory()) {
    const words = story.chapters.reduce((sum, chapter) => sum + countWords(chapter.content), 0);
    ui.storyMeta.textContent = words
      ? `${chapterCount(story)} · ${plural(words, 'word')}`
      : chapterCount(story);
  }

  /** One chapter card: its number, its title (click to rename) and its content. */
  function chapterItem(story, chapter, number) {
    const head = h('div', { class: 'chapter__head' });
    const body = h('div', { class: 'chapter__body' });

    function showTitle() {
      head.replaceChildren(
        h('h2', { class: 'chapter__title' },
          h('button', { class: 'chapter__title-btn', type: 'button', title: 'Rename chapter', onclick: renameTitle },
            chapter.title, penIcon())));
    }

    function renameTitle() {
      const input = titleInput(chapter.title, `Chapter ${number} title`);
      head.replaceChildren(input);
      input.focus();
      input.select();

      whenTitleDone(input, (title, byKeyboard) => {
        if (title) {
          chapter.title = title;
          saveNow();
        }
        showTitle();
        if (byKeyboard) head.querySelector('button').focus();
      });
    }

    function showAddContentButton() {
      body.replaceChildren(
        h('button', { class: 'btn btn--soft chapter__add-content', type: 'button', onclick: () => showContent(true) },
          penIcon(), 'Add chapter content'));
    }

    function showContent(focus) {
      const textarea = h('textarea', {
        class: 'chapter__content',
        rows: '3',
        placeholder: 'Start writing…',
        'aria-label': `Chapter ${number} content`,
        value: chapter.content,
        oninput: () => {
          chapter.content = textarea.value;
          autosize(textarea);
          saveAfterTyping();
        },
      });
      body.replaceChildren(textarea);
      if (focus) {
        autosize(textarea);
        textarea.focus();
      }
    }

    showTitle();
    if (chapter.content) showContent(false);
    else showAddContentButton();

    return h('li', { class: 'chapter' },
      h('p', { class: 'chapter__label' }, `Chapter ${number}`),
      head,
      body);
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
  // Actions
  // ---------------------------------------------------------------------------

  /** Selects a story and shows it on the right. */
  function showStory(id) {
    state.selectedId = id;
    saveNow();
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
    const number = story.chapters.length + 1;
    const input = titleInput('', `Chapter ${number} title`);
    const draft = h('li', { class: 'chapter chapter--draft' },
      h('p', { class: 'chapter__label' }, `Chapter ${number}`),
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
      let nextFocus = null;

      if (title) {
        const chapter = { id: newId(), title, content: '' };
        story.chapters.push(chapter);
        saveNow();
        const item = chapterItem(story, chapter, number);
        draft.replaceWith(item);
        nextFocus = item.querySelector('.chapter__add-content');
      } else {
        draft.remove();
      }

      updateChapterButtons(story);
      updateMeta(story);
      renderStoryList(); // refreshes the chapter count in the sidebar
      if (byKeyboard) {
        (nextFocus || (story.chapters.length ? ui.addChapterButton : ui.firstChapterButton)).focus();
      }
    });
  }

  function closeNewStoryForm() {
    ui.newStoryForm.reset();
    ui.newStoryForm.hidden = true;
    ui.newStoryButton.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  // Welcome screen: "Create your big story"
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
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });

  render();
})();
