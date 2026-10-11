<template>
  <div class="pane">
    <div class="section">
      Input and output
    </div>
    <div
      class="row"
      :title="tips.mode"
    >
      <span class="label">Mode</span>
      <uk-select-input
        class="span wide"
        :model-value="modeIndex"
        :options="modeLabels"
        :disabled="!available"
        @input="setMode"
      />
    </div>
    <p class="note">
      {{ modeNote }}
    </p>
    <div
      class="row"
      :title="protocolNote"
    >
      <span class="label">Send as</span>
      <uk-select-input
        class="span wide"
        :model-value="protocolIndex"
        :options="protocolLabels"
        :disabled="!available"
        @input="setProtocol"
      />
    </div>
    <div
      v-if="protocol === 'artnet'"
      class="row"
      :title="tips.sendTo"
    >
      <span class="label">Send to</span>
      <uk-txt-input
        class="span wide"
        :model-value="target"
        placeholder="broadcast"
        :disabled="!available"
        @update:model-value="setTarget"
      />
    </div>

    <div class="section">
      Addresses
    </div>
    <div
      class="row"
      :title="tips.notation"
    >
      <span class="label">Notation</span>
      <uk-select-input
        class="span wide"
        :model-value="formatIndex"
        :options="formatLabels"
        @input="setFormat"
      />
    </div>
    <p class="note">
      Universe 2, channel 37 reads {{ example }}.
    </p>
    <div
      class="row"
      :title="tips.strictPatch"
    >
      <span class="label">Strict patch</span>
      <uk-checkbox
        class="span"
        :model-value="strictPatch"
        @update:model-value="setStrictPatch"
      />
    </div>
  </div>
</template>

<script>
import EventBus from '@/plugins/eventbus';
import artnetConnection from '@/plugins/artnet.connection';
import PatchSingleton from '@/models/DMX/patch.model';
import Tuning from '@/plugins/visualizer/tuning';
import {
  ADDRESS_FORMATS, addressFormat, setAddressFormat, formatAddress,
} from '@/models/DMX/address_format';

/**
 * @component DMX preferences: receiving or sending Art-Net and sACN, and how
 * addresses are written and checked. Each applies at once; Cancel does not
 * undo them.
 */
export default {
  name: 'PreferencesDmxPane',
  compatConfig: {
    MODE: 3,
  },
  data() {
    return {
      /** Each row's explanation, shown as its tooltip. */
      tips: {
        mode: 'Receive Art-Net and sACN and drive the visualizer from it, or send sACN from the fixtures\' own values to test real fixtures with the same controls.',
        sendTo: 'An address for a node elsewhere; empty to broadcast. A program on this PC needs broadcast.',
        notation: 'How DMX addresses are written in Beam. Match the system you read them beside. Universes count from 0, as Beam counts them.',
        strictPatch: 'Refuse overlapping addresses, and give new or pasted fixtures the first free address. Off, any address is accepted.',
      },
      formatLabels: ADDRESS_FORMATS.map((f) => f.label),
      modeLabels: ['Off', 'Receive', 'Send'],
      protocolLabels: ['sACN', 'Art-Net'],
      inputEnabled: artnetConnection.inputEnabled,
      sending: artnetConnection.sending,
      protocol: artnetConnection.sendOptions.protocol,
      target: artnetConnection.sendOptions.target,
      strictPatch: PatchSingleton.strict,
      /** Bumped when the notation changes, which is not reactive on its own. */
      formatTick: 0,
    };
  },
  computed: {
    available() {
      return artnetConnection.available;
    },
    protocolIndex() {
      return this.protocol === 'artnet' ? 1 : 0;
    },
    protocolNote() {
      return this.protocol === 'artnet'
        ? 'Art-Net on UDP 6454.'
        : 'sACN multicast: reaches every receiver on this PC and the network.';
    },
    modeIndex() {
      if (this.sending) return 2;
      return this.inputEnabled ? 1 : 0;
    },
    modeNote() {
      if (!this.available) return 'Unavailable in the browser: run the desktop app.';
      if (this.sending) return 'Sending the fixtures\' own values. Every launch starts in Receive.';
      if (this.inputEnabled) return 'Listening for Art-Net and sACN.';
      return 'Not listening.';
    },
    formatIndex() {
      if (this.formatTick < 0) return 0;
      return Math.max(ADDRESS_FORMATS.findIndex((f) => f.id === addressFormat()), 0);
    },
    /** Universe 2, channel 37, in the chosen notation. */
    example() {
      if (this.formatTick < 0) return '';
      return formatAddress(2 * 512 + 36);
    },
  },
  mounted() {
    // Startup turns listening on after the toolbar is built, and the mode
    // changes from elsewhere, so the state is read afresh on every opening.
    this.refresh();
    EventBus.on('dmx_mode', this.onMode);
  },
  beforeUnmount() {
    EventBus.off('dmx_mode', this.onMode);
  },
  methods: {
    /** Stored under the key the debug panel used, so the setting carries over. */
    setStrictPatch(value) {
      this.strictPatch = !!value;
      Tuning.write('strictPatch', this.strictPatch, this.$show.visualizerHandle);
    },
    setFormat(index) {
      const chosen = ADDRESS_FORMATS[index];
      if (chosen) setAddressFormat(chosen.id);
      this.formatTick += 1;
    },
    onMode({ sending }) {
      this.sending = sending;
    },
    refresh() {
      this.inputEnabled = artnetConnection.inputEnabled;
      this.sending = artnetConnection.sending;
      this.protocol = artnetConnection.sendOptions.protocol;
      this.target = artnetConnection.sendOptions.target;
      this.strictPatch = PatchSingleton.strict;
    },
    async setProtocol(index) {
      this.protocol = index === 1 ? 'artnet' : 'sacn';
      await artnetConnection.setSendOptions({ protocol: this.protocol });
    },
    async setTarget(value) {
      this.target = String(value || '').trim();
      await artnetConnection.setSendOptions({ target: this.target });
    },
    async setMode(index) {
      if (index === 2) {
        await artnetConnection.setSending(true);
      } else {
        await artnetConnection.setSending(false);
        if (index === 1) {
          artnetConnection.enableInput();
        } else {
          artnetConnection.disableInput();
        }
      }
      this.refresh();
    },
  },
};
</script>

<style scoped src="./pane.css"></style>
