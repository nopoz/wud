<template>
  <v-dialog
    v-model="dialogVisible"
    max-width="800px"
    @click:outside="close"
    persistent
  >
    <v-card dark>
      <div style="background-color: #1E1E1E;">
        <div class="d-flex justify-end pa-2" style="background-color: #2D2D2D;">
          <v-btn
            icon
            x-small
            @click="close"
            v-if="!isComplete && !error"
          >
            <v-icon>mdi-close</v-icon>
          </v-btn>
        </div>

        <v-card-text class="pa-2">
          <pre ref="logContainer" class="log-output"><template v-for="(log, index) in logs"><span :key="index" :class="getLogClass(log)">{{log.message}}</span></template><span v-if="error" class="error-text">Error: {{ error }}</span><span v-if="isComplete" class="success-text">
Script execution complete</span></pre>
        </v-card-text>

        <v-card-actions v-if="isComplete || error" class="pa-4" style="background-color: #2D2D2D;">
          <v-spacer></v-spacer>
          <v-btn
            color="primary"
            @click="handleClose"
          >
            {{ error ? 'Close' : 'Close Script Output' }}
          </v-btn>
        </v-card-actions>
      </div>
    </v-card>
  </v-dialog>
</template>

<script>
export default {
  name: 'ScriptOutputDialog',
  
  props: {
    value: {
      type: Boolean,
      default: false
    },
    containerId: {
      type: String,
      required: true
    }
  },

  data() {
    return {
      logs: [],
      error: null,
      isComplete: false,
      eventSource: null,
      connectionAttempts: 0,
      maxRetries: 3,
      retryDelay: 500,
      connected: false,
      firstConnectionEstablished: false
    };
  },

  computed: {
    dialogVisible: {
      get() {
        return this.value;
      },
      set(value) {
        this.$emit('input', value);
      }
    }
  },

  watch: {
    value(newVal) {
      if (newVal) {
        this.connectionAttempts = 0;
        this.firstConnectionEstablished = false;
        // Add a small delay before first connection attempt
        setTimeout(() => {
          this.connectToEventStream();
        }, 500);
      } else {
        this.disconnectEventStream();
      }
    },
    isComplete(newVal) {
      console.log('isComplete changed to:', newVal);
      if (newVal) {
        console.log('Completion detected in watcher');
        // Give a small delay before allowing closure
        setTimeout(() => {
          this.disconnectEventStream();
        }, 500);
      }
    }
  },

  methods: {
    handleClose() {
      this.dialogVisible = false;
      this.disconnectEventStream();
      if (this.isComplete && !this.error) {
        this.$emit('update-complete');
      }
    },

    close() {
      // Only allow closing via X button if not complete
      if (!this.isComplete && !this.error) {
        this.dialogVisible = false;
        this.disconnectEventStream();
      }
    },

    handleComplete() {
      console.log('Script execution complete');
      this.isComplete = true;
      this.disconnectEventStream();
    },

    connectToEventStream() {
      if (this.eventSource) {
        this.disconnectEventStream();
      }

      this.error = null;
      if (!this.firstConnectionEstablished) {
        this.logs = [];
        this.isComplete = false;
      }

      try {
        this.eventSource = new EventSource(`/api/containers/${this.containerId}/install/logs`);
        
        this.eventSource.onopen = () => {
          this.error = null;
          this.firstConnectionEstablished = true;
          this.connectionAttempts = 0;
        };
        
        this.eventSource.onmessage = (event) => {
          try {
            const logData = JSON.parse(event.data);
            // Look for script completion in the message
            if (logData.message && (
              logData.message.includes('SCRIPT EXECUTION END') ||
              logData.message.includes('Successfully executed script')
            )) {
              this.handleComplete();
            }
            this.logs.push(logData);
            this.scrollToBottom();
          } catch (err) {
            console.error('Error parsing log data:', err);
          }
        };

        this.eventSource.addEventListener('complete', () => {
          this.handleComplete();
        });

        this.eventSource.onerror = () => {
          if (!this.isComplete) {
            this.connectionAttempts++;
            
            if (this.connectionAttempts < this.maxRetries) {
              setTimeout(() => {
                this.disconnectEventStream();
                this.connectToEventStream();
              }, this.retryDelay);
              this.retryDelay *= 2;
            } else {
              this.error = 'Unable to connect to log stream. Script is still running in the background.';
              this.disconnectEventStream();
            }
          }
        };

      } catch (err) {
        console.error('Error setting up EventSource:', err);
        this.error = 'Failed to connect to log stream';
      }
    },

    disconnectEventStream() {
      console.log('Disconnecting event stream');
      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }
    },

    scrollToBottom() {
      this.$nextTick(() => {
        if (this.$refs.logContainer) {
          this.$refs.logContainer.scrollTop = this.$refs.logContainer.scrollHeight;
        }
      });
    },

    getLogClass(log) {
      const message = log.message || '';
      
      // Use pre tag's native formatting with custom classes
      if (message.match(/^#{3,}/) || message.includes('------------------------------------------------------------------------------')) {
        return 'divider-text';
      }
      
      if (message.includes('SCRIPT EXECUTION START') ||
          message.includes('Command Parameters:') ||
          message.includes('Script Output:') ||
          message.includes('Execution Summary:')) {
        return 'header-text';
      }
      
      if (message.includes('successfully') ||
          message.includes('Status: Success') ||
          message.includes('SCRIPT EXECUTION END')) {
        return 'success-text';
      }
      
      if (message.match(/^#\s+\[.*?\]/)) {
        return 'command-text';
      }
      
      if (message.includes('WARNING:') || message.includes('WARN:')) {
        return 'warning-text';
      }
      
      if (message.includes('ERROR:')) {
        return 'error-text';
      }
      
      return ''; // Default terminal white
    }
  },

  beforeDestroy() {
    this.disconnectEventStream();
  }
};
</script>

<style scoped>
.log-output {
  background-color: #1E1E1E;
  color: #FFFFFF;
  font-family: monospace;
  white-space: pre;
  height: 400px;
  overflow-y: auto;
  border: 1px solid #333333;
  border-radius: 4px;
  padding: 12px;
  margin: 0;
  line-height: 1.2;
}

.log-output span {
  white-space: pre;
}

/* Clean slate - remove Vuetify's color overrides */
.log-output >>> .v-application {
  color: inherit !important;
}

/* More vibrant ANSI-style colors */
.log-output .header-text {
  color: #F5F5F5 !important;  /* Much lighter grey for headers */
}

.log-output .command-text {
  color: #00FFFF !important;  /* Bright cyan for commands */
}

.log-output .success-text {
  color: #00FF00 !important;  /* Bright green for success */
}

.log-output .warning-text {
  color: #FFD700 !important;  /* Bright gold for warnings */
}

.log-output .error-text {
  color: #FF4444 !important;  /* Bright red for errors */
}

.log-output .divider-text {
  color: #BDBDBD !important;  /* Lighter grey for dividers */
}


/* Scrollbar styling */
.log-output::-webkit-scrollbar {
  width: 8px;
}

.log-output::-webkit-scrollbar-track {
  background: #2D2D2D;
}

.log-output::-webkit-scrollbar-thumb {
  background: #555;
  border-radius: 4px;
}

.log-output::-webkit-scrollbar-thumb:hover {
  background: #666;
}

/* Override Vuetify's default card background */
::v-deep .v-card {
  background-color: #1E1E1E !important;
}

::v-deep .v-card > .v-card__text {
  padding: 8px;
}
</style>