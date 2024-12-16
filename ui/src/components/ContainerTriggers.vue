<template>
  <v-list dense>
    <v-list-item v-for="trigger in triggers" :key="trigger.id">
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
    </v-list-item>
  </v-list>
</template>

<script>
import { getContainerTriggers } from "@/services/container";

export default {
  props: {
    container: {
      type: Object,
      required: true,
    },
  },
  data() {
    return {
      triggers: [],
    };
  },
  computed: {},

  methods: {},

  async created() {
    this.triggers = await getContainerTriggers(this.container.id);
  },
};
</script>
