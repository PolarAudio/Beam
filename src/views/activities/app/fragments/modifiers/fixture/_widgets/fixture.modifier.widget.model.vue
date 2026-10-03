<template>
  <uk-widget
    class="fixture_model"
    dockable
    :header="header"
  >
    <uk-flex
      v-if="fixture"
      :gap="8"
      col
      class="fixture_model_body"
    >
      <!-- A definition made in this show and not yet in the library. It lives
           with the show and goes when its last instance does; saving it is
           the deliberate act that makes it a library reference -- the same
           bargain a structure and an inline object make. -->
      <uk-flex
        v-if="isShowDefinition"
        col
        :gap="6"
        class="definition_home"
      >
        <span class="scope_note">
          Defined in this show, not in the library. It goes when its last
          instance does.
        </span>
        <uk-flex :gap="8">
          <uk-button
            icon="export"
            label="save to library"
            :disabled="saving"
            title="Move this definition into the library, to place in other shows"
            @click="openSave"
          />
        </uk-flex>
      </uk-flex>
      <p
        v-if="saveMessage"
        :class="saveFailed ? 'definition_warning' : 'definition_ok'"
      >
        {{ saveMessage }}
      </p>

      <!-- The moment a definition gets its identity: it was made under a
           working name, and the library files it by manufacturer and model.
           The manufacturer list is the library's own folders plus Generic,
           narrowed as you type; a name that is in no list is still a name. -->
      <uk-popup
        v-model="saveOpen"
        cancelable
        backdrop
        :valid="saveValid"
        :header="{ title: 'Save to library' }"
        @submit="saveToLibrary"
      >
        <uk-flex
          col
          :gap="8"
          class="save_form"
        >
          <uk-combo-input
            v-model="saveManufacturer"
            label="Manufacturer"
            :options="manufacturerOptions"
          />
          <uk-txt-input
            v-model="saveModel"
            auto-update
            label="Model"
          />
          <p
            v-if="saveTaken"
            class="definition_warning"
          >
            The library already has a "{{ saveKey }}". Pick another name.
          </p>
        </uk-flex>
      </uk-popup>

      <!-- What the model *is*, above the map of what it answers to. This is
           the profile-scoped widget, and a resolution, a pitch and a throw are
           properties of the model rather than of this placement -- so they
           belong here beside the channel map rather than in Fixture Settings
           with the things you set per unit. It also fills the space a device
           with few channels, or none, otherwise leaves empty. -->
      <!-- The four facts most asked about a model, always in view; the rest of
           the spec sheet is collapsed below. See `keyFacts`. -->
      <div
        v-if="keyFacts.length"
        class="device_facts"
      >
        <dl>
          <template
            v-for="fact in keyFacts"
            :key="fact.label"
          >
            <dt>{{ fact.label }}</dt>
            <dd>{{ fact.value }}</dd>
          </template>
        </dl>
      </div>

      <div
        v-if="deviceFacts.length"
        class="device_facts"
      >
        <dl>
          <template
            v-for="fact in deviceFacts"
            :key="fact.label"
          >
            <dt :class="{ fact_warning: fact.warning }">
              {{ fact.label }}
            </dt>
            <dd :class="{ fact_warning: fact.warning }">
              {{ fact.value }}
            </dd>
          </template>
        </dl>
      </div>

      <details
        v-if="specFacts.length"
        class="fixture_guide"
      >
        <summary>Specifications</summary>
        <dl>
          <template
            v-for="fact in specFacts"
            :key="fact.label"
          >
            <dt>{{ fact.label }}</dt>
            <dd>{{ fact.value }}</dd>
          </template>
        </dl>
      </details>

      <!-- A short manual for the mode in use, written from the profile: what
           to set before there is light, and what each channel's ranges do.
           Collapsed until asked for; see `fixtureGuide`. -->
      <details
        v-if="guide"
        class="fixture_guide"
      >
        <summary>Quick guide</summary>
        <p
          v-if="guide.light.length"
          class="guide_light"
        >
          To get light: {{ guide.light.join(', then ') }}.
        </p>
        <dl>
          <template
            v-for="row in guide.channels"
            :key="row.n"
          >
            <dt :class="{ undrawn: !row.drawn }">
              {{ row.n }} {{ row.name }}
            </dt>
            <dd :class="{ undrawn: !row.drawn }">
              <!-- Many ranges read as a table, DMX values beside what they
                   do; one or two stay on the line. -->
              <table
                v-if="row.ranges && row.ranges.length > 2"
                class="guide_ranges"
              >
                <tr
                  v-for="(r, i) in row.ranges"
                  :key="i"
                >
                  <td class="guide_range">
                    {{ r.range }}
                  </td>
                  <td>{{ r.text }}</td>
                </tr>
              </table>
              <template v-else>
                {{ row.text }}
              </template>
              <span v-if="!row.drawn"> (no effect in Beam)</span>
            </dd>
          </template>
        </dl>
      </details>

      <!-- A bar's channels are one thing repeated, so they are described
           rather than listed here, and only a bar is: every other fixture's
           channels are on the Settings widget, with their addresses and what
           they hold, and a bar's are too many to list there. See
           `barSummary`. -->
      <uk-flex
        v-if="barSummary"
        :gap="8"
        class="channel_map_header"
      >
        <span class="section_label">Channel map</span>
        <span style="flex: 1" />
        <uk-button
          :label="copyLabel"
          @click="copyMap"
        />
      </uk-flex>
      <div
        v-if="barSummary"
        class="channel_map"
      >
        <dl class="bar_summary">
          <template
            v-for="fact in barSummary"
            :key="fact.label"
          >
            <dt>{{ fact.label }}</dt>
            <dd>{{ fact.value }}</dd>
          </template>
        </dl>
      </div>
      <div
        v-if="barSummary"
        class="channel_map bar_sample"
      >
        <table>
          <thead>
            <tr>
              <th class="num">
                #
              </th>
              <th>Channel</th>
              <th>Function</th>
            </tr>
          </thead>
          <tbody>
            <template
              v-for="row in barSample"
              :key="row.index"
            >
              <tr v-if="row.gap">
                <td
                  class="gap"
                  colspan="3"
                >
                  {{ row.gap }}
                </td>
              </tr>
              <tr v-else>
                <td class="num">
                  {{ row.index }}
                </td>
                <td>{{ row.name }}</td>
                <td class="function">
                  {{ row.function }}
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </uk-flex>
  </uk-widget>
