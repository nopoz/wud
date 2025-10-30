<template>
  <v-list density="compact">
    <v-list-item>
      <template v-slot:prepend>
        <v-icon color="secondary">mdi-tag</v-icon>
      </template>
      <v-list-item-title>Error</v-list-item-title>
      <v-list-item-subtitle>
        {{ error.message }}
      </v-list-item-subtitle>
    </v-list-item>
  </v-list>
</template>

<script>
export default {
  props: {
    error: {
      type: Object,
    },
  },
};
</script>
