const express = require('express');
const nocache = require('nocache');
const storeContainer = require('../store/container');
const registry = require('../registry');
const { getServerConfiguration, getTriggerConfigurations } = require('../configuration');
const HttpTrigger = require('../triggers/providers/http/Http');
const ScriptTrigger = require('../triggers/providers/script/Script');
const { scriptOutputEmitter } = ScriptTrigger;

const router = express.Router();

const serverConfiguration = getServerConfiguration();
const triggerConfigurations = getTriggerConfigurations();

const recentContainerUpdates = new Map();
const LOGS_RETENTION_TIME = 5 * 60 * 1000; // Keep logs for 5 minutes

/**
 * Initialize a trigger based on its type.
 * @param {String} triggerType - Type of the trigger ('http' or 'script').
 * @param {Object} triggerConfig - The trigger configuration.
 * @returns {HttpTrigger|ScriptTrigger} - Initialized trigger instance.
 */
function initializeTrigger(triggerType, triggerConfig) {
    if (!triggerConfig) {
        throw new Error(`No configuration provided for ${triggerType} trigger`);
    }
    switch (triggerType) {
        case 'http':
            return new HttpTrigger('http', triggerConfig);
        case 'script':
            return new ScriptTrigger('script', triggerConfig);
        default:
            throw new Error(`Unknown trigger type: ${triggerType}`);
    }
}

/**
 * Extract triggers with 'install' enabled.
 * @returns {Array} - List of trigger objects with install enabled.
 */
function getTriggersWithInstall() {
    const triggersWithInstall = [];

    ['http', 'script'].forEach((triggerType) => {
        const triggers = triggerConfigurations[triggerType] || {};
        Object.keys(triggers).forEach((triggerName) => {
            const triggerConfig = triggers[triggerName];
            if (String(triggerConfig.install).toLowerCase() === 'true') {
                triggersWithInstall.push({ triggerType, triggerName, triggerConfig });
            }
        });
    });

    return triggersWithInstall;
}

/**
 * Get all containers with 'install' flags.
 * @param {Object} req
 * @param {Object} res
 */
function getContainers(req, res) {
    const { query } = req;
    const containers = getContainersFromStore(query);

    // Add cache control headers
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });

    const triggersWithInstall = getTriggersWithInstall();
    let installEnabled = false;

    if (triggersWithInstall.length === 1) {
        installEnabled = true;
    } else if (triggersWithInstall.length > 1) {
        installEnabled = 'multiple';
        console.warn('Multiple triggers have install enabled; install action will be disabled.');
    }

    const containersWithInstallFlag = containers.map((container) => ({
        ...container,
        install: installEnabled,
    }));

    res.status(200).json(containersWithInstallFlag);
}


/**
 * Install a container by ID.
 * @param {Object} req
 * @param {Object} res
 */
async function installContainer(req, res) {
    const { id } = req.params;

    const triggersWithInstall = getTriggersWithInstall();

    if (triggersWithInstall.length === 0) {
        return res.status(403).json({ error: 'Install not enabled' });
    } else if (triggersWithInstall.length > 1) {
        return res.status(400).json({
            error: 'Multiple install triggers are configured. Please ensure only one trigger has install enabled.',
        });
    }

    const { triggerType, triggerName, triggerConfig } = triggersWithInstall[0];
    const container = storeContainer.getContainer(id);

    if (!container) {
        console.warn(`Container with ID ${id} not found.`);
        return res.sendStatus(404);
    }

    // Initialize container logs storage
    recentContainerUpdates.set(id, {
        name: container.name,
        logs: []
    });

    // Set up event handlers before starting the installation
    const handlers = setupScriptHandlers(id, container.name);

    try {
        const trigger = initializeTrigger(triggerType, triggerConfig);
        await trigger.install(container);

        // Set notification in container
        container.notification = {
            message: `Update for ${container.name} completed successfully.`,
            level: 'success',
        };
        // Update the container in the store
        storeContainer.updateContainer(container);

        res.status(200).json({ success: true });
    } catch (e) {
        console.error(`Error installing container ${id}: ${e.message}`);

        container.notification = {
            message: `Update for ${container.name} failed: ${e.message}`,
            level: 'error',
        };
        storeContainer.updateContainer(container);

        res.status(500).json({
            error: `Error when installing container ${id} (${e.message})`,
        });
    }
}