</template>

<script>
import {
  pixelFill, pitchText, displayCurve, emitterSize, unusualEmitter,
} from '@/models/DMX/generic/display';
import {
  throwRange, throwAngles, imageSizeAt, illuminanceAt,
} from '@/models/DMX/generic/projector';
import { fixtureIcon } from '@/models/DMX/generic/fixture_kind';
import { isShowKey } from '@/models/DMX/definition_store';
import fixtureGuide from '@/models/DMX/fixture_guide';
import gdtfGuide from '@/models/DMX/gdtf/gdtf_guide';
import DmxEngine from '@/models/DMX/gdtf/dmx_engine';
import { headInputs, unfilledBeamFields } from '@/models/DMX/gdtf/fixture_parts';
import { formatAddress } from '@/models/DMX/address_format';
import Light from '@/plugins/visualizer/light';

/** A whole number with thousands separators. */
const grouped = (n) => Math.round(n).toLocaleString('en-GB');

/**
 * The peak a head renders with at each end of its zoom, and the lux it
 * puts on a surface 10 m away there.
 */
function peakFact(lumens, narrow, wide) {
  const atNarrow = Light.peakAtZoom(lumens, narrow);
  const atWide = Light.peakAtZoom(lumens, wide);
  const lux = (cd) => `${grouped(cd / 100)} lux at 10 m`;
  const value = narrow === wide
    ? `${grouped(atWide)} cd · ${lux(atWide)}`
    : `${grouped(atNarrow)} cd at ${narrow}° (${lux(atNarrow)}) · ${grouped(atWide)} cd at ${wide}°`;
  return { label: 'Peak', value };
}

/** How long the copy button confirms for, in ms. */
const COPY_FEEDBACK_MS = 1500;

