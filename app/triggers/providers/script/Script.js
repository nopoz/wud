const { exec } = require('child_process');
const shell = require('shell-escape');
const Trigger = require('../Trigger');
const event = require('../../../event');
const storeContainer = require('../../../store/container');

/**
 * Script Trigger implementation
 */
class ScriptTrigger extends Trigger {
    /**
     * Constructor
     * @param {string} name - Name of the trigger
     * @param {Object} configuration - Configuration object
     */
    constructor(name, configuration) {
        super(name, configuration);
        this.name = name;
        this.configuration = this.validateConfiguration(configuration);
    }

    /**
     * Get the Trigger configuration schema.
     * @returns {*}
     */
    getConfigurationSchema() {
        return this.joi.object().keys({
            path: this.joi.string().required(),
            install: this.joi.boolean().truthy('true').falsy('false').default(false),
            timeout: this.joi.number().default(300000),
        });
    }

    /**
     * Trigger notification for a single container
     * @param {Object} container the container object
     * @returns {Promise<void>}
     */
    async trigger(container) {
        if (String(this.configuration.install).toLowerCase() === 'true') {
            this.log.debug(`Skipping trigger action for ${this.name} because install is enabled`);
            return;
        }

        await this.executeScript(container, 'trigger');
    }

    /**
     * Explicitly disable batch operations
     * @param {Array} containers array of container objects
     * @returns {Promise<void>}
     */
    async triggerBatch(containers) {
        this.log.warn('Batch operations are not supported by the Script trigger - use individual container triggers instead');
        return;
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

            // Track if we actually need to do any cleanup this iteration
            let cleanupNeeded = false;

            for (const existingContainer of containers) {
                if (!excludeIds.includes(existingContainer.id)) {
                    try {
                        cleanupNeeded = true;
                        console.log(`Attempting to delete container ${existingContainer.id} for ${container.name}`);
                        await storeContainer.deleteContainer(existingContainer.id);
                        
                        // Verify the deletion
                        const stillExists = storeContainer.getContainer(existingContainer.id);
                        if (stillExists) {
                            console.warn(`Container ${existingContainer.id} still exists after deletion attempt`);
                        } else {
                            console.log(`Successfully removed container ${existingContainer.id}`);
                        }
                    } catch (err) {
                        console.warn(`Failed to delete container ${existingContainer.id}: ${err.message}`);
                    }
                }
            }

            // If no cleanup was needed, we can exit early
            if (!cleanupNeeded) {
                console.log(`No cleanup needed for ${container.name}`);
                break;
            }

            // Verify the current state
            const remainingContainers = storeContainer.getContainers({
                name: container.name,
                watcher: container.watcher,
            }).filter(c => !excludeIds.includes(c.id));

            if (remainingContainers.length === 0) {
                console.log(`All old containers for ${container.name} have been cleaned up.`);
                break;
            } else {
                console.log(`Retry cleanup needed, ${remainingContainers.length} containers remain for ${container.name}:`, 
                    remainingContainers.map(c => `${c.id} (${c.status})`).join(', '));
            }

            attempts += 1;
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait before retry
        }

