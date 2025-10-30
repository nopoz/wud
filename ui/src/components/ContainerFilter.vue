<template>
  <v-container fluid class="ma-0 mb-3 pa-md-0">
    <v-row dense>
      <v-col>
        <v-select
          :hide-details="true"
          v-model="watcherSelected"
          :items="watchers"
          @update:modelValue="emitWatcherChanged"
          :clearable="true"
          label="Watcher"
          variant="outlined"
          density="compact"
        ></v-select>
      </v-col>
      <v-col>
        <v-select
          :hide-details="true"
          v-model="registrySelected"
          :items="registries"
          @update:modelValue="emitRegistryChanged"
          :clearable="true"
          label="Registry"
          variant="outlined"
          density="compact"
        ></v-select>
      </v-col>
      <v-col>
        <v-select
          :hide-details="true"
          v-model="updateKindSelected"
          :items="updateKinds"
          @update:modelValue="emitUpdateKindChanged"
          :clearable="true"
          label="Update kind"
          variant="outlined"
          density="compact"
        ></v-select>
      </v-col>

      <v-col>
        <v-autocomplete
          label="Group by label"
          :items="groupLabels"
          v-model="groupByLabelLocal"
          @update:modelValue="emitGroupByLabelChanged"
          clearable
          variant="outlined"
          density="compact"
        >
        </v-autocomplete>
      </v-col>
      <v-col>
        <v-switch
          class="switch-top"
          label="Update available"
          v-model="updateAvailableLocal"
          @update:modelValue="emitUpdateAvailableChanged"
          :hide-details="true"
          density="compact"
        />
      </v-col>
      <v-col>
        <v-switch
          class="switch-top"
          label="Oldest first"
          v-model="oldestFirstLocal"
          @update:modelValue="emitOldestFirstChanged"
          :hide-details="true"
          density="compact"
        />
      </v-col>
      <v-col class="text-right">
        <v-btn
          color="secondary"
          @click.stop="refreshAllContainers"
          :loading="isRefreshing"
        >
          Watch now
          <v-icon> mdi-refresh</v-icon>
        </v-btn>
        <br />
      </v-col>
    </v-row>
  </v-container>
</template>

<script>
import { refreshAllContainers } from "@/services/container";

export default {
  props: {
    registries: {
      type: Array,
      required: true,
    },
    registrySelectedInit: {
      type: String,
      required: true,
    },
    watchers: {
      type: Array,
      required: true,
    },
    watcherSelectedInit: {
      type: String,
      required: true,
    },
    updateKinds: {
      type: Array,
      required: true,
    },
    updateKindSelectedInit: {
      type: String,
      required: true,
    },
    updateAvailable: {
      type: Boolean,
      required: true,
    },
    oldestFirst: {
      type: Boolean,
      required: true,
    },
    groupLabels: {
      type: Array,
      required: true,
    },
    groupByLabel: {
      type: String,
      required: false,
    },
  },

  data() {
    return {
      isRefreshing: false,
      registrySelected: "",
      watcherSelected: "",
      updateKindSelected: "",
      updateAvailableLocal: this.updateAvailable,
      oldestFirstLocal: this.oldestFirst,
      groupByLabelLocal: this.groupByLabel,
    };
  },

  methods: {
    emitRegistryChanged() {
      this.$emit("registry-changed", this.registrySelected ?? "");
    },
    emitWatcherChanged() {
      this.$emit("watcher-changed", this.watcherSelected ?? "");
    },
    emitUpdateKindChanged() {
      this.$emit("update-kind-changed", this.updateKindSelected ?? "");
    },
    emitUpdateAvailableChanged() {
      this.$emit("update-available-changed");
    },
    emitOldestFirstChanged() {
      this.$emit("oldest-first-changed");
    },
    emitGroupByLabelChanged(newLabel) {
      this.$emit("group-by-label-changed", newLabel ?? "");
    },
    async refreshAllContainers() {
      this.isRefreshing = true;
      try {
        const body = await refreshAllContainers();
        this.$eventBus.emit("notify", "All containers refreshed");
        this.$emit("refresh-all-containers", body);
      } catch (e) {
        this.$eventBus.emit(
          "notify",
          `Error when trying to refresh all containers (${e.message})`,
          "error",
        );
      } finally {
        this.isRefreshing = false;
      }
    },
  },

  async beforeUpdate() {
    this.registrySelected = this.registrySelectedInit;
    this.watcherSelected = this.watcherSelectedInit;
    this.updateKindSelected = this.updateKindSelectedInit;
    this.updateAvailableLocal = this.updateAvailable;
    this.oldestFirstLocal = this.oldestFirst;
    this.groupByLabelLocal = this.groupByLabel;
  },
};
</script>

<style scoped>
.switch-top {
  margin-top: 4px;
}
</style>
