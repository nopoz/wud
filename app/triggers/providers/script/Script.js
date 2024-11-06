const { exec } = require('child_process');
const Trigger = require('../Trigger');
const event = require('../../../event'); // Import event module
const storeContainer = require('../../../store/container'); // Import container store

/**
 * Script Trigger implementation
 */
class ScriptTrigger extends Trigger {
  constructor(name = 'unknown', configuration = {}) {
    super(name, configuration);
    this.name = name;

    try {
      this.configuration = this.validateConfiguration(configuration);
    } catch (error) {
      console.error('Configuration validation failed:', error);
      throw error;
    }
  }

  getConfigurationSchema() {
    return this.joi.object().keys({
      path: this.joi.string().required(),
      install: this.joi.boolean().truthy('true').falsy('false').default(false),
      timeout: this.joi.number().default(120000),
    });
  }

  async install(container) {
    console.log(`Attempting script install for container: ${container.name || 'unknown'}`);

    if (String(this.configuration.install).toLowerCase() !== 'true') {
      console.log(`Skipping install for container: ${container.name || 'unknown'} because install is not enabled.`);
      return;
    }

    // Retrieve the container from storeContainer
    const storedContainer = storeContainer.getContainer(container.id);
    if (!storedContainer) {
      console.warn(`Container with ID ${container.id} not found in store.`);
      throw new Error(`No such container: ${container.id}`);
    }

    // Emit start notification
    this.setContainerNotification(storedContainer, `Update started for ${storedContainer.name}`, 'info');

    try {
      // Check if the container is running
      this.checkContainerRunning(storedContainer);

      // Get the current image ID before the update
      const previousImageId = this.getContainerImageId(storedContainer);
      console.log(`Previous image ID for ${storedContainer.name}: ${previousImageId}`);

      // Execute the script to update the container
      await this.executeScript(storedContainer, 'install');
      console.log(`Successfully executed script for container: ${storedContainer.name || 'unknown'}`);

      // Wait for the container to be updated
      await this.waitForContainerImageUpdate(storedContainer, previousImageId);
      console.log(`Container ${storedContainer.name || 'unknown'} has been updated to a new image`);

      // Emit event to trigger watcher to re-scan containers
      event.emitTriggerWatch();
      console.log('Emitted trigger_watch event to re-scan containers');

      // Wait for the watcher to complete the watch process
      await this.waitForWatcherToComplete();
      console.log('Watcher has completed scanning containers');

      // Set success notification on container
      this.setContainerNotification(storedContainer, `Update for ${storedContainer.name} completed successfully.`, 'success');

      return { success: true, message: `Update for ${storedContainer.name} completed successfully.` };
    } catch (error) {
      console.error(`Error during install for container ${storedContainer.name || 'unknown'}: ${error.message}`);
      // Set error notification on container
      this.setContainerNotification(storedContainer, `Update for ${storedContainer.name} failed: ${error.message}`, 'error');
      return { success: false, message: `Update for ${storedContainer.name} failed: ${error.message}` };
    }
  }

  checkContainerRunning(container) {
    if (!container) {
      throw new Error(`No such container: ${container.id}`);
    }
    if (container.status !== 'running') {
      throw new Error(`Container ${container.id} is not running: ${container.status}`);
    }
    console.log(`Container ${container.id} is running.`);
  }

  getContainerImageId(container) {
    if (!container) {
      throw new Error(`No such container: ${container.id}`);
    }
    return container.image.id; // Adjust field access as needed
  }

  async waitForContainerImageUpdate(container, previousImageId) {
    const timeout = 60000; // 60 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const updatedContainer = storeContainer.getContainer(container.id);
      if (updatedContainer.image.id !== previousImageId) {
        console.log(`Container ${container.name} has been updated.`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds before checking again
    }

    throw new Error(`Timeout waiting for container ${container.name} to update.`);
  }

  setContainerNotification(container, message, level) {
    const storedContainer = storeContainer.getContainer(container.id);
    if (storedContainer) {
      storedContainer.notification = { message, level };
      storeContainer.updateContainer(storedContainer);
    } else {
      console.warn(`Container with ID ${container.id} not found in store. Cannot set notification.`);
    }
  }

  async waitForWatcherToComplete(timeout = 60000) {
    return new Promise((resolve, reject) => {
      const onWatcherStop = () => {
        clearTimeout(timer); // Clear the timeout
        event.unregisterWatcherStop(onWatcherStop); // Remove the listener
        resolve();
      };

      event.registerWatcherStop(onWatcherStop);

      const timer = setTimeout(() => {
        event.unregisterWatcherStop(onWatcherStop);
        reject(new Error('Timeout waiting for watcher to complete'));
      }, timeout);
    });
  }

  executeScript(container, actionType) {
    const { path, timeout } = this.configuration;
    const name = container.name || 'unknown';
    const fullImageName = container.image.name || 'unknown';
    const imageNameParts = fullImageName.split('/');
    const imageName = imageNameParts[imageNameParts.length - 1];
    const localValue = container.updateKind?.localValue || 'unknown';
    const remoteValue = container.updateKind?.remoteValue || 'unknown';
    const watcher = container.watcher || 'unknown';
    const command = `${path} ${name} ${imageName} ${localValue} ${remoteValue} ${watcher}`;

    console.log(`Executing script: ${command}`);

    return new Promise((resolve, reject) => {
      const process = exec(command, { timeout }, (error, stdout, stderr) => {
        if (error) {
          console.error(`Script execution failed: ${stderr}`);
          return reject(error);
        }
        resolve(stdout);
      });

      process.on('error', (error) => {
        console.error(`Process error: ${error.message}`);
        reject(error);
      });

      process.stdout?.on('data', (data) => {
        console.log(`Script stdout: ${data}`);
      });

      process.stderr?.on('data', (data) => {
        console.error(`Script stderr: ${data}`);
      });

      process.on('close', (code) => {
        if (code !== 0) {
          const message = `Script exited with code ${code}`;
          console.error(message);
          reject(new Error(message));
        }
      });
    });
  }
}

module.exports = ScriptTrigger;
