const { exec } = require('child_process');
const shell = require('shell-escape');
const Trigger = require('../Trigger');
const event = require('../../../event');
const storeContainer = require('../../../store/container');
const Docker = require('dockerode');
const fs = require('fs');
const registry = require('../../../registry');
const EventEmitter = require('events');

const scriptOutputEmitter = new EventEmitter();

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
        console.log(`Previous image ID for ${storedContainer.name}: ${previousImageId}`);

        // Clean up any existing containers with the same name before starting
        await this.cleanupExistingContainers(storedContainer);

        await this.executeScript(storedContainer, 'install');
        console.log(`Successfully executed script for container: ${storedContainer.name || 'unknown'}`);

        // Wait for the new container to appear with an updated image
        const newContainer = await this.waitForContainerImageUpdate(storedContainer, previousImageId);
        console.log(`Container ${storedContainer.name || 'unknown'} has been updated to a new image`);

        // Do another cleanup after update
        await this.cleanupExistingContainers(newContainer, [newContainer.id]);

        // Trigger watch and wait for completion
        console.log(`Triggering watcher scan for ${storedContainer.watcher}...`);
        event.emitTriggerWatch();
        await this.waitForSpecificWatcherToComplete(storedContainer.watcher);
        console.log('Watcher has completed scanning containers');

        // Validate the state after watch completion
        const finalContainers = storeContainer.getContainers({ 
            name: container.name, 
            watcher: container.watcher 
        });
        if (finalContainers.length > 1) {
            console.warn(`Multiple containers detected after update for ${container.name}. Triggering additional cleanup.`);
            await this.cleanupExistingContainers(container, finalContainers.map(c => c.id));
        }

        return { 
            success: true, 
            message: `Update for ${storedContainer.name} completed successfully.`,
            newContainerId: finalContainers.length > 0 ? finalContainers[0].id : null 
        };
    } catch (error) {
        console.error(`Error during install for container ${storedContainer.name || 'unknown'}: ${error.message}`);
        this.setContainerNotification(storedContainer, `Update for ${storedContainer.name} failed: ${error.message}`, 'error');
        // Only log container removal if it's not a validation error
        if (!error.message.includes('ValidationError')) {
            console.log(`Removing old container ${storedContainer.id} for ${storedContainer.name}`);
        }
        return { 
            success: false, 
            message: `Update for ${storedContainer.name} failed: ${error.message}` 
        };
    }
}

    getDockerApiForWatcher(watcherName) {
        console.log(`Setting up Docker API for watcher: ${watcherName}`);
        
        try {
            const envPrefix = `WUD_WATCHER_${watcherName.toUpperCase()}_`;
            console.log(`Looking for environment variables with prefix: ${envPrefix}`);

            // Log all relevant environment variables for debugging
            const relevantEnvVars = Object.entries(process.env)
                .filter(([key]) => key.startsWith('WUD_WATCHER'))
                .map(([key, value]) => `${key}=${value}`);
            
            console.log('Available WUD_WATCHER environment variables:', relevantEnvVars);

            const socketPath = process.env[`${envPrefix}SOCKET`];
            const host = process.env[`${envPrefix}HOST`];
            const port = process.env[`${envPrefix}PORT`] ? 
                parseInt(process.env[`${envPrefix}PORT`], 10) : 2375;

            let dockerOptions = {};

            if (socketPath) {
                console.log(`Configuring local Docker socket for ${watcherName}: ${socketPath}`);
                dockerOptions = { socketPath };
            } else if (host) {
                console.log(`Configuring remote Docker host for ${watcherName}: ${host}:${port}`);
                dockerOptions = { host, port };
            } else {
                console.log(`No specific configuration found for ${watcherName}, using default socket`);
                dockerOptions = { socketPath: '/var/run/docker.sock' };
            }

            console.log(`Creating Docker API instance for ${watcherName} with options:`, dockerOptions);
            return new Docker(dockerOptions);
            
        } catch (error) {
            console.error(`Error setting up Docker API for ${watcherName}:`, error);
            throw new Error(`Failed to initialize Docker API for watcher ${watcherName}: ${error.message}`);
        }
    }

    async cleanupExistingContainers(container, excludeIds = []) {
        console.log(`Starting cleanup of existing containers for ${container.name} (watcher: ${container.watcher})`);
        console.log(`Exclude IDs: ${excludeIds.length ? excludeIds.join(', ') : 'None'}`);

        // Create a copy of excludeIds to avoid modifying the original
        const safeExcludeIds = [...excludeIds];
        const MAX_RETRIES = 3;
        let attempts = 0;

        while (attempts < MAX_RETRIES) {
            const containerList = storeContainer.getContainers({ 
                name: container.name,
                watcher: container.watcher 
            });

            let cleanupNeeded = false;
            console.log(`Cleanup attempt #${attempts + 1} for ${container.name} (watcher: ${container.watcher})...`);

            // First, identify containers that aren't already excluded
            const availableContainers = containerList.filter(c => !safeExcludeIds.includes(c.id));
            
            // If we have containers to potentially clean up
            if (availableContainers.length > 0) {
                // Find the best container to preserve using multiple criteria
                let bestContainer = null;
                
                // 1. First, prefer running containers
                const runningContainers = availableContainers.filter(c => c.status === 'running');
                
                if (runningContainers.length > 0) {
                    // 2. Among running containers, prefer those without updateAvailable flag
                    const upToDateContainers = runningContainers.filter(c => c.updateAvailable === false);
                    
                    if (upToDateContainers.length > 0) {
                        // Choose the first up-to-date container
                        bestContainer = upToDateContainers[0];
                    } else {
                        // If no up-to-date containers, choose the first running one
                        bestContainer = runningContainers[0];
                    }
                } else if (availableContainers.length > 0) {
                    // If no running containers, just pick the first available
                    bestContainer = availableContainers[0];
                }
                
                // If we found a container to preserve, add it to the exclusion list
                if (bestContainer) {
                    console.log(`Preserving container ${bestContainer.id} (status: ${bestContainer.status}) during cleanup`);
                    safeExcludeIds.push(bestContainer.id);
                }
                
                // Now perform the cleanup for all non-excluded containers
                for (const containerToClean of availableContainers) {
                    if (!safeExcludeIds.includes(containerToClean.id)) {
                        try {
                            cleanupNeeded = true;
                            
                            // Safe access to nested properties
                            const tagValue = containerToClean.image && 
                                            containerToClean.image.tag && 
                                            containerToClean.image.tag.value || 'unknown';
                                            
                            console.log(`Found container to cleanup: ${containerToClean.id} (status: ${containerToClean.status}, tag: ${tagValue})`);
                            
                            await storeContainer.deleteContainer(containerToClean.id);
                            
                            // Verify deletion
                            const stillExists = storeContainer.getContainer(containerToClean.id);
                            if (stillExists) {
                                console.warn(`Container ${containerToClean.id} still exists after deletion attempt`);
                            } else {
                                console.log(`Container ${containerToClean.id} deleted successfully.`);
                            }
                        } catch (err) {
                            console.warn(`Failed to delete container ${containerToClean.id}: ${err.message}`);
                        }
                    }
                }
            }

            if (!cleanupNeeded) {
                console.log(`No cleanup needed for ${container.name} (watcher: ${container.watcher}). Exiting cleanup loop.`);
                break;
            }

            // Check if any old containers remain
            const remainingContainers = storeContainer.getContainers({
                name: container.name,
                watcher: container.watcher,
            }).filter(c => !safeExcludeIds.includes(c.id));

            if (remainingContainers.length === 0) {
                console.log(`All old containers for ${container.name} (watcher: ${container.watcher}) have been cleaned up.`);
                break;
            } else {
                console.log(`Cleanup retry needed: ${remainingContainers.length} containers remain for ${container.name}:`,
                    remainingContainers.map(c => `${c.id} (${c.status})`).join(', ')
                );
            }

            attempts += 1;
            console.log(`Waiting before next cleanup attempt...`);
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait before retry
        }

        if (attempts === MAX_RETRIES) {
            console.warn(`Max retries reached for cleaning up old containers for ${container.name} (watcher: ${container.watcher}). Some containers may still remain.`);
            const remainingContainers = storeContainer.getContainers({
                name: container.name,
                watcher: container.watcher,
            }).filter(c => !safeExcludeIds.includes(c.id));
            
            if (remainingContainers.length > 0) {
                console.warn('Remaining containers after max retries:', 
                    remainingContainers.map(c => `${c.id} (${c.status})`).join(', ')
                );
            } else {
                console.log(`No remaining containers after max retries, but no successful break detected. Please investigate further.`);
            }
        }

        console.log(`Cleanup process completed for ${container.name} (watcher: ${container.watcher}).`);
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

        let originalWatcher = container.watcher || '';
        if (!originalWatcher || originalWatcher.trim() === '') {
            originalWatcher = 'local';
        }
        
        // Add artificial delay for local watcher to match remote behavior
        const envPrefix = `WUD_WATCHER_${originalWatcher.toUpperCase()}_`;
        const socketPath = process.env[`${envPrefix}SOCKET`];
        if (socketPath) {  // This indicates a local watcher
            console.log(`Adding delay for local watcher ${originalWatcher}`);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        console.log(`Waiting for container update with watcher: ${originalWatcher}`);

        try {
            const dockerApi = this.getDockerApiForWatcher(originalWatcher);
            console.log(`Successfully connected to Docker host for watcher ${originalWatcher}`);

            // First, wait for new container
            let newContainerId = null;
            while (Date.now() - startTime < timeout) {
                try {
                    const containers = await dockerApi.listContainers({
                        filters: {
                            name: [container.name]
                        }
                    });

                    console.log(`Found ${containers.length} containers matching name ${container.name} on ${originalWatcher}`);

                    for (const containerInfo of containers) {
                        const inspectData = await dockerApi.getContainer(containerInfo.Id).inspect();
                        console.log(`Container ${containerInfo.Id} status: ${inspectData.State.Status}, image: ${inspectData.Image}`);
                        
                        if (inspectData.State.Status === 'running' && 
                            inspectData.Image !== previousImageId) {
                            console.log(`Found new running container ${containerInfo.Id} with updated image on ${originalWatcher}`);
                            newContainerId = containerInfo.Id;
                            break;
                        }
                    }

                    if (newContainerId) break;
                    
                    console.log(`Container ${container.name} not yet updated on ${originalWatcher}. Retrying in 5 seconds...`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                } catch (error) {
                    console.warn(`Error checking containers: ${error.message}`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }

            if (!newContainerId) {
                throw new Error(`Timeout waiting for container ${container.name} to update`);
            }

            // Now that we have the new container, trigger a single watcher scan and wait for completion
            console.log(`Triggering single watcher scan for ${originalWatcher}...`);
            event.emitTriggerWatch();

            // Wait for watcher completion
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    event.unregisterWatcherStop(onWatcherStop);
                    reject(new Error('Watcher completion timeout'));
                }, 30000);

                const onWatcherStop = (watcher) => {
                    const watcherRef = `watcher.docker.${originalWatcher}`;
                    const fullWatcherName = watcher?.name || '';

                    // Match either the local case or the remote case
                    if ((originalWatcher === 'local' && !fullWatcherName) || 
                        fullWatcherName.includes(watcherRef)) {
                        clearTimeout(timer);
                        event.unregisterWatcherStop(onWatcherStop);
                        resolve();
                        return;
                    }
                };

                event.registerWatcherStop(onWatcherStop);
            });

            // Give the store a moment to update
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Check the store for the update
            const updatedContainer = storeContainer.getContainer(newContainerId);
            if (!updatedContainer) {
                throw new Error('Updated container not found in store');
            }

            console.log(`Successfully verified container update in store for ${newContainerId}`);
            return updatedContainer;

        } catch (error) {
            console.error(`Error during container update: ${error.message}`);
            throw error;
        }
    }

    async waitForSpecificWatcherToComplete(watcherName, timeout = 60000) {
        console.log(`Waiting for watcher ${watcherName} to complete...`);
        
        // If watcherName is supposed to be local but is empty, default it to 'local'
        if (!watcherName || watcherName.trim() === '') {
            watcherName = 'local';
        }
        
        return new Promise((resolve, reject) => {
            let completed = false;
            const timeoutId = setTimeout(() => {
                if (!completed) {  // Only reject if we haven't completed successfully
                    event.unregisterWatcherStop(onWatcherStop);
                    reject(new Error(`Timeout waiting for watcher ${watcherName} to complete`));
                }
            }, timeout);

            const onWatcherStop = (watcher) => {
                const watcherRef = `watcher.docker.${watcherName}`;
                const fullWatcherName = watcher?.name || '';

                // Check for both the short name and the full reference
                if ((watcherName === 'local' && !fullWatcherName) || 
                    fullWatcherName.includes(watcherRef)) {
                    completed = true;  // Mark as completed before cleanup
                    clearTimeout(timeoutId);
                    event.unregisterWatcherStop(onWatcherStop);
                    resolve();
                    return;
                }
            };

            event.registerWatcherStop(onWatcherStop);
        });
    }

    async executeScript(container, actionType) {
        const { path, timeout } = this.configuration;
        const name = container.name || 'unknown';
        const fullImageName = container.image.name || 'unknown';
        const imageNameParts = fullImageName.split('/');
        const imageName = imageNameParts[imageNameParts.length - 1];
        const localValue = container.updateKind?.localValue || 'unknown';
        const remoteValue = container.updateKind?.remoteValue || 'unknown';
        
        let watcher = container.watcher || '';
        if (!watcher || watcher.trim() === '') {
            watcher = 'local';
        }

        const compose_project = container.compose_project || 'unknown';
        const command = shell([path, name, imageName, localValue, remoteValue, watcher, compose_project]);

        // Prepare header
        const header = [
            '',
            '##############################################################################',
            '#                             SCRIPT EXECUTION START                         #',
            '##############################################################################',
            `# Container: ${name}`,
            '# Command Parameters:',
            `#   - Container Name: ${name}`,
            `#   - Image Name: ${imageName}`,
            `#   - Current Version: ${localValue}`,
            `#   - Target Version: ${remoteValue}`,
            `#   - Watcher: ${watcher}`,
            `#   - Compose Project: ${compose_project}`,
            '#',
            `# Full Command: ${command}`,
            '# Script Output:',
            '------------------------------------------------------------------------------',
            ''
        ].join('\n');

        // Helper function to emit log
        const emitLog = (message) => {
            console.log(message.trim()); // Keep console logging
            scriptOutputEmitter.emit('output', {
                containerId: container.id,
                containerName: container.name,
                message: message,
                timestamp: Date.now()
            });
        };

        // Emit header
        emitLog(header);

        return new Promise((resolve, reject) => {
            const process = exec(command, { timeout }, (error) => {
                if (error && error.killed && error.signal === 'SIGTERM') {
                    const timeoutMessage = `Script execution timed out after ${timeout} ms`;
                    emitLog(`# ERROR: ${timeoutMessage}\n`);
                    return reject(new Error(timeoutMessage));
                }
            });

            process.stdout?.on('data', (data) => {
                const lines = data.toString().split('\n');
                lines.forEach(line => {
                    if (line.trim()) {
                        emitLog(`# [${name}] ${line.trim()}\n`);
                    }
                });
            });

            process.stderr?.on('data', (data) => {
                const lines = data.toString().split('\n');
                lines.forEach(line => {
                    if (line.trim()) {
                        emitLog(`# [${name}] ERROR: ${line.trim()}\n`);
                    }
                });
            });

            process.on('close', (code, signal) => {
                const footer = [
                    '------------------------------------------------------------------------------',
                    '# Execution Summary:',
                    `# Container: ${name}`,
                    `# Exit Code: ${code !== null ? code : 'N/A'}`,
                    signal ? `# Signal: ${signal}` : null,
                    code === 0 ? '# Status: Success' : null,
                    '##############################################################################',
                    '#                             SCRIPT EXECUTION END                           #',
                    '##############################################################################',
                    ''
                ].filter(Boolean).join('\n');

                emitLog(footer);
                
                scriptOutputEmitter.emit('complete', {
                    containerId: container.id,
                    containerName: container.name,
                    timestamp: Date.now()
                });

                if (code !== 0 && code !== null) {
                    reject(new Error(`Script exited with code ${code}`));
                } else if (signal) {
                    reject(new Error(`Script was terminated by signal ${signal}`));
                } else {
                    resolve();
                }
            });

            process.on('error', (err) => {
                const errorMsg = `# ERROR: Process error: ${err.message}\n`;
                emitLog(errorMsg);
                reject(err);
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
module.exports.scriptOutputEmitter = scriptOutputEmitter;
