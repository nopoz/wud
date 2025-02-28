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
    
    // Check if this is a container we have in our store
    const existingContainers = storeContainer.getContainers({ 
      name: name
    }).filter(c => {
      const cWatcher = c.watcher || '';
      return watcherName === 'local' ? 
        (!cWatcher || cWatcher === 'local') : 
        (cWatcher === watcherName);
    });
    
    // Get the full details of the Docker container
    const dockerContainer = await watcherInstance.dockerApi.getContainer(runningContainer.Id).inspect();
    const dockerImage = await watcherInstance.dockerApi.getImage(dockerContainer.Image).inspect();
    
    // Find the container in store with update information
    const containerWithUpdateInfo = existingContainers.find(c => 
      c.updateKind && c.updateKind.remoteValue && c.result
    );
    
    let updatedContainer;
    
    if (existingContainers.some(c => c.id === runningContainer.Id)) {
      // Get the existing container from store
      const existingContainer = existingContainers.find(c => c.id === runningContainer.Id);
      
      // Update with latest Docker info
      updatedContainer = {
        ...existingContainer,
        status: dockerContainer.State.Status,
        image: {
          ...existingContainer.image,
          id: dockerContainer.Image
        }
      };
      
      // If dockerImage has RepoTags, use the first one to update the tag
      if (dockerImage.RepoTags && dockerImage.RepoTags.length > 0) {
        const tagName = dockerImage.RepoTags[0].split(':')[1] || 'latest';
        
        // Update the tag information
        updatedContainer.image.tag = {
          ...updatedContainer.image.tag,
          value: tagName
        };
        
        // Force updateAvailable to false if the tag matches the remoteValue
        if (updatedContainer.updateKind && 
            updatedContainer.updateKind.remoteValue === tagName) {
          console.log(`Container ${name} appears to be updated to target version ${tagName}`);
          updatedContainer.updateAvailable = false;
          updatedContainer.updateKind.localValue = tagName;
        }
        
        // If we don't have update info but there's another container with it
        if ((!updatedContainer.updateKind || !updatedContainer.result) && containerWithUpdateInfo) {
          console.log(`Transferring update info to container ${runningContainer.Id}`);
          updatedContainer.updateKind = containerWithUpdateInfo.updateKind;
          updatedContainer.result = containerWithUpdateInfo.result;
          
          // If the current tag matches the remote value, mark as updated
          if (updatedContainer.updateKind && 
              updatedContainer.updateKind.remoteValue === tagName) {
            updatedContainer.updateAvailable = false;
            updatedContainer.updateKind.localValue = tagName;
          }
          
          // Transfer tag filtering metadata
          if (containerWithUpdateInfo.includeTags !== null && containerWithUpdateInfo.includeTags !== undefined) {
            updatedContainer.includeTags = containerWithUpdateInfo.includeTags;
          }
          if (containerWithUpdateInfo.excludeTags !== null && containerWithUpdateInfo.excludeTags !== undefined) {
            updatedContainer.excludeTags = containerWithUpdateInfo.excludeTags;
          }
          if (containerWithUpdateInfo.transformTags !== null && containerWithUpdateInfo.transformTags !== undefined) {
            updatedContainer.transformTags = containerWithUpdateInfo.transformTags;
          }
          if (containerWithUpdateInfo.linkTemplate !== null && containerWithUpdateInfo.linkTemplate !== undefined) {
            updatedContainer.linkTemplate = containerWithUpdateInfo.linkTemplate;
          }
        }
      }
      
      // Always add a success notification if the container was updated
      if (!updatedContainer.notification) {
        updatedContainer.notification = {
          message: `Update for ${name} completed successfully.`,
          level: 'success'
        };
      }
    } else {
      console.log(`Creating new container record for ${runningContainer.Id}`);
      
      // This is a new container, we need to create it in the store
      // Use the Docker watcher to add proper image details
      const newContainer = await watcherInstance.addImageDetailsToContainer(runningContainer);
      
      // Transfer update info from old container if available
      if (containerWithUpdateInfo) {
        console.log(`Transferring update info from old container to new container`);
        
        // Copy update information
        newContainer.updateKind = containerWithUpdateInfo.updateKind;
        newContainer.result = containerWithUpdateInfo.result;
        
        // Set update flags based on tag comparison
        if (newContainer.updateKind && 
            newContainer.image.tag.value === newContainer.updateKind.remoteValue) {
          newContainer.updateAvailable = false;
          newContainer.updateKind.localValue = newContainer.updateKind.remoteValue;
        }
        
        // Copy notification
        newContainer.notification = {
          message: `Update for ${name} completed successfully.`,
          level: 'success'
        };
        
        // Transfer tag filtering metadata
        if (containerWithUpdateInfo.includeTags !== null && containerWithUpdateInfo.includeTags !== undefined) {
          newContainer.includeTags = containerWithUpdateInfo.includeTags;
        }
        if (containerWithUpdateInfo.excludeTags !== null && containerWithUpdateInfo.excludeTags !== undefined) {
          newContainer.excludeTags = containerWithUpdateInfo.excludeTags;
        }
        if (containerWithUpdateInfo.transformTags !== null && containerWithUpdateInfo.transformTags !== undefined) {
          newContainer.transformTags = containerWithUpdateInfo.transformTags;
        }
        if (containerWithUpdateInfo.linkTemplate !== null && containerWithUpdateInfo.linkTemplate !== undefined) {
          newContainer.linkTemplate = containerWithUpdateInfo.linkTemplate;
        }
      }
      
      updatedContainer = newContainer;
    }
    
    // Save the updated container to the store
    const savedContainer = storeContainer.updateContainer(updatedContainer);
    
    // Now clean up any outdated containers
    for (const existingContainer of existingContainers) {
      if (existingContainer.id !== savedContainer.id) {
        console.log(`Removing outdated container ${existingContainer.id}`);
        storeContainer.deleteContainer(existingContainer.id);
      }
    }
    
    // Return the updated container
    res.status(200).json(savedContainer);
    
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
