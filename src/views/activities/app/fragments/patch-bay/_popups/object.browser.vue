<template>
  <uk-flex
    col
    class="object_browser"
  >
    <h4
      v-if="!rows.length"
      class="object_browser_empty"
    >
      No objects yet
    </h4>

    <!-- The scroller is inside, not the root. The root wears `fixture_list`
         from the dialog, which fixes the height and sets `overflow: hidden`,
         so anything scrollable has to be a child of it. -->
    <div
      v-if="rows.length"
      class="object_browser_scroll"
    >
      <!-- One flat list of folder headings and tile grids, indented by depth.
           A recursive template would draw the same thing; this keeps the tree
           to one pass of a computed and lets CSS do the nesting, which is all
           depth is -- the chevron, the indent and `opened` say the rest. -->
      <template
        v-for="row in rows"
        :key="row.key"
      >
        <button
          v-if="row.folder"
          type="button"
          class="object_browser_folder"
          :style="{ paddingLeft: `${8 + row.depth * 14}px` }"
          @click="toggle(row.path)"
        >
          <uk-icon
            class="object_browser_chevron"
            :class="{ open: isOpen(row.path) }"
            name="arrow_down"
          />
          <uk-icon
            class="object_browser_folder_icon"
            name="folder"
          />
          <span class="object_browser_folder_name">{{ row.name }}</span>
          <span class="object_browser_count">{{ row.count }}</span>
        </button>

        <div
          v-else
          class="object_browser_grid"
          :style="{ paddingLeft: `${10 + row.depth * 14}px` }"
        >
          <button
            v-for="model in row.models"
            :key="model.key"
            type="button"
            class="object_browser_tile"
            :class="{ selected: selectedKey === model.key }"
            :title="tooltip(model)"
            @click="$emit('select', model)"
            @dblclick="$emit('confirm', model)"
          >
            <span class="object_browser_thumb">
              <img
                v-if="thumbnail(model)"
                :src="thumbnail(model)"
                :alt="model.name"
              >
              <uk-icon
                v-else
                name="object"
                class="object_browser_placeholder"
              />
            </span>
            <span class="object_browser_name">{{ model.name }}</span>
          </button>
        </div>
      </template>
    </div>
  </uk-flex>
</template>

<script>
/**
 * @file Browses the object library as folders of square tiles.
 *
 * A list of names says very little about a shape, so objects get pictures and
 * pictures want a grid. Deliberately its own component rather than a mode of
 * `uk-list`: that component serves every other tab in the app, and a grid is a
 * different thing from a row -- teaching it both would put the risk on
 * everything rather than on this.
 *
 * **Folders nest.** `Trusses/Circles/quarter` is three levels, and the tree is
 * built from the whole path each catalogue entry carries -- see
 * `objectstore.js`. Depth costs nothing but an indent, which is why the
 * headings and their tiles are flattened into one list rather than drawn by a
 * recursive component.
 *
 * A thumbnail is `<name>.png` beside the model, the same convention the
 * metadata sidecar follows. Anything without one falls back to the object
 * icon, so the browser is useful before a single picture exists.
 */

/** Objects that live in no folder, gathered under one heading. */
const UNSORTED = 'Unsorted';

/**
 * The open/closed key for the heading that is not a folder.
 *
 * A NUL-prefixed name, because Windows forbids NUL in a file name and
 * `readdirSync` cannot return one -- so this cannot collide with the path of a
 * folder the user actually made, however they spelled it.
 *
 * @constant {String}
 */
const UNSORTED_KEY = '\u0000unsorted';