/**
 * Clear notification for a container by ID.
 * @param {Object} req
 * @param {Object} res
 */
function clearContainerNotification(req, res) {
    const { id } = req.params;
    const container = storeContainer.getContainer(id);

    if (container) {
        delete container.notification;
        storeContainer.updateContainer(container);
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
}

/**
 * Watch all containers.
 * @param {Object} req
 * @param {Object} res
 */
async function watchContainers(req, res) {
    try {
        await Promise.all(Object.values(getWatchers()).map((watcher) => watcher.watch()));
        getContainers(req, res);
    } catch (e) {
        res.status(500).json({ error: `Error when watching images (${e.message})` });
    }
}

/**
 * Watch a specific container by ID.
 * @param {Object} req
 * @param {Object} res
 */
async function watchContainer(req, res) {
    const { id } = req.params;
    const container = storeContainer.getContainer(id);

    if (!container) {
        return res.sendStatus(404);
    }

    // Normalize watcher name if empty (treat as local)
    let watcherName = container.watcher || '';
    if (!watcherName.trim()) {
        watcherName = 'local';
    }

    const watcher = getWatchers()[`watcher.docker.${container.watcher}`];
    if (!watcher) {
        return res.status(500).json({ error: `No provider found for container ${id}` });
    }

    try {
        const containers = await watcher.getContainers();
        const containerFound = containers.find((c) => c.id === container.id);

        if (!containerFound) {
            return res.sendStatus(404);
        }

        const containerReport = await watcher.watchContainer(container);
        res.status(200).json(containerReport.container);
    } catch (e) {
        res.status(500).json({ error: `Error when watching container ${id} (${e.message})` });
    }
}

/**
 * Get a specific container by ID.
 * @param {Object} req
 * @param {Object} res
 */
function getContainer(req, res) {
    const { id } = req.params;
    const container = storeContainer.getContainer(id);

    if (container) {
        // Add cache control headers
        res.set({
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        res.status(200).json(container);
    } else {
        res.sendStatus(404);
    }
}

/**
 * Delete a container by ID.
 * @param {Object} req
 * @param {Object} res
 */
function deleteContainer(req, res) {
    if (!serverConfiguration.feature.delete) {
        return res.sendStatus(403);
    }

    const { id } = req.params;
    const container = storeContainer.getContainer(id);

    if (!container) {
        return res.sendStatus(404);
    }

    storeContainer.deleteContainer(id);
    res.sendStatus(204);
}

/**
 * Get all watchers.
 * @returns {Object}
 */
function getWatchers() {
    return registry.getState().watcher;
}

/**
 * Get containers from the store.
 * @param {Object} query
 * @returns {Array}
 */
function getContainersFromStore(query) {
    return storeContainer.getContainers(query);
}

/**
 * Stream script execution logs for a container installation.
 * @param {Object} req
 * @param {Object} res
 */
function streamInstallLogs(req, res) {
    const { id } = req.params;
    
    // Get container info
    const containerUpdate = recentContainerUpdates.get(id);
    
    if (!containerUpdate) {
        return res.status(404).json({ error: 'Container not found' });
    }

    const containerName = containerUpdate.name;

    // Set up SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no' // Disable nginx buffering
    });

    let closed = false;

    // Send initial connection message
    res.write(`data: ${JSON.stringify({ message: "Connected to log stream" })}\n\n`);

    // Send all existing logs in order
    const existingLogs = containerUpdate.logs || [];
    const sortedLogs = [...existingLogs].sort((a, b) => a.timestamp - b.timestamp);
    
    sortedLogs.forEach(log => {
        if (!closed) {
            try {
                res.write(`data: ${JSON.stringify(log)}\n\n`);
            } catch (error) {
                console.warn('Error writing log:', error);
                closed = true;
            }
        }
    });

    // Set up handlers for new logs
    const { onOutput, onComplete } = setupScriptHandlers(id, containerName);

    // Override the output handler to also send logs to the client
    const streamOutput = (data) => {
        if (!closed && (data.containerId === id || data.containerName === containerName)) {
            try {
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            } catch (error) {
                console.warn('Error writing to stream:', error);
                closed = true;
                cleanup();
            }
        }
    };

    // Add the streaming handler
    scriptOutputEmitter.on('output', streamOutput);

    const cleanup = () => {
        closed = true;
        scriptOutputEmitter.off('output', streamOutput);
        scriptOutputEmitter.off('output', onOutput);
        scriptOutputEmitter.off('complete', onComplete);
    };

    // Clean up on client disconnect or errors
    req.on('close', cleanup);
    req.on('error', (error) => {
    // Don't log ECONNRESET errors as they're expected when client disconnects
        if (error.code !== 'ECONNRESET') {
            console.error('SSE connection error:', error);
    }
    cleanup();
    });
}

function storeLog(containerId, containerName, message) {
    if (!recentContainerUpdates.has(containerId)) {
        recentContainerUpdates.set(containerId, {
            name: containerName,
            logs: []
        });
    }
    // Add the log with timestamp
    recentContainerUpdates.get(containerId).logs.push({
        containerId,
        containerName,
        message,
        timestamp: Date.now()
    });
}

function setupScriptHandlers(id, containerName) {
    const onOutput = (data) => {
        if (data.containerId === id || data.containerName === containerName) {
            storeLog(id, containerName, data.message);
        }
    };

    const onComplete = (data) => {
        if (data.containerId === id || data.containerName === containerName) {
            setTimeout(() => {
                recentContainerUpdates.delete(id);
            }, 5 * 60 * 1000); // Keep logs for 5 minutes after completion
        }
    };

    // Register handlers
    scriptOutputEmitter.on('output', onOutput);
    scriptOutputEmitter.on('complete', onComplete);

    return { onOutput, onComplete };
}

/**
 * Force refresh a container's status and image information directly from Docker.
 * This is a more aggressive refresh that ensures the container shows the correct
 * version information regardless of store state.
 * @param {Object} req
 * @param {Object} res
 */
async function refreshContainer(req, res) {
  const { name, watcher } = req.query;

  // Normalize watcher name if empty (treat as local)
  let watcherName = watcher || '';
  if (!watcherName || watcherName.trim() === '') {
    watcherName = 'local';
  }

  console.log(`Refreshing container ${name} (watcher: ${watcherName})`);

  // Handle local watcher vs remote watcher instances
  const watcherInstance = watcherName === 'local' ?
    getWatchers()['watcher.docker.local'] :
    getWatchers()[`watcher.docker.${watcherName}`];

  if (!watcherInstance) {
    return res.status(404).json({ error: `Watcher ${watcherName} not found` });
  }

  try {
    // Get containers directly from Docker API (source of truth)
    const dockerContainers = await watcherInstance.dockerApi.listContainers({
      filters: {
        name: [name]
      }
    });

    if (dockerContainers.length === 0) {
      return res.status(404).json({ error: `Container ${name} not found in Docker` });
    }

    // Find the running container
    const runningContainer = dockerContainers.find(c =>
      c.State === 'running' &&
      c.Names.some(n => n.replace('/', '') === name)
    );

    if (!runningContainer) {
      return res.status(404).json({ error: `No running container named ${name} found` });
    }

    // Get all existing containers with this name from our store
    const existingContainers = storeContainer.getContainers({
      name: name
    }).filter(c => {
      const cWatcher = c.watcher || '';
      return watcherName === 'local' ?
        (!cWatcher || cWatcher === 'local') :
        (cWatcher === watcherName);
    });

    // Find the container in store with update information
    // Note: Don't require 'result' as it may not be set yet after an update
    const containerWithUpdateInfo = existingContainers.find(c =>
      c.updateKind && c.updateKind.remoteValue
    );

    console.log(`Found ${existingContainers.length} existing containers in store`);
    console.log(`Container with update info: ${containerWithUpdateInfo ? containerWithUpdateInfo.id : 'none'}`);
    console.log(`Running container from Docker: ${runningContainer.Id}`);

    // Check if the running container already exists in our store
    const existingRunningContainer = existingContainers.find(c => c.id === runningContainer.Id);

    let updatedContainer;

    if (existingRunningContainer) {
      // Container exists in store - use watchContainer with skipRegistryCheck to update it
      console.log(`Container ${runningContainer.Id} exists in store, using watchContainer to refresh`);

      // Prepare the container with any update info we need to preserve
      const containerToWatch = { ...existingRunningContainer };

      // If this container doesn't have update info but another one does, transfer it
      if (!containerToWatch.updateKind && containerWithUpdateInfo && containerWithUpdateInfo.id !== existingRunningContainer.id) {
        console.log(`Transferring update info from ${containerWithUpdateInfo.id} to ${existingRunningContainer.id}`);
        containerToWatch.updateKind = containerWithUpdateInfo.updateKind;
        containerToWatch.result = containerWithUpdateInfo.result;

        // Transfer metadata
        transferContainerMetadata(containerWithUpdateInfo, containerToWatch);
      }

      // Use watchContainer with skipRegistryCheck=true to avoid rate limiting
      const containerReport = await watcherInstance.watchContainer(containerToWatch, true);
      updatedContainer = containerReport.container;

      // Check if we should mark as updated (tag matches remote value)
      if (updatedContainer && updatedContainer.updateKind && updatedContainer.updateKind.remoteValue) {
        const currentTag = updatedContainer.image?.tag?.value;
        if (currentTag === updatedContainer.updateKind.remoteValue) {
          console.log(`Container ${name} is now at target version ${currentTag}`);
          updatedContainer.updateAvailable = false;
          updatedContainer.updateKind.localValue = currentTag;
        }
      }

    } else {
      // This is a new container (container was recreated with new ID)
      console.log(`Container ${runningContainer.Id} is new, building from Docker data`);

      // Use addImageDetailsToContainer to properly build the container object
      updatedContainer = await watcherInstance.addImageDetailsToContainer(runningContainer);

      if (!updatedContainer) {
        return res.status(500).json({ error: `Failed to get container details for ${name}` });
      }

      // Transfer update info from old container if available
      if (containerWithUpdateInfo) {
        console.log(`Transferring update info from old container ${containerWithUpdateInfo.id}`);

        updatedContainer.updateKind = containerWithUpdateInfo.updateKind;
        updatedContainer.result = containerWithUpdateInfo.result;

        // Transfer metadata
        transferContainerMetadata(containerWithUpdateInfo, updatedContainer);

        // Check if we should mark as updated
        if (updatedContainer.updateKind && updatedContainer.updateKind.remoteValue) {
          const currentTag = updatedContainer.image?.tag?.value;
          if (currentTag === updatedContainer.updateKind.remoteValue) {
            console.log(`New container is at target version ${currentTag}`);
            updatedContainer.updateAvailable = false;
            updatedContainer.updateKind.localValue = currentTag;
          }
        }
      }

      // Save the new container to store
      updatedContainer = storeContainer.insertContainer(updatedContainer);
    }

    // Add success notification
    if (updatedContainer && !updatedContainer.notification) {
      updatedContainer.notification = {
        message: `Update for ${name} completed successfully.`,
        level: 'success'
      };
      updatedContainer = storeContainer.updateContainer(updatedContainer);
    }

    // Clean up old containers with different IDs
    for (const existingContainer of existingContainers) {
      if (updatedContainer && existingContainer.id !== updatedContainer.id) {
        console.log(`Removing outdated container ${existingContainer.id}`);
        storeContainer.deleteContainer(existingContainer.id);
      }
    }

    // Return the updated container
    res.status(200).json(updatedContainer);

  } catch (error) {
    console.error(`Error refreshing container ${name}:`, error);
    res.status(500).json({ error: `Error refreshing container: ${error.message}` });
  }
}

/**
 * Transfer metadata from source container to target container.
 * @param {Object} source - Source container with metadata
 * @param {Object} target - Target container to receive metadata
 */
function transferContainerMetadata(source, target) {
  const metadataFields = ['includeTags', 'excludeTags', 'transformTags', 'linkTemplate', 'link'];
  for (const field of metadataFields) {
    if (source[field] !== null && source[field] !== undefined) {
      target[field] = source[field];
    }
  }
}


/**
 * Initialize the router.
 * @returns {Router}
 */
function init() {
    router.use(nocache());
    router.get('/', getContainers);
    router.post('/watch', watchContainers);
    router.get('/:id', getContainer);
    router.delete('/:id', deleteContainer);
    router.post('/:id/watch', watchContainer);
    router.post('/:id/install', installContainer);
    router.post('/:id/clear-notification', clearContainerNotification);
    router.get('/:id/install/logs', streamInstallLogs);
    router.post('/refresh', refreshContainer);
    return router;
}

module.exports = {
    init,
    getContainersFromStore,
};
