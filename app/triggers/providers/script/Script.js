const { exec } = require('child_process');
const Trigger = require('../Trigger');
const event = require('../../../event');
const storeContainer = require('../../../store/container');

/**
 * Script Trigger implementation
 */
class ScriptTrigger extends Trigger {
  /**
   * Get the Trigger configuration schema.
   * @returns {*}
   */

  constructor(name, configuration) {
  super(name, configuration);
  this.name = name;
  this.configuration = this.validateConfiguration(configuration);
  }

  getConfigurationSchema() {
    return this.joi.object().keys({
      path: this.joi.string().required(),
      install: this.joi.boolean().truthy('true').falsy('false').default(false),
      timeout: this.joi.number().default(300000),
    });
  }

  async install(container) {
      console.log(`Attempting script install for container: ${container.name || 'unknown'}`);

      if (String(this.configuration.install).toLowerCase() !== 'true') {
          console.log(`Skipping install for container: ${container.name || 'unknown'} because install is not enabled.`);
          return;
      }

      const storedContainer = storeContainer.getContainer(container.id);
      if (!storedContainer) {
          console.warn(`Container with ID ${container.id} not found in store.`);
          throw new Error(`No such container: ${container.id}`);
      }

      this.setContainerNotification(storedContainer, `Update started for ${storedContainer.name}`, 'info');

      try {
          const previousImageId = this.getContainerImageId(storedContainer);
          const oldContainerId = storedContainer.id;
          console.log(`Previous image ID for ${storedContainer.name}: ${previousImageId}`);

          // Clean up any existing containers with same name before starting
          await this.cleanupExistingContainers(storedContainer);

          await this.executeScript(storedContainer, 'install');
          console.log(`Successfully executed script for container: ${storedContainer.name || 'unknown'}`);

          // Wait for new container
          const newContainer = await this.waitForContainerImageUpdate(storedContainer, previousImageId);
          console.log(`Container ${storedContainer.name || 'unknown'} has been updated to a new image`);

          // Do another cleanup after update
          await this.cleanupExistingContainers(newContainer, [newContainer.id]);

          // Trigger watch and wait for completion
          event.emitTriggerWatch();
          console.log('Emitted trigger_watch event to re-scan containers');

          await this.waitForWatcherToComplete();
          console.log('Watcher has completed scanning containers');

          // Validate the state after watch completion
          const finalContainers = storeContainer.getContainers({ name: container.name, watcher: container.watcher });
          if (finalContainers.length > 1) {
              console.warn(`Multiple containers detected after update for ${container.name}. Triggering additional cleanup.`);
              await this.cleanupExistingContainers(container, finalContainers.map(c => c.id));
          }

          return { 
              success: true, 
              message: `Update for ${storedContainer.name} completed successfully.`,
              newContainerId: newContainer.id 
          };
      } catch (error) {
          console.error(`Error during install for container ${storedContainer.name || 'unknown'}: ${error.message}`);
          this.setContainerNotification(storedContainer, `Update for ${storedContainer.name} failed: ${error.message}`, 'error');
          return { 
              success: false, 
              message: `Update for ${storedContainer.name} failed: ${error.message}` 
          };
      }
  }

  async cleanupExistingContainers(container, excludeIds = []) {
      console.log(`Cleaning up existing containers for ${container.name}`);
      
      const MAX_RETRIES = 3;
      let attempts = 0;

      while (attempts < MAX_RETRIES) {
          const containers = storeContainer.getContainers({ 
              name: container.name,
              watcher: container.watcher 
          });

          for (const existingContainer of containers) {
              if (!excludeIds.includes(existingContainer.id)) {
                  try {
                      console.log(`Attempting to delete container ${existingContainer.id} for ${container.name}`);
                      storeContainer.deleteContainer(existingContainer.id);
                  } catch (err) {
                      console.warn(`Failed to delete container ${existingContainer.id}: ${err.message}`);
                  }
              }
          }

          const remainingContainers = storeContainer.getContainers({
              name: container.name,
              watcher: container.watcher,
          });

          if (remainingContainers.length === 0) {
              console.log(`All old containers for ${container.name} have been cleaned up.`);
              break;
          } else {
              console.log(`Retry cleanup, ${remainingContainers.length} containers remain for ${container.name}`);
          }

          attempts += 1;
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait before retry
      }

      if (attempts === MAX_RETRIES) {
          console.warn(`Max retries reached for cleaning up old containers for ${container.name}. Some containers may still remain.`);
      }
  }