export default {
  name: 'ObjectBrowser',
  compatConfig: {
    MODE: 3,
  },
  props: {
    /** Library entries from `window.library.objects()`. */
    models: {
      type: Array,
      default: () => [],
    },
    /** The key of the selected model, or null. */
    selectedKey: {
      type: String,
      default: null,
    },
  },
  emits: ['select', 'confirm'],
  data() {
    return {
      /**
       * Folder paths the user has opened -- `Trusses`, `Trusses/Circles` -- and
       * not names, because two folders may share a name at different depths and
       * opening one must not open the other.
       */
      opened: [],
      /** Whether anything has been opened yet, so the first can open itself. */
      touched: false,
    };
  },
  computed: {
    /**
     * The library as a tree of folders, built from each entry's folder path.
     *
     * A flat list cannot say which `Circles` belongs to `Trusses` and which to
     * `Lighting`, so nothing is grouped by name here: every entry is filed
     * under the path it was found at, and the paths themselves are the tree.
     *
     * @returns {Object} the root node, whose own `models` are the loose ones
     */
    tree() {
      const root = {
        name: '', path: '', folder: true, models: [], children: [],
      };
      this.models.forEach((model) => {
        const segments = String(model.folder || '').split('/').filter(Boolean);
        let node = root;
        segments.forEach((segment) => {
          const path = node.path ? `${node.path}/${segment}` : segment;
          let child = node.children.find((candidate) => candidate.path === path);
          if (!child) {
            child = {
              name: segment, path, folder: true, models: [], children: [], count: 0,
            };
            node.children.push(child);
          }
          node = child;
        });
        node.models.push(model);
      });

      // Counts are of everything beneath a folder, not just its own files --
      // a number that changed as you opened a folder would say nothing about
      // how much is in there.
      const tally = (node) => {
        node.children.sort((a, b) => a.name.localeCompare(b.name));
        node.models.sort((a, b) => a.name.localeCompare(b.name));
        node.count = node.models.length
          + node.children.reduce((total, child) => total + tally(child), 0);
        return node.count;
      };
      tally(root);
      return root;
    },
    /**
     * The tree, flattened into headings and tile grids in reading order.
     *
     * Each row carries its own depth, and a closed folder ends its own branch:
     * nothing under it is in the list at all, which is what "closed" means.
     *
     * An opened folder contributes **two** things -- its own files, then the
     * folders inside it -- and the second is what is easy to leave out: a walk
     * that only follows `children` shows the folder and its count and then
     * nothing, because the count is tallied from the node itself while the
     * tiles would have come from its siblings.
     *
     * @returns {Array}
     */
    rows() {
      const rows = [];
      const emit = (node, depth) => {
        // The root is the exception: its own models are the loose ones, which
        // get a heading of their own below rather than reading as the tree's
        // files. An empty path is what says "this is the root".
        if (node.path && node.models.length) {
          rows.push({
            folder: false,
            name: node.name,
            models: node.models,
            depth,
            key: `grid:${node.path}`,
          });
        }
        node.children.forEach((child) => {
          rows.push({
            ...child, folder: true, depth, key: `folder:${child.path}`,
          });
          if (this.isOpen(child.path)) emit(child, depth + 1);
        });
      };
      emit(this.tree, 0);

      const loose = this.tree.models;
      if (!loose.length) return rows;
      // With nothing filed, the objects are the whole catalogue and a single
      // heading over all of them says nothing -- so they stand on their own.
      if (!rows.length) {
        return [{
          folder: false, name: UNSORTED, models: loose, depth: 0, key: 'grid:loose',
        }];
      }
      // Otherwise the top level is folders and only folders. Six loose files
      // above four folders is more clutter than catalogue, and the loose ones
      // are the least likely to be what is being looked for -- they are the
      // ones nobody has got round to filing.
      //
      // `Unsorted` is not a directory on disk, and saying so matters: renaming
      // or moving it in Explorer will not do anything, because it is the
      // absence of a folder rather than the presence of one.
      const heading = {
        folder: true,
        name: UNSORTED,
        path: UNSORTED_KEY,
        count: loose.length,
        depth: 0,
        key: `folder:${UNSORTED_KEY}`,
      };
      if (!this.isOpen(UNSORTED_KEY)) return [...rows, heading];
      return [...rows, heading, {
        folder: false, name: UNSORTED, models: loose, depth: 1, key: 'grid:loose',
      }];
    },
  },
  watch: {
    rows: {
      immediate: true,
      handler(rows) {
        // The first folder opens itself, so the panel is never a column of
        // closed headings with nothing to look at. Keyed by path, so it holds
        // when the catalogue is re-read and the folders are the same ones.
        if (this.touched || !rows.length) return;
        const first = rows.find((row) => row.folder && row.path);
        if (first) this.opened = [first.path];
      },
    },
  },
  methods: {
    isOpen(path) {
      return this.opened.includes(path);
    },
    /**
     * Opens or closes a folder.
     *
     * @param {String} path the folder's path from the library root
     */
    toggle(path) {
      this.touched = true;
      this.opened = this.isOpen(path)
        ? this.opened.filter((entry) => entry !== path)
        : [...this.opened, path];
    },
    /**
     * Where a model's preview image can be fetched from, if it has one.
     *
     * A user model's is served over `library://`; a shipped one is a static
     * asset, and the prefix for those is a renderer concern -- which is why
     * main hands over a path rather than a finished url.
     *
     * @param {Object} model
     * @returns {String|null}
     */
    thumbnail(model) {
      if (model.thumbnailUrl) return model.thumbnailUrl;
      if (model.thumbnailStaticPath) {
        return `${import.meta.env.VITE_STATIC_URL}/${model.thumbnailStaticPath}`;
      }
      return null;
    },
    /**
     * What the tile says on hover: the things a name cannot.
     *
     * @param {Object} model
     * @returns {String}
     */
    tooltip(model) {
      const parts = [model.key];
      if (model.kind === 'primitive') {
        parts.push('created');
      } else {
        parts.push(model.described
          ? `${model.scale}x ${String(model.upAxis).toUpperCase()}-up`
          : 'not imported');
      }
      if (model.shipped) parts.push('supplied');
      return parts.join(' · ');
    },
  },
};
</script>

