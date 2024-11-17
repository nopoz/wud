const { exec } = require('child_process');
const shell = require('shell-escape');
const Trigger = require('../Trigger');
const event = require('../../../event');
const storeContainer = require('../../../store/container');
const Docker = require('dockerode');
const fs = require('fs');
const registry = require('../../../registry');

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

            // Trigger watch and wait for completion using specific watcher
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
        const originalWatcher = container.watcher;
        
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
                    const watcherName = watcher?.name?.split('/')?.pop()?.replace('watcher.docker.', '') || '';
                    console.log(`Got watcher stop event for: ${watcherName}`);

                    if (watcherName === originalWatcher) {
                        clearTimeout(timer);
                        event.unregisterWatcherStop(onWatcherStop);
                        resolve();
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
        
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            const timeoutId = setTimeout(() => {
                event.unregisterWatcherStop(onWatcherStop);
                reject(new Error(`Timeout waiting for watcher ${watcherName} to complete`));
            }, timeout);

            const onWatcherStop = (watcher) => {
                const watcherComponentName = watcher?.name?.split('/')?.pop()?.replace('watcher.docker.', '') || '';
                console.log(`Got watcher stop event for: ${watcherComponentName}`);

                if (watcherComponentName === watcherName) {
                    console.log(`Watcher ${watcherName} completed scan`);
                    clearTimeout(timeoutId);
                    event.unregisterWatcherStop(onWatcherStop);
                    resolve();
                } else if (Date.now() - startTime < timeout) {
                    console.log(`Ignoring completion of different watcher: ${watcherComponentName}`);
                }
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

        // Prepare header
        const header = [
            '',
            '##############################################################################',
            '#                             SCRIPT EXECUTION START                           #',
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

        console.log(header);

        return new Promise((resolve, reject) => {
            // Create buffers for collecting output
            let stdoutBuffer = [];
            let stderrBuffer = [];
            
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

            // Handle stdout data with buffering
            process.stdout?.on('data', (data) => {
                const lines = data.toString().split('\n');
                lines.forEach(line => {
                    if (line.trim()) {
                        const formattedLine = `# [${name}] ${line.trim()}`;
                        stdoutBuffer.push(formattedLine);
                        console.log(formattedLine);
                    }
                });
            });

            // Handle stderr data with buffering
            process.stderr?.on('data', (data) => {
                const lines = data.toString().split('\n');
                lines.forEach(line => {
                    if (line.trim()) {
                        const formattedLine = `# [${name}] ERROR: ${line.trim()}`;
                        stderrBuffer.push(formattedLine);
                        console.error(formattedLine);
                    }
                });
            });

            // Handle process completion
            process.on('close', (code, signal) => {
                // Prepare footer content
                const footer = [
                    '------------------------------------------------------------------------------',
                    '# Execution Summary:',
                    `# Container: ${name}`,
                    `# Exit Code: ${code !== null ? code : 'N/A'}`,
                    signal ? `# Signal: ${signal}` : null,
                    code === 0 ? '# Status: Success' : null,
                    '##############################################################################',
                    '#                             SCRIPT EXECUTION END                             #',
                    '##############################################################################',
                    ''
                ].filter(Boolean).join('\n');

                console.log(footer);

                if (code !== 0 && code !== null) {
                    const message = `Script exited with code ${code}`;
                    console.error(`# ERROR: ${message}`);
                    reject(new Error(message));
                } else if (signal) {
                    const message = `Script was terminated by signal ${signal}`;
                    console.error(`# ERROR: ${message}`);
                    reject(new Error(message));
                } else {
                    // Join all output with newlines and resolve
                    resolve(stdoutBuffer.join('\n'));
                }
            });

            // Handle process errors
            process.on('error', (err) => {
                console.error(`# ERROR: Process error: ${err.message}`);
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