export default {
  name: 'FixtureModifierWidgetModel',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  props: {
    /**
     * Handle to fixture instance
     */
    fixture: {
      type: Object,
      default: null,
    },
  },
  data() {
    return {
      copied: false,
      /**
       * Bumped whenever the library is written. The show is a plain class, not
       * a reactive object, so a computed reading its store would cache
       * forever; this gives those computeds something reactive to depend on.
       */
      revision: 0,
      saving: false,
      saveMessage: '',
      saveFailed: false,
      /** The save dialog, and what it is filled with. */
      saveOpen: false,
      saveManufacturer: 'Generic',
      saveModel: '',
    };
  },
  computed: {
    /**
     * Whether this fixture's definition belongs to the show rather than the
     * library. Reads `revision` so it re-evaluates after a save: the show is a
     * plain class and Vue cannot see its store change.
     */
    isShowDefinition() {
      return this.revision >= 0 && this.$show.isShowDefinition(this.profileKey);
    },
    /** The manufacturers the save dialog offers, by display name. */
    manufacturerChoices() {
      return this.revision >= 0 ? this.$show.manufacturerChoices() : [];
    },
    manufacturerOptions() {
      return this.manufacturerChoices.map((choice) => choice.name);
    },
    /**
     * The library folder the typed manufacturer means: a listed one's own
     * folder, or the text itself for a maker nobody has listed.
     *
     * @type {String}
     */
    saveManufacturerSlug() {
      const typed = (this.saveManufacturer || '').trim();
      const listed = this.manufacturerChoices.find(
        (choice) => choice.name.toLowerCase() === typed.toLowerCase(),
      );
      return listed ? listed.slug : typed;
    },
    saveKey() {
      return `${this.saveManufacturerSlug}/${(this.saveModel || '').trim()}`;
    },
    saveTaken() {
      return !!this.$show.generatedProfiles[this.saveKey];
    },
    saveValid() {
      const maker = (this.saveManufacturer || '').trim();
      const model = (this.saveModel || '').trim();
      return !!maker && !!model && !maker.includes('/') && !model.includes('/') && !this.saveTaken;
    },
    /**
     * Make, model, lumens and power: what is asked about a model first.
     *
     * @type {Array}
     */
    keyFacts() {
      if (!this.fixture) return [];
      if (this.gdtf) return this.gdtfFacts.key;
      const { physical } = this;
      const facts = [
        { label: 'Make', value: this.$show.manufacturerName(this.fixture.manufacturer) },
        { label: 'Model', value: this.fixture.model },
        { label: 'Lumens', value: this.lumensText() },
      ];
      if (Number(physical.power) > 0) facts.push({ label: 'Power', value: `${grouped(physical.power)} W` });
      return facts.filter((fact) => fact.value);
    },
    /**
     * The rest of the profile's spec sheet, and for a moving head the peak
     * intensity Beam renders at each end of the zoom.
     *
     * @type {Array}
     */
    specFacts() {
      if (this.gdtf) return this.gdtfFacts.spec;
      const data = (this.fixture && this.fixture.OFLData) || {};
      const { physical } = this;
      const bulb = physical.bulb || {};
      const facts = [];
      if (bulb.type) facts.push({ label: 'Lamp', value: bulb.type });
      if (bulb.colorTemperature) facts.push({ label: 'Colour temp', value: `${grouped(bulb.colorTemperature)} K` });
      const lens = this.lensRange;
      if (lens) {
        const [narrow, wide] = lens;
        facts.push({ label: 'Zoom', value: narrow === wide ? `${narrow}°` : `${narrow}° – ${wide}°` });
        const lumens = this.isMover ? Light.lumensOf(physical) : null;
        if (lumens) facts.push(peakFact(lumens, narrow, wide));
      }
      if (physical.weight) facts.push({ label: 'Weight', value: `${physical.weight} kg` });
      const size = physical.dimensions;
      if (Array.isArray(size) && size.length === 3) {
        facts.push({ label: 'Size', value: `${size.join(' x ')} mm (W x H x D)` });
      }
      if (physical.DMXconnector) facts.push({ label: 'Connector', value: physical.DMXconnector });
      if ((data.categories || []).length) facts.push({ label: 'Category', value: data.categories.join(', ') });
      if ((data.modes || []).length) {
        facts.push({
          label: 'Modes',
          value: data.modes.map((m) => `${m.name} (${(m.channels || []).length} ch)`).join(', '),
        });
      }
      return facts;
    },
    /** The fixture's GDTF fixture type, or null for an OFL profile. */
    gdtf() {
      return (this.fixture && this.fixture.fixtureType) || null;
    },
    /**
     * A GDTF fixture's facts, from the file as it stands. Output a file left
     * at GDTF's placeholder values is said to be unmeasured rather than
     * shown as if it were a measurement, and a beam's values still at the
     * spec's defaults, in a beam nobody filled in, are left out.
     *
     * @type {Object} `{ key, spec }`
     */
    gdtfFacts() {
      const type = this.gdtf;
      const mode = this.fixture.mode || type.modes[0];
      const inputs = headInputs(type, mode);
      const { beam } = inputs;
      const unmeasured = inputs.unmeasured ? ' · not measured, file defaults' : '';
      const key = [
        { label: 'Make', value: type.manufacturer },
        { label: 'Model', value: type.name },
      ];
      if (inputs.lumens) {
        const per = inputs.beamCount > 1 ? ` (${inputs.beamCount} beams)` : '';
        key.push({ label: 'Lumens', value: `${grouped(inputs.lumens)} lm${per}${unmeasured}` });
      }
      const unfilled = unfilledBeamFields(beam);
      const stated = (name) => !unfilled.has(name);
      if (inputs.power && stated('powerConsumption')) {
        key.push({ label: 'Power', value: `${grouped(inputs.power)} W light source` });
      }

      const spec = [];
      if (beam) {
        const line = (label, parts) => {
          const kept = parts.filter(([name]) => stated(name)).map(([, text]) => text);
          if (kept.length) spec.push({ label, value: kept.join(' · ') });
        };
        line('Lamp', [['lampType', beam.lampType]]);
        line('Colour temp', [
          ['colorTemperature', `${grouped(beam.colorTemperature)} K`],
          ['colorRenderingIndex', `CRI ${beam.colorRenderingIndex}`],
        ]);
        line('Beam', [
          ['beamAngle', `${beam.beamAngle}° beam`],
          ['fieldAngle', `${beam.fieldAngle}° field`],
          ['beamType', beam.beamType],
        ]);
      }
      const narrow = inputs.minAngle;
      const wide = inputs.maxAngle;
      if (narrow && wide && narrow !== wide) spec.push({ label: 'Zoom', value: `${narrow}° – ${wide}°` });
      if (inputs.lumens && narrow && wide && ['Moving Head', 'Static'].includes(inputs.category)) {
        spec.push(peakFact(inputs.lumens, narrow, wide));
      }
      if (inputs.panSpan) spec.push({ label: 'Pan / tilt', value: `${inputs.panSpan}° / ${inputs.tiltSpan || 0}°` });
      if (inputs.panSpeed || inputs.tiltSpeed) {
        const rate = (speed) => (speed ? `${Math.round(speed)}°/s` : '-');
        spec.push({ label: 'Pan / tilt speed', value: `${rate(inputs.panSpeed)} / ${rate(inputs.tiltSpeed)}` });
      }
      const { weight } = type.physical.properties;
      if (weight) spec.push({ label: 'Weight', value: `${weight} kg` });
      spec.push({
        label: 'Modes',
        value: type.modes.map((m) => `${m.name} (${new DmxEngine(type, m).footprint} ch)`).join(', '),
      });
      const last = type.revisions[type.revisions.length - 1];
      spec.push({
        label: 'GDTF',
        value: `${type.dataVersion || '?'}${last && last.text ? ` · ${last.text}` : ''}`,
      });
      return { key, spec: spec.filter((fact) => fact.value) };
    },
    /** The profile's physical block, or an empty one. */
    physical() {
      return ((this.fixture && this.fixture.OFLData) || {}).physical || {};
    },
    /**
     * Drawn as a moving head: the same test the fixture uses to build one.
     *
     * @type {Boolean}
     */
    isMover() {
      const data = (this.fixture && this.fixture.OFLData) || {};
      return (data.categories || []).includes('Moving Head') && !!data.physical;
    },
    /**
     * Narrowest and widest field in degrees, or null. A head with no lens
     * block is drawn at 10 to 25 degrees, so it says so.
     *
     * @type {Array|null}
     */
    lensRange() {
      const lens = this.physical.lens || {};
      if (Array.isArray(lens.degreesMinMax)) return lens.degreesMinMax.map(Number);
      return this.isMover ? [10, 25] : null;
    },
    /**
     * What this model is, for a projector or a display.
     *
     * Read off the profile, so it speaks for every one of them in the show --
     * which is this widget's whole remit. A bar already has `barSummary` doing
     * the same job a few lines below; this is that idea for the video devices.
     *
     * @type {Array}
     */
    deviceFacts() {
      const asls = (this.fixture && this.fixture.OFLData && this.fixture.OFLData.asls) || {};
      if (asls.display) return this.displayFacts(asls.display);
      if (asls.projector) return this.projectorFacts(asls.projector);
      return [];
    },
    /**
     * Widget title, naming the model rather than the fixture: everything in
     * here is a property of the profile, not of the selected instance.
     *
     * @type {String}
     */
    header() {
      // The icon says which kind of fixture these settings belong to. It used
      // to be `grid` either way, which is the uikit widget's own placeholder
      // and meant nothing here.
      if (!this.fixture) return { title: 'Model', icon: 'fixture' };
      const mode = this.fixture.mode ? ` — ${this.fixture.mode.name}` : '';
      const count = this.fixture.channels ? ` (${this.fixture.channels.length} ch)` : '';
      return {
        title: `${this.fixture.model}${mode}${count}`,
        icon: fixtureIcon(this.fixture),
        // Library reference: the same badge the item list puts on the row.
        overlay: this.isShowDefinition ? null : 'link',
      };
    },
    /**
     * Key the fixture's profile is stored under.
     *
     * @type {String}
     */
    profileKey() {
      return this.fixture ? this.fixture.profileKey : '';
    },
    /**
     * Whether this fixture has a head that travels. Slew rates are meaningless
     * on anything else, and an LED bar has no pan or tilt at all.
     *
     * @type {Boolean}
     */
    /**
     * The quick guide for this fixture's mode, or null where it would say
     * nothing useful: a bar is described by its own summary, and a fixture
     * with no channels has nothing to guide.
     *
     * @type {Object|null}
     */
    guide() {
      const fixture = this.fixture || {};
      if (!fixture.OFLData || !fixture.mode || this.barSummary) return null;
      const guide = fixture.fixtureType && fixture._engine
        ? gdtfGuide(fixture.fixtureType, fixture._engine)
        : fixtureGuide(fixture.OFLData, fixture.mode);
      return guide.channels.length ? guide : null;
    },
    copyLabel() {
      return this.copied ? 'copied' : 'copy';
    },
    /**
     * A bar's channel map, as the handful of numbers that fully describe it.
     *
     * Null for anything that is not a generated bar, which is what the table
     * above keys off. Every fixture in the shipped library is at most 127
     * channels, so the table is only ever a problem for the ones we generate.
     *
     * @type {Array|null}
     */
    barSummary() {
      const { fixture } = this;
      if (!fixture || !fixture.isBar || !fixture.channels) return null;
      const { bar } = fixture.OFLData.asls;
      const total = fixture.channels.length;
      if (!total) return null;

      const pixels = (bar.columns || 0) * (bar.rows || 0);
      const perPixel = fixture.channelsPerPixel;
      // The end comes from `addressOf`, never from start + count: a fixture
      // keeping its pixels whole steps over 511-512 of every universe, so its
      // last channel sits further out than the count alone implies.
      const first = fixture.addressOf(0);
      const last = fixture.addressOf(total - 1);
      const at = formatAddress;

      const wiring = [
        bar.scanAxis === 'column' ? 'down columns' : 'along rows',
        `from ${String(bar.startCorner || 'top-left').replace('-', ' ')}`,
      ];
      if (bar.serpentine) wiring.push('serpentine');

      return [
        { label: 'Grid', value: `${bar.columns} x ${bar.rows}  (${pixels.toLocaleString()} pixels)` },
        { label: 'Components', value: `${String(bar.order || '').toUpperCase()}  (${perPixel} per pixel)` },
        { label: 'Channels', value: total.toLocaleString() },
        { label: 'Span', value: `${at(first)}  to  ${at(last)}` },
        { label: 'Universes', value: (Math.floor(last / 512) - Math.floor(first / 512) + 1).toLocaleString() },
        { label: 'Wiring', value: wiring.join(', ') },
        {
          label: 'Pixels kept whole',
          value: fixture.universeAligned ? 'yes, skips 511-512' : 'no, may straddle',
        },
      ];
    },
    /**
     * The first and last pixel of a bar, as sample rows.
     *
     * The summary says what the pattern is; these show it, and confirm the
     * addressing at both ends of a run that may cross two hundred universes.
     *
     * @type {Array}
     */
    barSample() {
      const { fixture } = this;
      if (!this.barSummary) return [];
      const total = fixture.channels.length;
      const perPixel = fixture.channelsPerPixel;
      const head = [];
      const tail = [];
      for (let i = 0; i < Math.min(perPixel, total); i += 1) head.push(this.rowAt(i));
      for (let i = Math.max(perPixel, total - perPixel); i < total; i += 1) {
        tail.push(this.rowAt(i));
      }
      if (!tail.length) return head;
      const hidden = total - head.length - tail.length;
      return hidden > 0
        ? [...head, { index: -1, gap: `${hidden.toLocaleString()} more channels` }, ...tail]
        : [...head, ...tail];
    },
  },
  methods: {
    /**
     * Moves this show's definition into the library.
     *
     * @public
     * @async
     */
    /**
     * Opens the save dialog with the definition's working name as the model
     * and Generic as the manufacturer, or its own manufacturer for a
     * definition an older show made under one.
     *
     * @public
     */
    openSave() {
      if (!this.fixture) return;
      this.saveModel = this.fixture.model || '';
      this.saveManufacturer = isShowKey(this.profileKey)
        ? 'Generic'
        : this.$show.manufacturerName(this.fixture.manufacturer);
      this.saveMessage = '';
      this.saveOpen = true;
    },
    async saveToLibrary() {
      if (!this.fixture || !this.saveValid) return;
      this.saveOpen = false;
      this.saving = true;
      this.saveMessage = '';
      let result;
      try {
        result = await this.$show.saveDefinitionToLibrary(
          this.profileKey,
          this.saveManufacturerSlug,
          (this.saveModel || '').trim(),
        );
      } catch (err) {
        result = { ok: false, reason: err.message };
      }
      this.saving = false;
      this.saveFailed = !result.ok;
      this.saveMessage = result.ok
        ? `Saved "${result.key}" to the library.`
        : result.reason || 'Could not save to the library.';
      this.revision += 1;
    },
    /**
     * A display's specification, in the order someone reads one.
     *
     * @public
     * @param {Object} p the profile's `asls.display`
     * @returns {Array}
     */
    displayFacts(p) {
      const wide = Math.round(p.pixelsWide);
      const high = Math.round(p.pixelsHigh);
      const fill = pixelFill(p);
      const diagonal = Math.sqrt((p.width * 1000) ** 2 + (p.height * 1000) ** 2) / 25.4;
      const lit = fill.x >= 0.999 && fill.y >= 0.999
        ? 'pixels meet'
        : `${Math.round(fill.x * 100)}% x ${Math.round(fill.y * 100)}% of each cell`;
      const facts = [
        { label: 'Takes', value: `${wide} x ${high} video` },
        { label: 'Panel', value: `${(p.width * 1000).toFixed(0)} x ${(p.height * 1000).toFixed(0)} mm · ${diagonal.toFixed(0)}"` },
        { label: 'Pitch', value: `${pitchText(p)} · ${(emitterSize(p) * 1000).toFixed(1)} mm emitter · ${lit}` },
        { label: 'Brightness', value: `${p.nits} nits` },
      ];
      // Only when it is bent. The arc and the chord are both worth saying: the
      // arc is the width in pixels, the chord is the room it actually takes up,
      // and they are the two numbers you need to butt panels together.
      const curve = displayCurve(p, p.width + (Number(p.bezel) || 0) * 2);
      if (curve.radius) {
        // The angle leads because it is what was asked for; the radius and the
        // chord follow because they are what it works out to. The chord is the
        // room it actually takes up, which is the number for butting panels
        // together -- the width is arc length and stays what it was.
        const chord = 2 * curve.radius * Math.sin(curve.angle / 2);
        facts.push({
          label: 'Curve',
          value: `${((curve.angle * 180) / Math.PI).toFixed(1)}° ${curve.sign > 0 ? 'convex' : 'concave'}`
            + ` · r ${(curve.radius * 1000).toFixed(0)} mm · spans ${(chord * 1000).toFixed(0)} mm`,
        });
      }
      // Said outright rather than left to the Pitch line: a panel built with
      // an emitter nobody uses is the explanation for a wall that looks odd,
      // and a definition cannot be edited, so this is all that can be done.
      const unusual = unusualEmitter(p);
      if (unusual) facts.push({ label: 'Unusual', value: unusual, warning: true });
      return facts;
    },
    /**
     * A projector's specification.
     *
     * @public
     * @param {Object} p the profile's `asls.projector`
     * @returns {Array}
     */
    /**
     * The lumens line. For a moving head it is the figure the head is lit
     * from, and says so when that is not the profile's own: `lumensOf`
     * replaces a missing or unbelievable figure with one made from the power.
     *
     * @public
     * @returns {String}
     */
    lumensText() {
      const { physical } = this;
      const stated = Number((physical.bulb || {}).lumens);
      if (!this.isMover) {
        const projector = ((this.fixture.OFLData || {}).asls || {}).projector || {};
        const lumens = stated > 0 ? stated : Number(projector.lumens);
        return lumens > 0 ? `${grouped(lumens)} lm` : '';
      }
      const used = Light.lumensOf(physical);
      if (!used) return 'not stated · lit as the reference head';
      if (used === stated) return `${grouped(used)} lm`;
      const from = `estimated from ${grouped(physical.power)} W`;
      return stated > 0
        ? `${grouped(used)} lm, ${from} (profile says ${grouped(stated)})`
        : `${grouped(used)} lm, ${from}`;
    },
    projectorFacts(p) {
      const { min, max } = throwRange(p);
      const wide = throwAngles(min, p);
      const narrow = throwAngles(max, p);
      const at5 = imageSizeAt(5, min, p);
      const zoom = min === max ? `${min} : 1 prime` : `${min} - ${max} : 1`;
      return [
        { label: 'Throws', value: `${p.pixelsWide} x ${p.pixelsHigh} video` },
        { label: 'Lens', value: `${zoom} · ${narrow.horizontal.toFixed(1)}° to ${wide.horizontal.toFixed(1)}°` },
        { label: 'At 5 m', value: `up to ${at5.width.toFixed(2)} x ${at5.height.toFixed(2)} m` },
        // Lumens on their own say nothing about how a projection will read: the
        // same machine is brilliant on a small image and washed out on a big
        // one. Lux is what lands on the wall, so the rating and the throw are
        // said together. Twenty metres because that is where a machine mapping
        // a building tends to stand -- and it scales with the square, so half
        // the distance is four times this.
        {
          label: 'Output',
          value: `${p.lumens} lm · ${p.contrast}:1 · ${illuminanceAt(20, min, p).toFixed(0)} lux at 20 m`,
        },
      ];
    },
    /**
     * Puts the channel map on the clipboard as tab-separated text, for pasting
     * into a controller's fixture editor.
     *
     * @public
     */
    /**
     * One table row for one channel.
     *
     * @public
     * @param {Number} index 0-based channel index
     * @returns {Object}
     */
    rowAt(index) {
      const channel = this.fixture.channels.at
        ? this.fixture.channels.at(index)
        : this.fixture.channels[index];
      return {
        index: index + 1,
        name: channel.name || channel.type || 'Unset',
        function: channel.type || '—',
        isFine: !!channel.isFine,
      };
    },
    /**
     * Every channel as a row, however many there are.
     *
     * A method rather than a computed, because for a bar this is the thing
     * being avoided: it exists for Copy map, where the user has asked for the
     * full list and can wait for it.
     *
     * @public
     * @returns {Array}
     */
    allChannelRows() {
      if (!this.fixture || !this.fixture.channels) return [];
      return this.fixture.channels.map((channel, index) => ({
        index: index + 1,
        name: channel.name || channel.type || 'Unset',
        function: channel.type || '—',
        isFine: !!channel.isFine,
      }));
    },
    async copyMap() {
      const lines = [
        ['#', 'Channel', 'Function'].join('\t'),
        // The full list: Copy is where a bar's every channel is still wanted,
        // and the only place that should pay for building them.
        ...this.allChannelRows().map((row) => [
          row.index,
          row.name + (row.isFine ? ' (fine)' : ''),
          row.function,
        ].join('\t')),
      ];
      try {
        await navigator.clipboard.writeText(lines.join('\n'));
        this.copied = true;
        setTimeout(() => { this.copied = false; }, COPY_FEEDBACK_MS);
      } catch (err) {
        // Clipboard access can be refused; leaving the label alone is enough of
        // a signal that nothing was copied.
        this.copied = false;
      }
    },
  },
};
</script>