<style scoped>
/*
 * Matched to `uikit.list.item.vue` rather than invented: rows sit on
 * --primary-light, hover is --secondary-darker, and a selection is the teal at
 * 16% with the solid --accent-teal reserved for the focused one. A browser that
 * styles itself differently from the list beside it reads as a different app.
 */
.object_browser {
  width: 100%;
  height: 100%;
  gap: 0;
  background: var(--primary-light);
  /* The root cannot be the scroller: it wears `fixture_list` from the dialog,
     which sets a fixed height and `overflow: hidden`. */
  overflow: hidden;
}

/* `min-height: 0` is the whole trick. A flex child will not shrink below its
   content without it, so `overflow-y: auto` has nothing to scroll and the
   grid simply overflows the panel. */
.object_browser_scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  width: 100%;
}

.object_browser_empty {
  opacity: 0.6;
  padding: 12px;
}

.object_browser_folder {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: none;
  border-bottom: 1px solid var(--primary-dark);
  background: var(--primary-light);
  color: var(--secondary-lighter);
  font-family: Roboto-bold;
  font-size: 13px;
  text-align: left;
  opacity: 0.9;
  transition: background-color 0.1s;
  cursor: pointer;
}

.object_browser_folder:hover {
  background: var(--secondary-darker);
}

/* One asset rotated, the file-explorer convention the list already follows:
   pointing right when closed, down when open. */
.object_browser_chevron {
  width: 12px;
  height: 12px;
  transform: rotate(-90deg);
  transition: transform 120ms ease;
}

.object_browser_chevron.open {
  transform: rotate(0deg);
}

@media (prefers-reduced-motion: reduce) {
  .object_browser_chevron { transition: none; }
}

.object_browser_folder_icon {
  width: 16px;
  height: 16px;
}

.object_browser_folder_name {
  flex: 1;
}

.object_browser_count {
  color: var(--secondary-light-alt);
  font-family: Roboto-medium;
  font-size: 11px;
}

/* Square tiles that reflow: the dialog is resizable and a fixed column count
   would either waste the width or clip. */
.object_browser_grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
  gap: 8px;
  padding: 10px 10px 14px;
  background: var(--primary-dark-alt);
  border-bottom: 1px solid var(--primary-dark);
}

.object_browser_tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 6px 4px;
  border: 1px solid transparent;
  border-radius: 3px;
  background: none;
  color: var(--secondary-lighter-alt);
  font-family: Roboto-medium;
  transition: background-color 0.1s;
  cursor: pointer;
}

.object_browser_tile:hover {
  background: var(--secondary-darker);
}

.object_browser_tile.selected {
  background: rgba(28, 166, 189, 0.16);
  border-color: var(--accent-teal);
  color: var(--secondary-lighter);
}

/* `aspect-ratio` keeps the well square whatever the column width, so the grid
   reflows without the tiles distorting. */
.object_browser_thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 1;
  border: 1px solid var(--primary-dark);
  border-radius: 2px;
  background: var(--primary-dark);
  overflow: hidden;
}

.object_browser_thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.object_browser_placeholder {
  width: 30px;
  height: 30px;
  opacity: 0.3;
}

.object_browser_name {
  font-size: 11px;
  line-height: 1.25;
  text-align: center;
  /* Two lines, then ellipsis: a tile that grows with its name breaks the grid. */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
</style>
