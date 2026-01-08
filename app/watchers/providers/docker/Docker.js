const fs = require('fs');
const Dockerode = require('dockerode');
const joi = require('joi-cron-expression')(require('joi'));
const cron = require('node-cron');
const parse = require('parse-docker-image-name');
const debounce = require('just-debounce');
const { parse: parseSemver, isGreater: isGreaterSemver, transform: transformTag } = require('../../../tag');
const event = require('../../../event');
const {
    wudWatch,
    wudTagInclude,
    wudTagExclude,
    wudTagTransform,
    wudWatchDigest,
    wudLinkTemplate,
    wudDisplayName,
    wudDisplayIcon,
} = require('./label');
const storeContainer = require('../../../store/container');
const log = require('../../../log');
const Component = require('../../../registry/Component');
const { validate: validateContainer, fullName } = require('../../../model/container');
const registry = require('../../../registry');
const { getWatchContainerGauge } = require('../../../prometheus/watcher');

// The delay before starting the watcher when the app is started
const START_WATCHER_DELAY_MS = 1000;

// Debounce delay used when performing a watch after a docker event has been received
const DEBOUNCED_WATCH_CRON_MS = 5000;

/**
 * Return all supported registries
 * @returns {*}
 */
function getRegistries() {
    return registry.getState().registry;
}

/**
 * Filter candidate tags (based on tag name).
 * @param container
 * @param tags
 * @returns {*}
 */
function getTagCandidates(container, tags, logContainer, imageDigestMap = new Map()) {
    let filteredTags = tags;

    // Match include tag regex
    if (container.includeTags) {
        const includeTagsRegex = new RegExp(container.includeTags);
        filteredTags = filteredTags.filter((tag) => includeTagsRegex.test(tag));
    }

    const matchingDigest = imageDigestMap?.get(container.image.digest.value);
    
    if (matchingDigest) {
        filteredTags = tags.filter((tag) => matchingDigest.tags.includes(tag));
    } else {
        // Fallback exclusion of "latest" unless it matches `includeTags`
        if (container.includeTags && !new RegExp(container.includeTags).test('latest')) {
            filteredTags = filteredTags.filter((tag) => tag !== 'latest');
        }
    }

    if (filteredTags.length === 0) {
        logContainer.warn('No tags found after filtering. Check regex filters.');
    }

    filteredTags = filteredTags
        .filter((tag) => parseSemver(transformTag(container.transformTags, tag)) !== null)
        .sort((t1, t2) =>
            isGreaterSemver(transformTag(container.transformTags, t2), transformTag(container.transformTags, t1)) ? 1 : -1
        );

    return filteredTags;
}

function normalizeContainer(container) {
    const containerWithNormalizedImage = container;
    const registryProvider = Object.values(getRegistries())
        .find((provider) => provider.match(container.image));
    if (!registryProvider) {
        log.warn(`${fullName(container)} - No Registry Provider found`);
        containerWithNormalizedImage.image.registry.name = 'unknown';
    } else {
        containerWithNormalizedImage.image = registryProvider.normalizeImage(container.image);
    }
    return validateContainer(containerWithNormalizedImage);
}

/**
 * Get the Docker Registry by name.
 * @param registryName
 */
function getRegistry(registryName) {
    const registryToReturn = getRegistries()[registryName];
    if (!registryToReturn) {
        throw new Error(`Unsupported Registry ${registryName}`);
    }
    return registryToReturn;
}

/**
 * Get old containers to prune.
 * @param {Array} newContainers
 * @param {Array} containersFromTheStore
 * @returns {Array}
 */
function getOldContainers(newContainers, containersFromTheStore) {
    if (!containersFromTheStore || !newContainers) {
        return [];
    }
    return containersFromTheStore.filter((containerFromStore) => {
        const isContainerStillToWatch = newContainers
            .find((newContainer) => 
                newContainer.id === containerFromStore.id ||
                (newContainer.name === containerFromStore.name && 
                 newContainer.watcher === containerFromStore.watcher &&
                 newContainer.image.registry.name === containerFromStore.image.registry.name)
            );
        return isContainerStillToWatch === undefined;
    });
}