        if (attempts === MAX_RETRIES) {
            console.warn(`Max retries reached for cleaning up old containers for ${container.name}. Some containers may still remain.`);
            const remainingContainers = storeContainer.getContainers({
                name: container.name,
                watcher: container.watcher,
            }).filter(c => !excludeIds.includes(c.id));
            
            if (remainingContainers.length > 0) {
                console.warn('Remaining containers:', remainingContainers.map(c => 
                    `${c.id} (${c.status})`).join(', '));
            }
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
            
            if (containers.length === 0) {
                console.log(`Found 0 containers with name ${container.name}`);
            } else {
                console.log(`Found ${containers.length} container(s) with name ${container.name}:`);
                containers.forEach(c => {
                    console.log(`  ID: ${c.id}`);
                    console.log(`  Status: ${c.status}`);
                    console.log(`  Image ID: ${c.image?.id || 'unknown'}`);
                    console.log(`  Watcher: ${c.watcher}`);
                });
            }
            
            // Look for a running container with a different image ID
            const newContainer = containers.find(c => 
                c.status === 'running' && 
                c.image && 
                c.image.id !== previousImageId &&
                c.watcher === container.watcher
            );

            if (newContainer) {
                console.log(`Found new running container ${newContainer.id} with updated image`);
                
                try {
                    // Get fresh container details from Docker
                    const dockerContainer = await this.dockerApi.getContainer(newContainer.id).inspect();
                    
                    // Initialize the container with all metadata
                    const updatedContainer = await this.addImageDetailsToContainer(
                        {
                            Id: newContainer.id,
                            Image: dockerContainer.Image,
                            Names: [newContainer.name],
                            State: dockerContainer.State.Status,
                            Labels: dockerContainer.Config.Labels
                        },
                        container.includeTags,
                        container.excludeTags,
                        container.transformTags,
                        container.linkTemplate,
                        container.displayName,
                        container.displayIcon
                    );

                    if (!updatedContainer) {
                        console.warn('Failed to get updated container details, retrying...');
                        continue;
                    }

                    // Double check no other containers exist
                    const otherContainers = containers.filter(c => c.id !== updatedContainer.id);
                    if (otherContainers.length > 0) {
                        console.log(`Found ${otherContainers.length} other containers, cleaning up before proceeding`);
                        await this.cleanupExistingContainers(container, [updatedContainer.id]);
                    }
                    
                    return updatedContainer;
                } catch (error) {
                    console.warn(`Error getting updated container details: ${error.message}`);
                    continue;
                }
            }

            console.log(`Container ${container.name} not yet updated. Retrying in 5 seconds...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        throw new Error(`Timeout waiting for container ${container.name} to update.`);
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
        const command = shell([path, name, imageName, localValue, remoteValue, watcher, compose_project]);

        // Consolidate all initial logging inside the boundary
        let output = '\n';
        output += '##############################################################################\n';
        output += '#                             SCRIPT EXECUTION START                           #\n';
        output += '##############################################################################\n';
        output += `# Container: ${name}\n`;
        output += '# Command Parameters:\n';
        output += `#   - Container Name: ${name}\n`;
        output += `#   - Image Name: ${imageName}\n`;
        output += `#   - Current Version: ${localValue}\n`;
        output += `#   - Target Version: ${remoteValue}\n`;
        output += `#   - Watcher: ${watcher}\n`;
        output += `#   - Compose Project: ${compose_project}\n`;
        output += '#\n';
        output += `# Full Command: ${command}\n`;
        output += '# Script Output:\n';
        output += '------------------------------------------------------------------------------\n';
        
        console.log(output);

        return new Promise((resolve, reject) => {
            let stdoutBuffer = '';
            let stderrBuffer = '';
            
            const process = exec(command, { timeout }, (error, stdout, stderr) => {
                if (error) {
                    if (error.killed && error.signal === 'SIGTERM') {
                        const timeoutMessage = `Script execution timed out after ${timeout} ms`;
                        console.error(`# ERROR: ${timeoutMessage}`);
                        return reject(new Error(timeoutMessage));
                    } else {
                        console.error(`# ERROR: Script execution failed: ${error.message}`);
                        return reject(error);
                    }
                }
            });

            process.stdout?.on('data', (data) => {
                const lines = data.toString().trim().split('\n');
                lines.forEach(line => {
                    if (line.trim()) {
                        console.log(`# [${name}] ${line.trim()}`);
                        stdoutBuffer += line + '\n';
                    }
                });
            });

            process.stderr?.on('data', (data) => {
                const lines = data.toString().trim().split('\n');
                lines.forEach(line => {
                    if (line.trim()) {
                        console.error(`# [${name}] ERROR: ${line.trim()}`);
                        stderrBuffer += line + '\n';
                    }
                });
            });

            process.on('close', (code, signal) => {
                console.log('------------------------------------------------------------------------------');
                console.log('# Execution Summary:');
                console.log(`# Container: ${name}`);
                console.log(`# Exit Code: ${code !== null ? code : 'N/A'}`);
                if (signal) {
                    console.log(`# Signal: ${signal}`);
                }
                
                if (code !== 0 && code !== null) {
                    const message = `Script exited with code ${code}`;
                    console.error(`# ERROR: ${message}`);
                    console.log('##############################################################################');
                    console.log('#                             SCRIPT EXECUTION END                             #');
                    console.log('##############################################################################\n');
                    reject(new Error(message));
                } else if (signal) {
                    const message = `Script was terminated by signal ${signal}`;
                    console.error(`# ERROR: ${message}`);
                    console.log('##############################################################################');
                    console.log('#                             SCRIPT EXECUTION END                             #');
                    console.log('##############################################################################\n');
                    reject(new Error(message));
                } else {
                    console.log('# Status: Success');
                    console.log('##############################################################################');
                    console.log('#                             SCRIPT EXECUTION END                             #');
                    console.log('##############################################################################\n');
                    resolve(stdoutBuffer);
                }
            });
        });
    }

    setContainerNotification(container, message, level) {
        if (container) {
            container.notification = { message, level };
            storeContainer.updateContainer(container);
        }
    }
}

module.exports = ScriptTrigger;