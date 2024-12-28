<template>
  <v-card outlined>
    <v-list-item>
      <v-list-item-content>
        <v-list-item-title class="text-capitalize">
          <router-link to="/configuration/triggers">
            <a>{{ trigger.type }} {{ trigger.name }}</a>
          </router-link>
        </v-list-item-title>
        <v-list-item-subtitle
          >(threshold
          {{ trigger.configuration.threshold }})</v-list-item-subtitle
        >
      </v-list-item-content>
      <v-list-item-action>
        <v-btn
          outlined
          class="accent"
          :disabled="!updateAvailable"
          @click="runTrigger"
          :loading="isTriggering"
        >
          Run
          <v-icon right>mdi-gesture-tap</v-icon>
        </v-btn>
      </v-list-item-action>
    </v-list-item>
  </v-card>
</template>

<script>
import { runTrigger } from "@/services/container";

export default {
  props: {
    trigger: {
      type: Object,
      required: true,
    },
    updateAvailable: {
      type: Boolean,
      required: true,
    },
    containerId: {
      type: String,
      required: true,
    },
  },
  data() {
    return {
      isTriggering: false,
    };
  },
  computed: {},

  methods: {
    async runTrigger() {
      this.isTriggering = true;
      try {
        await runTrigger({
          containerId: this.containerId,
          triggerType: this.trigger.type,
          triggerName: this.trigger.name,
        });
        this.$root.$emit("notify", "Trigger executed with success");
      } catch (err) {
        this.$root.$emit(
          "notify",
          `Trigger executed with error (${err.message}})`,
          "error",
        );
      } finally {
        this.isTriggering = false;
      }
      this.isTriggering = false;
    },
  },
};
</script>
