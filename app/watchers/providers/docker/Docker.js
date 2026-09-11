const fs = require('fs');
const Dockerode = require('dockerode');
const cron = require('node-cron');
const parse = require('parse-docker-image-name');
const debounce = require('just-debounce');
const { parse: parseSemver, isGreater: isGreaterSemver, transform: transformTag } = require('../../../tag');
const event = require('../../../event');
const {
    hosakaWatch,
    hosakaTagInclude,
    hosakaTagExclude,
    hosakaTagTransform,
    hosakaWatchDigest,
    hosakaLinkTemplate,
    hosakaDisplayName,
    hosakaDisplayIcon,
    hosakaTriggerInclude,
    hosakaTriggerExclude,
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

    logContainer.debug(`[TagFilter] Starting with ${tags.length} tags from registry`);
    logContainer.debug(`[TagFilter] Current tag: ${container.image.tag.value}, semver: ${container.image.tag.semver}`);
    logContainer.debug(`[TagFilter] includeTags: ${container.includeTags}, transformTags: ${container.transformTags}`);

    // Match include tag regex
    if (container.includeTags) {
        const includeTagsRegex = new RegExp(container.includeTags);
        const beforeCount = filteredTags.length;
        filteredTags = filteredTags.filter((tag) => includeTagsRegex.test(tag));
        logContainer.debug(`[TagFilter] After include regex: ${filteredTags.length} tags (was ${beforeCount})`);
        if (filteredTags.length > 0 && filteredTags.length <= 10) {
            logContainer.debug(`[TagFilter] Matching tags: ${filteredTags.join(', ')}`);
        }
    }

    // Match exclude tag regex
    if (container.excludeTags) {
        const excludeTagsRegex = new RegExp(container.excludeTags);
        const beforeCount = filteredTags.length;
        filteredTags = filteredTags.filter((tag) => !excludeTagsRegex.test(tag));
        logContainer.debug(`[TagFilter] After exclude regex: ${filteredTags.length} tags (was ${beforeCount})`);
    }

    const matchingDigest = imageDigestMap?.get(container.image.digest?.value);

    if (matchingDigest) {
        filteredTags = tags.filter((tag) => matchingDigest.tags.includes(tag));
        logContainer.debug(`[TagFilter] After digest map filter: ${filteredTags.length} tags`);
    } else {
        // Fallback exclusion of "latest" unless it matches `includeTags`
        if (container.includeTags && !new RegExp(container.includeTags).test('latest')) {
            filteredTags = filteredTags.filter((tag) => tag !== 'latest');
        }
    }

    // Always drop Cosign signature tags (e.g. "1.2.3.sig"); they would otherwise
    // coerce to a real semver and leak in as bogus candidates.
    filteredTags = filteredTags.filter((tag) => !tag.endsWith('.sig'));
    logContainer.debug(`[TagFilter] After .sig drop: ${filteredTags.length} tags`);

    const noUserInclude = !container.includeTags;

    // Drop content-addressed "sha..." tags unless the user pinned an include
    // regex (they coerce to bogus high semvers otherwise).
    if (noUserInclude) {
        filteredTags = filteredTags.filter((tag) => !tag.startsWith('sha'));
        logContainer.debug(`[TagFilter] After sha drop: ${filteredTags.length} tags`);
    }

    // Tag-prefix propagation: keep only tags sharing the current tag's
    // non-numeric prefix (so a "v1.2.3" container is not offered a bare
    // "1.3.0"). Skipped when the user pinned an include regex, or when the
    // digest map already aliased the candidates (aliases of the same image
    // legitimately differ in prefix, e.g. local "8" -> alias "8.0.0").
    if (noUserInclude && !matchingDigest) {
        const currentTag = container.image.tag.value;
        const prefixMatch = currentTag.match(/^(.*?)(\d+.*)$/);
        const currentPrefix = prefixMatch ? prefixMatch[1] : '';
        if (currentPrefix) {
            filteredTags = filteredTags.filter((tag) => tag.startsWith(currentPrefix));
        } else {
            filteredTags = filteredTags.filter((tag) => /^\d/.test(tag));
        }
        logContainer.debug(`[TagFilter] After prefix propagation ('${currentPrefix}'): ${filteredTags.length} tags`);
    }

    if (filteredTags.length === 0) {
        logContainer.warn('No tags found after filtering. Check regex filters.');
    }

    const beforeSemver = filteredTags.length;
    filteredTags = filteredTags
        .filter((tag) => parseSemver(transformTag(container.transformTags, tag)) !== null);

    // For tags not pinned by the digest map, never propose a downgrade: keep
    // only tags greater than or equal to the current one (isGreaterSemver is a
    // >= comparison). Digest-matched tags are aliases of the same image and are
    // left untouched.
    if (!matchingDigest) {
        filteredTags = filteredTags.filter((tag) =>
            isGreaterSemver(
                transformTag(container.transformTags, tag),
                transformTag(container.transformTags, container.image.tag.value),
            ));
    }

    filteredTags = filteredTags.sort((t1, t2) =>
        (isGreaterSemver(transformTag(container.transformTags, t2), transformTag(container.transformTags, t1)) ? 1 : -1));
    logContainer.debug(`[TagFilter] After semver filter + sort: ${filteredTags.length} tags (was ${beforeSemver})`);

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
 * Carry non-derived state from an old (about to be pruned) store row to the
 * new live container that replaced it after a recreation (image update).
 *
 * Only fields that are NOT computed by the model are transferred:
 * - user/label metadata (filled only when the live container lacks it);
 * - a transient success notification, when the new tag matches the update
 *   target the old row was tracking.
 * `updateAvailable` / `updateKind` are computed getters (see model/container.js)
 * and self-correct from the new image tag + result, so they are never set here.
 *
 * @param {Object} oldRow - the previous store row (different container id)
 * @param {Object} newLive - the freshly built live container (mutated in place)
 */
function carryUpdateState(oldRow, newLive) {
    const metadataFields = ['includeTags', 'excludeTags', 'transformTags', 'linkTemplate', 'triggerInclude', 'triggerExclude'];
    metadataFields.forEach((field) => {
        if ((newLive[field] === undefined || newLive[field] === null)
            && oldRow[field] !== undefined && oldRow[field] !== null) {
            newLive[field] = oldRow[field];
        }
    });

    const target = oldRow.updateKind && oldRow.updateKind.remoteValue;
    if (target && newLive.image && newLive.image.tag && newLive.image.tag.value === target) {
        newLive.notification = {
            message: `Update for ${newLive.name} completed successfully.`,
            level: 'success',
            timestamp: Date.now(),
        };
    }
    return newLive;
}

/**
 * Reconcile the store for this watcher against the live Docker state.
 *
 * The set of live container ids reported by the host is authoritative: any
 * store row for this watcher whose id is not live is removed. When a removed
 * row was replaced by a recreated container with the same name but a new id
 * (an image update), its non-derived state is carried over to the live row
 * before the old row is deleted.
 *
 * @param {String} watcherName
 * @param {Array} liveContainers - live containers built from the Docker API
 * @param {Object} logger
 */
function reconcileStore(watcherName, liveContainers, logger) {
    const storeRows = storeContainer.getContainers({ watcher: watcherName });
    const liveIds = new Set(liveContainers.map((c) => c.id));

    storeRows.forEach((row) => {
        if (liveIds.has(row.id)) {
            return;
        }
        // Row is gone from Docker. If a live container shares its name, this is
        // a recreation (new id) => carry state forward before pruning the old row.
        const replacement = liveContainers.find(
            (c) => c.name === row.name && c.id !== row.id,
        );
        if (replacement) {
            logger.info(`Container ${row.name} recreated (${row.id} -> ${replacement.id})`);
            carryUpdateState(row, replacement);
        } else {
            logger.debug(`Pruning stale container ${row.id} (${row.name})`);
        }
        storeContainer.deleteContainer(row.id);
    });
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
 * @param hosakaWatchLabelValue the value of the hosaka.watch label
 * @param watchByDefault true if containers must be watched by default
 * @returns {boolean}
 */
function isContainerToWatch(hosakaWatchLabelValue, watchByDefault) {
    return hosakaWatchLabelValue !== undefined && hosakaWatchLabelValue !== '' ? hosakaWatchLabelValue.toLowerCase() === 'true' : watchByDefault;
}

/**
 * Return true if container digest must be watched.
 * @param hosakaWatchDigestLabelValue the value of hosaka.watch.digest label
 * @param isSemver if image is semver
 * @returns {boolean|*}
 */
function isDigestToWatch(hosakaWatchDigestLabelValue, isSemver) {
    let result = false;
    if (isSemver) {
        if (hosakaWatchDigestLabelValue !== undefined && hosakaWatchDigestLabelValue !== '') {
            result = hosakaWatchDigestLabelValue.toLowerCase() === 'true';
        }
    } else {
        result = true;
        if (hosakaWatchDigestLabelValue !== undefined && hosakaWatchDigestLabelValue !== '') {
            result = hosakaWatchDigestLabelValue.toLowerCase() === 'true';
        }
    }
    return result;
}

/**
 * Docker Watcher Component.
 */
class Docker extends Component {
    getConfigurationSchema() {
        return this.joi.object().keys({
            socket: this.joi.string().default('/var/run/docker.sock'),
            host: this.joi.string(),
            port: this.joi.number().port().default(2375),
            cafile: this.joi.string(),
            certfile: this.joi.string(),
            keyfile: this.joi.string(),
            cron: this.joi.string()
                .custom((value, helpers) => (cron.validate(value)
                    ? value
                    : helpers.message('"cron" must be a valid cron expression')))
                .default('0 * * * *'),
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
        this.stopped = false;
        this.eventReconnectDelay = 0;
        this.initWatcher();
        if (this.configuration.watchdigest !== undefined) {
            this.log.warn('HOSAKA_WATCHER_{watcher_name}_WATCHDIGEST environment variable is deprecated and won\'t be supported in upcoming versions');
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
        this.stopped = true;
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
        if (this.eventReconnectTimeout) {
            clearTimeout(this.eventReconnectTimeout);
            this.eventReconnectTimeout = undefined;
        }
        if (this.eventStream) {
            try {
                this.eventStream.destroy();
            } catch (e) {
                this.log.debug(`Error destroying event stream (${e.message})`);
            }
            this.eventStream = undefined;
        }
        if (this.triggerWatchListener) {
            event.unregisterTriggerWatch(this.triggerWatchListener);
            delete this.triggerWatchListener;
        }
    }

    /**
     * Schedule a reconnection to the Docker event stream with capped backoff.
     * Important for remote watchers (TCP): if the stream drops, status updates
     * stop silently until the next cron without this.
     * @return {void}
     */
    scheduleEventReconnect() {
        if (this.stopped || this.eventReconnectTimeout) {
            return;
        }
        this.eventReconnectDelay = Math.min(
            (this.eventReconnectDelay || 0) === 0 ? 1000 : this.eventReconnectDelay * 2,
            60000,
        );
        this.log.warn(`Docker event stream lost; reconnecting in ${this.eventReconnectDelay}ms`);
        this.eventReconnectTimeout = setTimeout(() => {
            this.eventReconnectTimeout = undefined;
            this.listenDockerEvents();
        }, this.eventReconnectDelay);
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
                this.scheduleEventReconnect();
                return;
            }

            // Track the stream so it can be torn down on deregister / reconnect
            this.eventStream = stream;

            // Connection (re)established: reset backoff and resync to catch any
            // create/destroy missed while disconnected.
            if (this.eventReconnectDelay) {
                this.eventReconnectDelay = 0;
                if (this.watchCronDebounced) {
                    this.watchCronDebounced();
                }
            }

            stream.on('data', (chunk) => this.onDockerEvent(chunk));
            stream.on('error', (streamErr) => {
                this.log.warn(`Docker event stream error [${streamErr.message}]`);
                this.scheduleEventReconnect();
            });
            stream.on('end', () => this.scheduleEventReconnect());
            stream.on('close', () => this.scheduleEventReconnect());
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

        const containerReports = await this.watch();
        const validContainerReports = containerReports.filter(report => report.container !== null);
        const containerReportsCount = validContainerReports.length;
        const containerUpdatesCount = validContainerReports
            .filter((containerReport) => containerReport.container.updateAvailable).length;
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
            // The container is no longer running. Remove it from the store; if it
            // was recreated under a new id (an update), the next watch cycle's
            // reconciliation carries its state forward to the live container.
            logContainer.info(`Container ${container.id} is not running, removing from store`);
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
                    container.Labels[hosakaWatch],
                    this.configuration.watchbydefault,
                ),
            );
        const containerPromises = filteredContainers
            .map((container) => this.addImageDetailsToContainer(
                container,
                container.Labels[hosakaTagInclude],
                container.Labels[hosakaTagExclude],
                container.Labels[hosakaTagTransform],
                container.Labels[hosakaLinkTemplate],
                container.Labels[hosakaDisplayName],
                container.Labels[hosakaDisplayIcon],
                container.Labels[hosakaTriggerInclude],
                container.Labels[hosakaTriggerExclude],
            ));
        let containersWithImage = await Promise.all(containerPromises);

        // Filter out undefined containers and deduplicate
        containersWithImage = containersWithImage.filter(c => c !== undefined);

        // Log containers after deduplication
        this.log.debug(`After deduplication: ${containersWithImage.length} containers`);
        containersWithImage.forEach(c => {
            this.log.debug(`Container: ${c.name} (${c.id}) - ${c.status}`);
        });

        // Reconcile the store against live Docker state (authoritative per watcher)
        try {
            reconcileStore(this.name, containersWithImage, this.log);
            const afterCount = storeContainer.getContainers({ watcher: this.name }).length;
            this.log.debug(`After reconcile: ${afterCount} containers in store`);
        } catch (e) {
            this.log.warn(`Error when trying to reconcile the store (${e.message})`);
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

            // Narrow the (serial, per-tag) manifest fetch by the container's
            // include/exclude regex before hitting the registry. Only applied
            // when those labels are set; without a regex the full tag set is
            // kept so alias/digest resolution (e.g. a `latest` tag mapping to a
            // concrete version) is unchanged. Always keep the current tag so
            // the alias lookup for the running image still resolves.
            let tagsToManifest = tags;
            if (container.includeTags) {
                const includeTagsRegex = new RegExp(container.includeTags);
                tagsToManifest = tagsToManifest.filter((tag) => includeTagsRegex.test(tag));
            }
            if (container.excludeTags) {
                const excludeTagsRegex = new RegExp(container.excludeTags);
                tagsToManifest = tagsToManifest.filter((tag) => !excludeTagsRegex.test(tag));
            }
            const manifestTags = new Set([...tagsToManifest, container.image.tag.value]);

            for (const tag of manifestTags) {
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
        triggerInclude,
        triggerExclude,
    ) {
        const containerId = container.Id;
        // Read from the list response's merged labels so it is available before
        // the cached-row early-return below (image inspect happens after it).
        const imageSource = (container.Labels
            && container.Labels['org.opencontainers.image.source']) || undefined;

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
                // Backfill image.source onto rows written before this field
                // existed; base image details are otherwise cached and never
                // recomputed for a running container.
                if (imageSource && containerInStore.image && !containerInStore.image.source) {
                    containerInStore.image.source = imageSource;
                    storeContainer.updateContainer(containerInStore);
                }
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
            container.Labels[hosakaWatchDigest],
            isSemver,
        );
        
        if (!isSemver && !watchDigest) {
            this.log.warn('Image is not a semver and digest watching is disabled so Hosaka won\'t report any update. Please review the configuration to enable digest watching for this container or exclude this container from being watched');
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
            triggerInclude,
            triggerExclude,
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
                source: imageSource,
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