<style scoped>
.definition_home {
  padding: 6px 0 2px;
}
.definition_warning {
  font-family: Roboto-Regular;
  font-size: 11px;
  color: var(--accent-red, #d9534f);
  margin: 0;
}
.definition_ok {
  font-family: Roboto-Regular;
  font-size: 11px;
  color: var(--accent-teal);
  margin: 0;
}
/* Laid out like `bar_summary` below, because it answers the same kind of
   question about a different kind of fixture. */
.device_facts dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 10px;
  margin: 0 0 4px;
}
.device_facts dt {
  font-family: Roboto-Medium, sans-serif;
  font-size: 11px;
  color: var(--secondary-light-alt);
}
.device_facts dd {
  font-family: Roboto-Regular, sans-serif;
  font-size: 11px;
  color: var(--secondary-lighter);
  margin: 0;
}
.device_facts .fact_warning {
  color: var(--accent-red, #d9534f);
}
.fixture_guide {
  font-family: Roboto-Regular, sans-serif;
  font-size: 11px;
  color: var(--secondary-lighter);
}
.fixture_guide summary {
  font-family: Roboto-Medium, sans-serif;
  color: var(--secondary-light-alt);
  cursor: pointer;
  padding: 2px 0;
}
.fixture_guide .guide_light {
  margin: 4px 0 6px;
  white-space: normal;
}
.fixture_guide dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 3px 10px;
  margin: 0;
}
.fixture_guide dt {
  font-family: Roboto-Medium, sans-serif;
  color: var(--secondary-light-alt);
  white-space: nowrap;
}
.fixture_guide dd {
  margin: 0;
  white-space: normal;
}
.fixture_guide .guide_ranges {
  width: auto;
  border-collapse: collapse;
}
.fixture_guide .guide_ranges td {
  padding: 0 10px 1px 0;
  vertical-align: top;
  border: none;
}
.fixture_guide .guide_range {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: var(--secondary-light-alt);
  text-align: right;
}
.fixture_guide .undrawn {
  opacity: 0.55;
}
/* Narrow, like the Placement widget: the guide and the facts wrap rather
   than setting the width, and a long channel line would otherwise stretch the
   whole column. */