  getContainerImageId(container) {
    if (!container) {
      throw new Error(`No such container: ${container.id}`);
    }
    return container.image.id;
  }

  async waitForContainerImageUpdate(container, previousImageId) {
    const timeout = this.configuration.timeout || 300000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
        // Get all containers with this name and correct watcher
        const containers = storeContainer.getContainers({ 
            name: container.name,
            watcher: container.watcher 
        });
        
        console.log(`Found ${containers.length} containers with name ${container.name}`);
        
        // Look for a running container with a different image ID
        const newContainer = containers.find(c => 
            c.status === 'running' && 
            c.image && 
            c.image.id !== previousImageId &&
            c.watcher === container.watcher
        );

        if (newContainer) {
            console.log(`Found new running container ${newContainer.id} with updated image`);
            
            // Double check no other containers exist
            const otherContainers = containers.filter(c => c.id !== newContainer.id);
            if (otherContainers.length > 0) {
                console.log(`Found ${otherContainers.length} other containers, cleaning up before proceeding`);
                await this.cleanupExistingContainers(container, [newContainer.id]);
            }
            
            return newContainer;
        }

        console.log(`Container ${container.name} not yet updated. Retrying...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    throw new Error(`Timeout waiting for container ${container.name} to update.`);
  }

  setContainerNotification(container, message, level) {
    const updatedContainer = storeContainer.getContainers({ name: container.name })[0];
    if (updatedContainer) {
      updatedContainer.notification = { message, level };
      storeContainer.updateContainer(updatedContainer);
    } else {
      console.warn(`Container ${container.name} (ID: ${container.id || 'unknown'}) not found in store. Cannot set notification.`);
    }
  }

  async waitForWatcherToComplete(timeout = 60000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        event.unregisterWatcherStop(onWatcherStop);
        reject(new Error('Timeout waiting for watcher to complete'));
      }, timeout);

      const onWatcherStop = () => {
        clearTimeout(timer);
        event.unregisterWatcherStop(onWatcherStop);
        resolve();
      };

      event.registerWatcherStop(onWatcherStop);
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
    const compose_project = container.compose_project || 'unknown';
    const shellEscape = require('shell-escape');
    const command = shellEscape([path, name, imageName, localValue, remoteValue, watcher, compose_project]);

    console.log(`Executing script: ${command}`);

    return new Promise((resolve, reject) => {
      const process = exec(command, { timeout }, (error, stdout, stderr) => {
        if (error) {
          if (error.killed && error.signal === 'SIGTERM') {
            const timeoutMessage = `Script execution timed out after ${timeout} ms`;
            console.error(timeoutMessage);
            return reject(new Error(timeoutMessage));
          } else {
            console.error(`Script execution failed: ${error.message}`);
            return reject(error);
          }
        }
        resolve(stdout);
      });

      let stdoutBuffer = '';
      let stderrBuffer = '';

      process.stdout?.on('data', (data) => {
        stdoutBuffer += data;
      });

      process.stderr?.on('data', (data) => {
        stderrBuffer += data;
      });

      process.on('close', (code, signal) => {
        if (stdoutBuffer.trim()) {
          console.log(`\n--- Script Output (${container.name}) ---\n${stdoutBuffer.trim()}\n--- End Output ---`);
        } else {
          console.log(`\n--- Script Output (${container.name}) ---\n(No output)\n--- End Output ---`);
        }

        if (stderrBuffer.trim()) {
          console.error(`\n--- Script Errors (${container.name}) ---\n${stderrBuffer.trim()}\n--- End Errors ---`);
        }

        if (code !== 0 && code !== null) {
          const message = `Script for ${container.name} exited with code ${code}`;
          console.error(message);
          reject(new Error(message));
        } else if (signal) {
          const message = `Script for ${container.name} was terminated by signal ${signal}`;
          console.error(message);
          reject(new Error(message));
        } else {
          resolve(stdoutBuffer.trim());
        }
      });
    });
  }
}

module.exports = ScriptTrigger;