/**
 * Prune old containers from the store with enhanced protection for updated containers.
 * @param newContainers - Array of containers from Docker API
 * @param containersFromTheStore - Array of containers from the store
 */
function pruneOldContainers(newContainers, containersFromTheStore) {
    console.log(`Pruning old containers (${newContainers.length} new, ${containersFromTheStore.length} in store)`);

    // Group containers by name+watcher for easier processing
    const storeContainersByKey = {};
    const newContainersByKey = {};
    
    // Group store containers
    for (const container of containersFromTheStore) {
        const key = `${container.name}_${container.watcher || 'local'}`;
        if (!storeContainersByKey[key]) {
            storeContainersByKey[key] = [];
        }
        storeContainersByKey[key].push(container);
    }
    
    // Group new containers
    for (const container of newContainers) {
        const key = `${container.name}_${container.watcher || 'local'}`;
        if (!newContainersByKey[key]) {
            newContainersByKey[key] = [];
        }
        newContainersByKey[key].push(container);
    }
    
    // Process each group of containers
    for (const [key, containersInStore] of Object.entries(storeContainersByKey)) {
        const newContainersForKey = newContainersByKey[key] || [];
        
        // If there are no new containers for this key, check before removing
        if (newContainersForKey.length === 0) {
            for (const containerItem of containersInStore) {
                // Don't delete containers that have update info - they might be in the process
                // of being recreated (race condition during updates)
                const hasUpdateInfo = containerItem.updateKind &&
                                     containerItem.updateKind.remoteValue &&
                                     containerItem.updateAvailable;
                if (hasUpdateInfo) {
                    console.log(`Preserving container ${containerItem.id} for ${containerItem.name} - has pending update info`);
                    continue;
                }
                console.log(`Removing orphaned container ${containerItem.id} for ${containerItem.name}`);
                storeContainer.deleteContainer(containerItem.id);
            }
            continue;
        }
        
        // If there's only one store container, and it has update info but isn't in newContainers,
        // we need to transfer its info to one of the new containers before deleting
        if (containersInStore.length === 1 && 
            containersInStore[0].updateKind && 
            containersInStore[0].result && 
            !newContainersForKey.some(c => c.id === containersInStore[0].id)) {
            
            const oldContainer = containersInStore[0];
            const newContainer = newContainersForKey[0]; // Use the first new container
            
            // Check if the new container might be an update of the old one
            if (oldContainer.image && newContainer.image && 
                oldContainer.image.tag && newContainer.image.tag &&
                oldContainer.image.tag.value !== newContainer.image.tag.value) {
                
                console.log(`Found version change for ${oldContainer.name}: ${oldContainer.image.tag.value} -> ${newContainer.image.tag.value}`);
                
                // Transfer update info
                newContainer.updateKind = {
                    ...oldContainer.updateKind,
                    localValue: newContainer.image.tag.value
                };
                
                newContainer.result = oldContainer.result;
                
                // Reset update status if the tag matches target
                if (newContainer.image.tag.value === oldContainer.updateKind.remoteValue) {
                    newContainer.updateAvailable = false;
                } else {
                    newContainer.updateAvailable = true;
                }
                
                // Add success notification
                newContainer.notification = {
                    message: `Update for ${newContainer.name} completed successfully.`,
                    level: 'success'
                };
                
                // Transfer tag filtering metadata
                // Only copy non-null properties to avoid overwriting with null
                if (oldContainer.includeTags !== null && oldContainer.includeTags !== undefined) {
                    newContainer.includeTags = oldContainer.includeTags;
                }
                if (oldContainer.excludeTags !== null && oldContainer.excludeTags !== undefined) {
                    newContainer.excludeTags = oldContainer.excludeTags;
                }
                if (oldContainer.transformTags !== null && oldContainer.transformTags !== undefined) {
                    newContainer.transformTags = oldContainer.transformTags;
                }
                if (oldContainer.linkTemplate !== null && oldContainer.linkTemplate !== undefined) {
                    newContainer.linkTemplate = oldContainer.linkTemplate;
                }
                
                // Save the updated new container
                storeContainer.updateContainer(newContainer);
            }
        }
        
        // Create a set to track containers we want to keep (don't delete)
        const containersToKeep = new Set();
        
        // First pass - identify containers to keep
        for (const containerItem of containersInStore) {
            // Check if this container exists in the new containers
            const stillExists = newContainersForKey.some(c => c.id === containerItem.id);
            
            // Protection logic - retain containers with success notifications even if not found in Docker
            // unless there's another container with the same name that matches the target version
            const hasSuccessNotification = containerItem.notification && 
                                          containerItem.notification.level === 'success' &&
                                          containerItem.notification.message &&
                                          containerItem.notification.message.includes('completed successfully');
                                          
            // Find if there's a matching target version container
            const matchesTargetVersion = containerItem.updateKind && 
                                        newContainersForKey.some(c => 
                                            c.image.tag && 
                                            containerItem.updateKind.remoteValue === c.image.tag.value);
            
            if (stillExists || (hasSuccessNotification && !matchesTargetVersion)) {
                // Keep this container
                containersToKeep.add(containerItem.id);
                
                if (hasSuccessNotification && !stillExists) {
                    console.log(`Protecting container ${containerItem.id} with success notification for ${containerItem.name}`);
                }
            }
        }
        
        // Second pass - delete containers not in our keep set
        for (const containerItem of containersInStore) {
            if (!containersToKeep.has(containerItem.id)) {
                console.log(`Removing old container ${containerItem.id} for ${containerItem.name}`);
                storeContainer.deleteContainer(containerItem.id);
            }
        }
    }
}

