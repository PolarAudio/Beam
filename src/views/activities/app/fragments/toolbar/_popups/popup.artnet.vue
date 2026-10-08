<template>
  <uk-popup
    v-model="state"
    :header="headerData"
    @submit="close"
    @input="update()"
  >
    <uk-flex
      class="body"
      :gap="8"
      col
    >
      <uk-flex
        :gap="8"
        col
        class="title"
      >
        <h3>DMX</h3>
        <p class="subtitle">
          Receive Art-Net and sACN and drive the visualizer from it, or send
          sACN from the fixtures' own values to test real fixtures with the
          same controls.
        </p>
      </uk-flex>

      <uk-flex center-h>
        <div>
          <h4>Mode:</h4>
          <p class="subtitle">
            {{ modeNote }}
          </p>
        </div>
        <uk-spacer />
        <uk-select-input
          :model-value="modeIndex"
          style="width: 100px"
          :options="modeLabels"
          :disabled="!available"
          @input="setMode"
        />
      </uk-flex>

      <uk-flex center-h>
        <div>
          <h4>Send as:</h4>
          <p class="subtitle">
            {{ protocolNote }}
          </p>
        </div>
        <uk-spacer />
        <uk-select-input
          :model-value="protocolIndex"
          style="width: 100px"
          :options="protocolLabels"
          :disabled="!available"
          @input="setProtocol"
        />
      </uk-flex>

      <uk-flex
        v-if="protocol === 'artnet'"
        center-h
      >
        <div>
          <h4>Send to:</h4>
          <p class="subtitle">
            An address for a node elsewhere; empty to broadcast. A program on
            this PC needs broadcast.
          </p>
        </div>
        <uk-spacer />
        <uk-txt-input
          :model-value="target"
          style="width: 140px"
          placeholder="broadcast"
          :disabled="!available"
          @update:model-value="setTarget"
        />
      </uk-flex>

      <uk-flex
        :gap="8"
        col
        class="title"
      >
        <h3>Addresses</h3>
        <p class="subtitle">
          How DMX addresses are written in Beam. Match the system you read them
          beside. Universes count from 0, as Beam counts them.
        </p>
      </uk-flex>

      <uk-flex center-h>
        <div>
          <h4>Notation:</h4>
          <p class="subtitle">
            Universe 2, channel 37 reads {{ example }}.
          </p>
        </div>
        <uk-spacer />
        <uk-select-input
          :model-value="formatIndex"
          style="width: 200px"
          :options="formatLabels"
          @input="setFormat"
        />
      </uk-flex>
    </uk-flex>
  </uk-popup>
</template>

<script>
import PopupMixin from '@/views/mixins/popup.mixin';
import EventBus from '@/plugins/eventbus';
import artnetConnection from '@/plugins/artnet.connection';
import {
  ADDRESS_FORMATS, addressFormat, setAddressFormat, formatAddress,
} from '@/models/DMX/address_format';

export default {
  name: 'ArtnetPopup',
  compatConfig: {
    MODE: 3,
  },
  mixins: [PopupMixin],
  data() {
    return {
      headerData: { title: 'Art-Net settings' },
      formatLabels: ADDRESS_FORMATS.map((f) => f.label),
      modeLabels: ['Off', 'Receive', 'Send'],
      protocolLabels: ['sACN', 'Art-Net'],
      inputEnabled: artnetConnection.inputEnabled,
      sending: artnetConnection.sending,
      protocol: artnetConnection.sendOptions.protocol,
      target: artnetConnection.sendOptions.target,
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
      if (!this.available) return 'Unavailable in the browser — run the desktop app.';
      if (this.sending) return 'Sending the fixtures\' own values. Every launch starts in Receive.';
      if (this.inputEnabled) return 'Listening for Art-Net and sACN.';
      return 'Not listening.';
    },
    formatIndex() {
      return Math.max(ADDRESS_FORMATS.findIndex((f) => f.id === addressFormat()), 0);
    },
    /** Universe 2, channel 37, in the chosen notation. */
    example() {
      return formatAddress(2 * 512 + 36);
    },
  },
  watch: {
    // Startup turns listening on after the toolbar has made this popup, so
    // what it read then is stale by the time anyone opens it.
    modelValue(open) {
      this.state = open;
      if (open) this.refresh();
    },
  },
  mounted() {
    EventBus.on('dmx_mode', this.onMode);
  },
  beforeUnmount() {
    EventBus.off('dmx_mode', this.onMode);
  },
  methods: {
    setFormat(index) {
      const chosen = ADDRESS_FORMATS[index];
      if (chosen) setAddressFormat(chosen.id);
    },
    onMode({ sending }) {
      this.sending = sending;
    },
    /** Reads the connection's state afresh, since it changes behind the popup. */
    refresh() {
      this.inputEnabled = artnetConnection.inputEnabled;
      this.sending = artnetConnection.sending;
      this.protocol = artnetConnection.sendOptions.protocol;
      this.target = artnetConnection.sendOptions.target;
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

<style scoped>
.body {
  padding: 10px;
  min-width: 460px;
  max-width: 460px;
  max-height: 50vh;
  overflow: auto;
}
.separator {
  margin: 4px 0;
  width: 100%;
}
.subtitle {
  font-family: Roboto-Regular;
  margin-bottom: 8px;
  color: var(--secondary-lighter-alt);
}
.title {
  border-bottom: 1px solid var(--primary-dark);
}
h4 {
  margin-bottom: 4px;
}
</style>
