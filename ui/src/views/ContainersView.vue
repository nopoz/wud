<template>
  <v-container fluid>
    <v-row dense>
      <v-col>
        <container-filter
          :registries="registries"
          :registry-selected-init="registrySelected"
          :watchers="watchers"
          :watcher-selected-init="watcherSelected"
          :update-kinds="updateKinds"
          :update-kind-selected-init="updateKindSelected"
          :updateAvailable="updateAvailableSelected"
          :groupByLabel="groupByLabel"
          :groupLabels="allContainerLabels"
          @registry-changed="onRegistryChanged"
          @watcher-changed="onWatcherChanged"
          @update-available-changed="onUpdateAvailableChanged"
          @group-by-label-changed="onGroupByLabelChanged"
          @update-kind-changed="onUpdateKindChanged"
          @refresh-all-containers="onRefreshAllContainers"
        />
      </v-col>
    </v-row>
    <v-fade-transition group hide-on-leave mode="in-out">
      <template v-for="(container, index) in containersFiltered">
        <v-row :key="container.id">
          <v-col class="pt-2 pb-2">
            <container-item
              :groupingLabel="groupByLabel"
              :previousContainer="containersFiltered[index - 1]"
              :container="container"
              @delete-container="deleteContainer(container)"
              @container-deleted="removeContainerFromList(container)"
            />
          </v-col>
        </v-row>
      </template>
    </v-fade-transition>
    <v-row v-if="containersFiltered.length === 0">
      <v-card-subtitle class="text-h6">No containers found</v-card-subtitle>
    </v-row>
  </v-container>
</template>

<script>
import ContainerItem from "@/components/ContainerItem";
import ContainerFilter from "@/components/ContainerFilter";
import { deleteContainer, getAllContainers } from "@/services/container";

export default {
  components: {
    ContainerItem,
    ContainerFilter,
  },

  data() {
    return {
      containers: [],
      registrySelected: "",
      watcherSelected: "",
      updateKindSelected: "",
      updateAvailableSelected: false,
      groupByLabel: "",
    };
  },
  watch: {},
  computed: {
    allContainerLabels() {
      return this.containers.reduce((acc, container) => {
        return [...acc, ...Object.keys(container.labels ?? {})];
      }, []);
    },
    registries() {
      return [
        ...new Set(
          this.containers
            .map((container) => container.image.registry.name)
            .sort(),
        ),
      ];
    },
    watchers() {
      return [
        ...new Set(
          this.containers.map((container) => container.watcher).sort(),
        ),
      ];
    },
    updateKinds() {
      return [
        ...new Set(
          this.containers
            .filter((container) => container.updateAvailable)
            .filter((container) => container.updateKind.kind === "tag")
            .filter((container) => container.updateKind.semverDiff)
            .map((container) => container.updateKind.semverDiff)
            .sort(),
        ),
      ];
    },
    containersFiltered() {
      const filteredContainers = this.containers
        .filter((container) =>
          this.registrySelected
            ? this.registrySelected === container.image.registry.name
            : true,
        )
        .filter((container) =>
          this.watcherSelected
            ? this.watcherSelected === container.watcher
            : true,
        )
        .filter((container) =>
          this.updateKindSelected
            ? this.updateKindSelected ===
              (container.updateKind && container.updateKind.semverDiff)
            : true,
        )
        .filter((container) =>
          this.updateAvailableSelected ? container.updateAvailable : true,
        )
        .sort((a, b) => {
          if (this.groupByLabel) {
            if (
              a.labels?.[this.groupByLabel] &&
              !b.labels?.[this.groupByLabel]
            ) {
              return -1;
            }
            if (
              b.labels?.[this.groupByLabel] &&
              !a.labels?.[this.groupByLabel]
            ) {
              return 1;
            }
            if (
              a.labels?.[this.groupByLabel] &&
              b.labels?.[this.groupByLabel]
            ) {
              return a.labels?.[this.groupByLabel].localeCompare(
                b.labels?.[this.groupByLabel],
              );
            }
            return a.displayName.localeCompare(b.displayName);
          }
          return a.displayName.localeCompare(b.displayName);
        });
      return filteredContainers;
    },
  },

  methods: {
    onRegistryChanged(registrySelected) {
      this.registrySelected = registrySelected;
      this.updateQueryParams();
    },
    onWatcherChanged(watcherSelected) {
      this.watcherSelected = watcherSelected;
      this.updateQueryParams();
    },
    onUpdateAvailableChanged() {
      this.updateAvailableSelected = !this.updateAvailableSelected;
      this.updateQueryParams();
    },
    onGroupByLabelChanged(groupByLabel) {
      this.groupByLabel = groupByLabel;
      this.updateQueryParams();
    },
    onUpdateKindChanged(updateKindSelected) {
      this.updateKindSelected = updateKindSelected;
      this.updateQueryParams();
    },
    updateQueryParams() {
      const query = {};
      if (this.registrySelected) {
        query["registry"] = this.registrySelected;
      }
      if (this.watcherSelected) {
        query["watcher"] = this.watcherSelected;
      }
      if (this.updateKindSelected) {
        query["update-kind"] = this.updateKindSelected;
      }
      if (this.updateAvailableSelected) {
        query["update-available"] = this.updateAvailableSelected;
      }
      if (this.groupByLabel) {
        query["group-by-label"] = this.groupByLabel;
      }
      this.$router.push({ query });
    },
    onRefreshAllContainers(containersRefreshed) {
      this.containers = containersRefreshed;
    },
    removeContainerFromList(container) {
      this.containers = this.containers.filter((c) => c.id !== container.id);
    },
    async deleteContainer(container) {
      try {
        await deleteContainer(container.id);
        this.removeContainerFromList(container);
      } catch (e) {
        this.$root.$emit(
          "notify",
          `Error when trying to delete the container (${e.message})`,
          "error",
        );
      }
    },
  },

  async beforeRouteEnter(to, from, next) {
    const registrySelected = to.query["registry"];
    const watcherSelected = to.query["watcher"];
    const updateKindSelected = to.query["update-kind"];
    const updateAvailable = to.query["update-available"];
    const groupByLabel = to.query["group-by-label"];
    try {
      const containers = await getAllContainers();
      next((vm) => {
        if (registrySelected) {
          vm.registrySelected = registrySelected;
        }
        if (watcherSelected) {
          vm.watcherSelected = watcherSelected;
        }
        if (updateKindSelected) {
          vm.updateKindSelected = updateKindSelected;
        }
        if (updateAvailable) {
          vm.updateAvailableSelected = updateAvailable.toLowerCase() === "true";
        }
        if (groupByLabel) {
          vm.groupByLabel = groupByLabel;
        }
        vm.containers = containers;
      });
    } catch (e) {
      this.$root.$emit(
        "notify",
        `Error when trying to get the containers (${e.message})`,
        "error",
      );
    }
    next();
  },
};
</script>