function getContainerName(container) {
    let containerName;
    const names = container.Names;
    if (names && names.length > 0) {
        [containerName] = names;
    }
    // Strip ugly forward slash
    containerName = containerName.replace(/\//, '');
    return containerName;
}

/**
 * Get image repo digest.
 * @param containerImage
 * @returns {*} digest
 */
function getRepoDigest(containerImage) {
    if (!containerImage.RepoDigests || containerImage.RepoDigests.length === 0) {
        return undefined;
    }
    const fullDigest = containerImage.RepoDigests[0];
    const digestSplit = fullDigest.split('@');
    return digestSplit[1];
}

/**
 * Return true if container must be watched.
 * @param wudWatchLabelValue the value of the wud.watch label
 * @param watchByDefault true if containers must be watched by default
 * @returns {boolean}
 */
function isContainerToWatch(wudWatchLabelValue, watchByDefault) {
    return wudWatchLabelValue !== undefined && wudWatchLabelValue !== '' ? wudWatchLabelValue.toLowerCase() === 'true' : watchByDefault;
}

/**
 * Return true if container digest must be watched.
 * @param wudWatchDigestLabelValue the value of wud.watch.digest label
 * @param isSemver if image is semver
 * @returns {boolean|*}
 */
function isDigestToWatch(wudWatchDigestLabelValue, isSemver) {
    let result = false;
    if (isSemver) {
        if (wudWatchDigestLabelValue !== undefined && wudWatchDigestLabelValue !== '') {
            result = wudWatchDigestLabelValue.toLowerCase() === 'true';
        }
    } else {
        result = true;
        if (wudWatchDigestLabelValue !== undefined && wudWatchDigestLabelValue !== '') {
            result = wudWatchDigestLabelValue.toLowerCase() === 'true';
        }
    }
    return result;
}

/**
 * Docker Watcher Component.
 */
class Docker extends Component {
    getConfigurationSchema() {
        return joi.object().keys({
            socket: this.joi.string().default('/var/run/docker.sock'),
            host: this.joi.string(),
            port: this.joi.number().port().default(2375),
            cafile: this.joi.string(),
            certfile: this.joi.string(),
            keyfile: this.joi.string(),
            cron: joi.string().cron().default('0 * * * *'),
            watchbydefault: this.joi.boolean().default(true),
            watchall: this.joi.boolean().default(false),
            watchdigest: this.joi.any(),
            watchevents: this.joi.boolean().default(true),
            watchatstart: this.joi.boolean().default(true),
        });
    }

    /**
     * Init the Watcher.
     */
    init() {
        this.initWatcher();
        if (this.configuration.watchdigest !== undefined) {
            this.log.warn('WUD_WATCHER_{watcher_name}_WATCHDIGEST environment variable is deprecated and won\'t be supported in upcoming versions');
        }
        this.log.info(`Cron scheduled (${this.configuration.cron})`);
        this.watchCron = cron.schedule(this.configuration.cron, () => this.watchFromCron());

        // watch at startup if enabled (after all components have been registered)
        if (this.configuration.watchatstart) {
            this.watchCronTimeout = setTimeout(
                () => this.watchFromCron(),
                START_WATCHER_DELAY_MS,
            );
        }

        // listen to docker events
        if (this.configuration.watchevents) {
            this.watchCronDebounced = debounce(
                () => { this.watchFromCron(); },
                DEBOUNCED_WATCH_CRON_MS,
            );
            this.listenDockerEventsTimeout = setTimeout(
                () => this.listenDockerEvents(),
                START_WATCHER_DELAY_MS,
            );
        }

        // Listen for the custom event to trigger a watch
        this.triggerWatchListener = async () => {
            this.log.info('Received trigger_watch event, performing watch');
            await this.watchFromCron();
            event.emitWatcherStop();
            this.log.info('Watcher has completed scanning containers');
        };

        event.registerTriggerWatch(this.triggerWatchListener);
        // === End of added code ===
    }

    initWatcher() {
        const options = {};
        if (this.configuration.host) {
            options.host = this.configuration.host;
            options.port = this.configuration.port;
            if (this.configuration.cafile) {
                options.ca = fs.readFileSync(this.configuration.cafile);
            }
            if (this.configuration.certfile) {
                options.cert = fs.readFileSync(this.configuration.certfile);
            }
            if (this.configuration.keyfile) {
                options.key = fs.readFileSync(this.configuration.keyfile);
            }
        } else {
            options.socketPath = this.configuration.socket;
        }

        this.dockerApi = new Dockerode(options);

        if (!this.dockerApi || typeof this.dockerApi.getContainer !== 'function') {
            throw new Error('Failed to initialize Docker API or getContainer method is unavailable.');
        }

        this.log.info('Docker API successfully initialized.');
    }

    /**
     * Deregister the component.
     * @returns {Promise<void>}
     */
    async deregisterComponent() {
        if (this.watchCron) {
            this.watchCron.stop();
            delete this.watchCron;
        }
        if (this.watchCronTimeout) {
            clearTimeout(this.watchCronTimeout);
        }
        if (this.listenDockerEventsTimeout) {
            clearTimeout(this.listenDockerEventsTimeout);
            delete this.watchCronDebounced;
        }
        if (this.triggerWatchListener) {
            event.unregisterTriggerWatch(this.triggerWatchListener);
            delete this.triggerWatchListener;
        }
    }

    /**
     * Listen and react to docker events.
     * @return {Promise<void>}
     */
    async listenDockerEvents() {
        this.log.info('Listening to docker events');
        const options = {
            filters: {
                type: ['container'],
                event: [
                    'create',
                    'destroy',
                    'start',
                    'stop',
                    'pause',
                    'unpause',
                    'die',
                    'update',
                ],
            },
        };
        this.dockerApi.getEvents(options, (err, stream) => {
            if (err) {
                this.log.warn(`Unable to listen to Docker events [${err.message}]`);
                this.log.debug(err);
            } else {
                stream.on('data', (chunk) => this.onDockerEvent(chunk));
            }
        });
    }

    /**
     * Process a docker event.
     * @param dockerEventChunk
     * @return {Promise<void>}
     */
    async onDockerEvent(chunk) {
        if (!this.partialData) this.partialData = ''; // Initialize partialData buffer if not set

        try {
            // Accumulate incoming chunks of data
            this.partialData += chunk.toString();

            let event;
            while (this.partialData) {
                const newLineIndex = this.partialData.indexOf('\n');
                if (newLineIndex === -1) {
                    // No complete JSON object yet
                    return;
                }

                const completeJson = this.partialData.slice(0, newLineIndex).trim();
                this.partialData = this.partialData.slice(newLineIndex + 1);

                try {
                    event = JSON.parse(completeJson);
                } catch (e) {
                    console.warn(`Skipping invalid JSON: ${completeJson}`);
                    continue; // Skip to the next event in case of parsing error
                }

                // Process the valid Docker event
                const action = event.Action;
                const containerId = event.id;

                if (action === 'destroy' || action === 'create') {
                    await this.watchCronDebounced();
                } else {
                    try {
                        const container = await this.dockerApi.getContainer(containerId);
                        const containerInspect = await container.inspect();
                        const newStatus = containerInspect.State.Status;
                        const containerFound = storeContainer.getContainer(containerId);

                        if (containerFound) {
                            const logContainer = this.log.child({ container: fullName(containerFound) });
                            const oldStatus = containerFound.status;
                            containerFound.status = newStatus;

                            if (oldStatus !== newStatus) {
                                storeContainer.updateContainer(containerFound);
                                logContainer.info(`Status changed from ${oldStatus} to ${newStatus}`);
                            }
                        }
                    } catch (e) {
                        this.log.debug(`Failed to update container details for ID ${containerId}: ${e.message}`);
                    }
                }
            }
        } catch (error) {
            this.log.error(`Error processing Docker event: ${error.message}`);
        }
    }

    /**
     * Watch containers (called by cron scheduled tasks).
     * @returns {Promise<*[]>}
     */
    async watchFromCron() {
        this.log.info(`Cron started (${this.configuration.cron})`);

        // Get container reports
        const containerReports = await this.watch();

        // Filter out null container reports
        const validContainerReports = containerReports.filter(report => report.container !== null);

        // Count container reports
        const containerReportsCount = validContainerReports.length;

        // Count container available updates
        const containerUpdatesCount = validContainerReports
            .filter((containerReport) => containerReport.container.updateAvailable).length;

        // Count container errors
        const containerErrorsCount = validContainerReports
            .filter((containerReport) => containerReport.container.error !== undefined).length;

        const stats = `${containerReportsCount} containers watched, ${containerErrorsCount} errors, ${containerUpdatesCount} available updates`;
        this.log.info(`Cron finished (${stats})`);
        return containerReports;
    }

    /**
     * Watch main method.
     * @returns {Promise<*[]>}
     */
    async watch() {
        let containers = [];

        // Dispatch event to notify start watching
        event.emitWatcherStart(this);

        // List images to watch
        try {
            containers = await this.getContainers();
        } catch (e) {
            this.log.warn(`Error when trying to get the list of the containers to watch (${e.message})`);
        }
        try {
            const containerReports = await Promise.all(
                containers.map((container) => this.watchContainer(container)),
            );
            event.emitContainerReports(containerReports);
            return containerReports;
        } catch (e) {
            this.log.warn(`Error when processing some containers (${e.message})`);
            return [];
        } finally {
            // Dispatch event to notify stop watching
            event.emitWatcherStop(this);
        }
    }

async watchContainer(container, skipRegistryCheck = false) {
    const logContainer = this.log.child({ container: fullName(container) });
    const containerWithResult = container;

    // Reset any previous results
    delete containerWithResult.result;
    delete containerWithResult.error;
    logContainer.debug('Start watching');

    try {
        // Get current running container info
        const dockerContainer = await this.dockerApi.getContainer(container.id).inspect();
        
        if (dockerContainer.State.Status !== 'running') {
            logContainer.info(`Container ${container.id} is not running, checking for replacement`);
            
            // Check if there's a replacement container running with same name
            const containers = await this.dockerApi.listContainers({
                filters: {
                    name: [container.name],
                    status: ['running']
                }
            });

            const replacement = containers.find(c => 
                c.Names.some(n => n.replace('/', '') === container.name)
            );

            if (replacement) {
                logContainer.info(`Found replacement container ${replacement.Id} for ${container.name}`);
                
                // Get the full details for the replacement container
                const replacementContainer = await this.addImageDetailsToContainer(replacement);
                
                // Check if this is an update scenario - old container has update information
                if (container.updateAvailable && container.updateKind) {
                    logContainer.info(`Detected container update from ${container.id} to ${replacement.Id}`);
                    
                    // If the old container had an update available and this is a new container
                    // with a different image ID, this is likely the update that was applied
                    if (replacementContainer && 
                        replacementContainer.image.id !== container.image.id) {
                        
                        logContainer.info(`Transferring update info to replacement container`);
                        
                        // Transfer update info to the new container and reset update flags
                        replacementContainer.updateKind = {
                            ...container.updateKind,
                            localValue: container.updateKind.remoteValue
                        };
                        replacementContainer.updateAvailable = false;
                        
                        // Add a success notification
                        replacementContainer.notification = {
                            message: `Update for ${container.name} completed successfully.`,
                            level: 'success'
                        };
                        
                        // Copy other relevant fields
                        if (container.result) {
                            replacementContainer.result = container.result;
                        }
                        if (container.link) {
                            replacementContainer.link = container.link;
                        }
                        if (container.linkTemplate) {
                            replacementContainer.linkTemplate = container.linkTemplate;
                        }
                    }
                }
                
                // Process the replacement container
                return this.watchContainer(replacementContainer, skipRegistryCheck);
            }

            logContainer.info(`No replacement found, removing container ${container.id}`);
            storeContainer.deleteContainer(container.id);
            return { container: null, changed: false };
        }

        // Update container with current version info
        containerWithResult.status = dockerContainer.State.Status;
        containerWithResult.image.id = dockerContainer.Image;

        // Process version checking logic
        if (!skipRegistryCheck) {
            containerWithResult.result = await this.findNewVersion(containerWithResult, logContainer);
        }

        // Always update store with current running container state
        const containerReport = this.mapContainerToContainerReport(containerWithResult);
        event.emitContainerReport(containerReport);
        return containerReport;
    } catch (e) {
        logContainer.warn(`Error processing container ${container.id}: ${e.message}`);
        containerWithResult.error = { message: e.message };
        return { container: containerWithResult, changed: false };
    }
}

    /**
     * Get all containers to watch.
     * @returns {Promise<unknown[]>}
     */
    async getContainers() {
        const listContainersOptions = {};
        if (this.configuration.watchall) {
            listContainersOptions.all = true;
        }
        const containers = await this.dockerApi.listContainers(listContainersOptions);

        // Filter on containers to watch
        const filteredContainers = containers
            .filter(
                (container) => isContainerToWatch(
                    container.Labels[wudWatch],
                    this.configuration.watchbydefault,
                ),
            );
        const containerPromises = filteredContainers
            .map((container) => this.addImageDetailsToContainer(
                container,
                container.Labels[wudTagInclude],
                container.Labels[wudTagExclude],
                container.Labels[wudTagTransform],
                container.Labels[wudLinkTemplate],
                container.Labels[wudDisplayName],
                container.Labels[wudDisplayIcon],
            ));
        let containersWithImage = await Promise.all(containerPromises);

        // Filter out undefined containers and deduplicate
        containersWithImage = containersWithImage.filter(c => c !== undefined);

        // Log containers after deduplication
        this.log.debug(`After deduplication: ${containersWithImage.length} containers`);
        containersWithImage.forEach(c => {
            this.log.debug(`Container: ${c.name} (${c.id}) - ${c.status}`);
        });

        // Prune old containers from the store
        try {
            const containersFromTheStore = storeContainer.getContainers({ watcher: this.name });
            const storeContainerCount = containersFromTheStore.length;
            this.log.debug(`Found ${storeContainerCount} containers in store`);
            
            pruneOldContainers(containersWithImage, containersFromTheStore);
            
            // Verify store state after pruning
            const afterPruneCount = storeContainer.getContainers({ watcher: this.name }).length;
            this.log.debug(`After pruning: ${afterPruneCount} containers in store`);
        } catch (e) {
            this.log.warn(`Error when trying to prune the old containers (${e.message})`);
        }

        // Update metrics
        getWatchContainerGauge().set({
            type: this.type,
            name: this.name,
        }, containersWithImage.length);

        // Return the deduplicated and pruned containers
        return containersWithImage;
    }

    /**
     * Update the status of a specific container without querying external registries.
     * @param {Object} container - The container object to update.
     * @returns {Object|null} - The updated container object or null if the container is no longer running.
     */
    async updateContainerStatus(container) {
        const logContainer = this.log.child({ container: fullName(container) });

        try {
            // Get the latest container info from Docker API
            const dockerContainer = await this.dockerApi.getContainer(container.id).inspect();

            if (dockerContainer.State.Status !== 'running') {
                logContainer.info(`Container ${container.name} is no longer running.`);
                storeContainer.deleteContainer(container.id);
                return null;
            }

            // Update container status and image ID
            container.status = dockerContainer.State.Status;
            container.image.id = dockerContainer.Image;

            // Check if the image ID has changed, indicating an update
            if (container.image.id !== dockerContainer.Image) {
                logContainer.info(`Container ${container.name} has a new image ID.`);
            }

            // Update the store with the new container data
            const updatedContainer = storeContainer.updateContainer(container);

            return updatedContainer;
        } catch (error) {
            logContainer.error(`Error updating container ${container.name}: ${error.message}`);
            throw error;
        }
    }

    /**
     * Find new version for a Container.
     */

    /* eslint-disable-next-line */
    async findNewVersion(container, logContainer) {
        const registryProvider = getRegistry(container.image.registry.name);
        const result = { tag: container.image.tag.value };

        if (!registryProvider) {
            logContainer.error(`Unsupported registry (${container.image.registry.name})`);
            return result;
        }

        // Get all available tags
        const tags = await registryProvider.getTags(container.image);

        // Populate imageDigestMap only when necessary
        let imageDigestMap = null;
        if (container.image.digest.watch) {
            imageDigestMap = new Map();

            for (const tag of tags) {
                const digest = await registryProvider.getImageManifestDigest({
                    ...container.image,
                    tag: { value: tag },
                });

                if (digest) {
                    if (!imageDigestMap.has(digest.digest)) {
                        imageDigestMap.set(digest.digest, { tags: [] });
                    }
                    imageDigestMap.get(digest.digest).tags.push(tag);
                }
            }
        }

        // Get candidate tags using the digest map if applicable
        const tagsCandidates = getTagCandidates(container, tags, logContainer, imageDigestMap);

        if (container.image.digest.watch && container.image.digest.repo) {
            const imageToGetDigestFrom = JSON.parse(JSON.stringify(container.image));
            if (tagsCandidates.length > 0) {
                [imageToGetDigestFrom.tag.value] = tagsCandidates;
            }

            const remoteDigest = await registryProvider.getImageManifestDigest(imageToGetDigestFrom);

            result.digest = remoteDigest.digest;
            result.created = remoteDigest.created;
        }

        // The first one in the array is the highest
        if (tagsCandidates && tagsCandidates.length > 0) {
            [result.tag] = tagsCandidates;
        }

        return result;
    }


    async addImageDetailsToContainer(
        container,
        includeTags,
        excludeTags,
        transformTags,
        linkTemplate,
        displayName,
        displayIcon,
    ) {
        const containerId = container.Id;

        // First verify container exists and is running
        try {
            const containerInspect = await this.dockerApi.getContainer(containerId).inspect();
            if (containerInspect.State.Status !== 'running') {
                const containerInStore = storeContainer.getContainer(containerId);
                if (containerInStore && containerInStore.watcher === this.name) {
                    this.log.debug(`Removing non-running container ${containerId} from store`);
                    storeContainer.deleteContainer(containerId);
                }
                return undefined;
            }
        } catch (e) {
            const containerInStore = storeContainer.getContainer(containerId);
            if (containerInStore && containerInStore.watcher === this.name) {
                this.log.debug(`Removing non-existent container ${containerId} from store`);
                storeContainer.deleteContainer(containerId);
            }
            return undefined;
        }

        // Check store for existing container
        const containerInStore = storeContainer.getContainer(containerId);
        if (containerInStore !== undefined && 
            containerInStore.error === undefined && 
            containerInStore.watcher === this.name) {
            if (containerInStore.status === 'running') {
                this.log.debug(`Container ${containerInStore.id} found in store and running`);
                return containerInStore;
            }
            this.log.debug(`Removing non-running container ${containerId} from store`);
            storeContainer.deleteContainer(containerId);
        }

        // Get container image details
        const image = await this.dockerApi.getImage(container.Image).inspect();
        
        // Get project label dynamically
        const projectLabel = container.Labels['com.docker.compose.project'] || null;

        // Get useful properties
        const containerName = getContainerName(container);
        const status = container.State;
        const architecture = image.Architecture;
        const os = image.Os;
        const variant = image.Variant;
        const created = image.Created;
        const repoDigest = getRepoDigest(image);
        const imageId = image.Id;

        // Parse image to get registry, organization...
        let imageNameToParse = container.Image;
        if (imageNameToParse.includes('sha256:')) {
            if (!image.RepoTags || image.RepoTags.length === 0) {
                this.log.warn(`Cannot get a reliable tag for this image [${imageNameToParse}]`);
                return Promise.resolve();
            }
            [imageNameToParse] = image.RepoTags;
        }
        
        const parsedImage = parse(imageNameToParse);
        const tagName = parsedImage.tag || 'latest';
        const parsedTag = parseSemver(transformTag(transformTags, tagName));
        const isSemver = parsedTag !== null && parsedTag !== undefined;
        const watchDigest = isDigestToWatch(
            container.Labels[wudWatchDigest],
            isSemver,
        );
        
        if (!isSemver && !watchDigest) {
            this.log.warn('Image is not a semver and digest watching is disabled so wud won\'t report any update. Please review the configuration to enable digest watching for this container or exclude this container from being watched');
        }

        return normalizeContainer({
            id: containerId,
            name: containerName,
            status,
            watcher: this.name,
            includeTags,
            excludeTags,
            transformTags,
            linkTemplate,
            displayName,
            displayIcon,
            compose_project: projectLabel,
            image: {
                id: imageId,
                registry: {
                    url: parsedImage.domain,
                },
                name: parsedImage.path,
                tag: {
                    value: tagName,
                    semver: isSemver,
                },
                digest: {
                    watch: watchDigest,
                    repo: repoDigest,
                },
                architecture,
                os,
                variant,
                created,
            },
            result: {
                tag: tagName,
            },
        });
    }

    /**
     * Process a Container with result and map to a containerReport.
     * @param containerWithResult
     * @return {*}
     */
    mapContainerToContainerReport(containerWithResult) {
        const logContainer = this.log.child({ container: fullName(containerWithResult) });
        const containerReport = {
            container: containerWithResult,
            changed: false,
        };

        // Find container in db & compare
        const containerInDb = storeContainer.getContainer(containerWithResult.id);

        // Not found in DB? => Save it
        if (!containerInDb) {
            logContainer.debug('Container watched for the first time');
            containerReport.container = storeContainer.insertContainer(containerWithResult);
            containerReport.changed = true;

            // Found in DB? => update it
        } else {
            containerReport.container = storeContainer.updateContainer(containerWithResult);
            containerReport.changed = containerInDb.resultChanged(containerReport.container)
                && containerWithResult.updateAvailable;
        }
        return containerReport;
    }
}

module.exports = Docker;