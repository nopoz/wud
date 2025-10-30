<template>
  <v-snackbar
    v-model="showLocal"
    :timeout="timeout"
    color="primary"
    variant="outlined"
  >
    {{ message }}
    <template v-slot:actions>
      <v-btn variant="text" @click="closeSnackbar">Close</v-btn>
    </template>
  </v-snackbar>
</template>

<script>
export default {
  props: {
    show: {
      type: Boolean,
      default: false,
    },
    timeout: {
      type: Number,
      default: 4000,
    },
    message: {
      type: String,
      required: true,
    },
    level: {
      type: String,
      default: "info",
    },
  },

  computed: {
    showLocal: {
      get() {
        return this.show;
      },
      set(value) {
        if (!value) {
          this.closeSnackbar();
        }
      }
    }
  },

  methods: {
    closeSnackbar() {
      this.$eventBus.emit("notify:close");
    },
  },
};
</script>
