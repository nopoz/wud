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
        console.error('SSE connection error:', error);
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

async function refreshContainer(req, res) {
  const { name, watcher } = req.query;

  if (!name || !watcher) {
    return res.status(400).json({ error: 'Missing name or watcher parameter' });
  }

  const watcherInstance = getWatchers()[`watcher.docker.${watcher}`];
  if (!watcherInstance) {
    return res.status(404).json({ error: `Watcher ${watcher} not found` });
  }

  try {
    // Fetch containers watched by this watcher
    const containers = await watcherInstance.getContainers();

    // Find the container by name
    const container = containers.find(c => c.name === name);
    if (!container) {
      return res.status(404).json({ error: `Container ${name} not found` });
    }

    // Update container information without querying registries
    const updatedContainer = await watcherInstance.updateContainerStatus(container);

    // Check if the container is still running
    if (!updatedContainer) {
      return res.status(404).json({ error: `Container ${name} is no longer running` });
    }

    // Update the store with the new container data if not already updated
    storeContainer.updateContainer(updatedContainer);

    // Return the updated container
    res.status(200).json(updatedContainer);
  } catch (error) {
    console.error(`Error refreshing container ${name}:`, error);
    res.status(500).json({ error: `Error refreshing container: ${error.message}` });
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