.fixture_model {
  max-width: 500px;
  min-width: 500px;
}
.fixture_model > :deep(.body) {
  white-space: normal;
}
.fixture_model_body {
  padding: 8px;
  min-width: 0;
}
.scope_note {
  margin: 0;
  font-size: 11px;
  color: var(--secondary-lighter-alt);
}
.save_form {
  padding: 12px;
  min-width: 320px;
}
.section_label {
  font-family: Roboto-Medium;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--secondary-lighter-alt);
}
.channel_map_header {
  align-items: center;
  border-top: 1px solid var(--primary-dark);
  padding-top: 8px;
}
.channel_map {
  /* Scrolls sideways only: the widget body carries the vertical scrollbar,
     and two nested ones make the map awkward to reach. */
  overflow-x: auto;
  border: 1px solid var(--primary-dark);
  border-radius: 3px;
}
table {
  border-collapse: collapse;
  width: 100%;
  /* Typography is set per element app-wide rather than on body, so a table
     inherits nothing and would otherwise fall back to the browser serif. */
  font-family: Roboto-Regular;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
th {
  position: sticky;
  top: 0;
  background: var(--primary-lighter);
  text-align: left;
  font-family: Roboto-Medium;
  color: var(--secondary-lighter-alt);
  padding: 4px 8px;
  white-space: nowrap;
}
td {
  padding: 3px 8px;
  border-top: 1px solid var(--primary-dark);
  color: var(--secondary-lighter);
  white-space: nowrap;
}
.num {
  text-align: right;
}
.bar_summary {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 3px 12px;
  margin: 0;
  padding: 8px;
  font-family: Roboto-Regular;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.bar_summary dt {
  color: var(--secondary-lighter-alt);
  white-space: nowrap;
}
.bar_summary dd {
  margin: 0;
  color: var(--secondary-lighter);
}
.bar_sample {
  margin-top: 6px;
}
.gap {
  text-align: center;
  color: var(--secondary-lighter-alt);
  font-style: italic;
}
.function {
  color: var(--secondary-lighter-alt);
}
.fine_tag {
  font-family: Roboto-Medium;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--accent-teal);
  margin-left: 4px;
}
</style>
