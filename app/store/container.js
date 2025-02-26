/**
 * Container store.
 */
const { byString, byValues } = require('sort-es');
const log = require('../log').child({ component: 'store' });
const { validate: validateContainer } = require('../model/container');
const {
    emitContainerAdded,
    emitContainerUpdated,
    emitContainerRemoved,
} = require('../event');

let containers;

/**
 * Create container collections.
 * @param db
 */
function createCollections(db) {
    containers = db.getCollection('containers');
    if (containers === null) {
        log.info('Create Collection containers');
        containers = db.addCollection('containers');
    }
}

/**
 * Insert new Container.
 * @param container
 */
function insertContainer(container) {
    const containerToSave = validateContainer(container);
    containers.insert({
        data: containerToSave,
    });
    emitContainerAdded(containerToSave);
    return containerToSave;
}

/**
 * Update existing container.
 * @param container
 */
function updateContainer(container) {
    const containerToReturn = validateContainer(container);

    // Remove any existing containers with same name/watcher combo but different ID
    const existingContainers = containers.chain()
        .find({
            'data.name': container.name,
            'data.watcher': container.watcher
        })
        .data();

    for (const existing of existingContainers) {
        if (existing.data.id !== container.id) {
            console.log(`Removing old container record ${existing.data.id} for ${container.name}`);
            containers.remove(existing);
        }
    }

    // Now update/insert the new container
    const existingContainer = containers.findOne({ 'data.id': container.id });
    if (existingContainer) {
        containers.chain().find({ 'data.id': container.id }).remove();
    }

    containers.insert({ data: containerToReturn });
    emitContainerUpdated(containerToReturn);
    return containerToReturn;
}

/**
 * Get unique container key combining name, watcher, and registry.
 * @param {Object} container
 * @returns {String}
 */
function getContainerKey(container) {
    return `${container.name}-${container.watcher}-${container.image.registry.name}`;
}

/**
 * Get all (filtered) containers.
 * @param {Object} query
 * @returns {Array}
 */
function getContainers(query = {}) {
    const filter = {};
    Object.keys(query).forEach((key) => {
        filter[`data.${key}`] = query[key];
    });

    if (!containers) {
        return [];
    }

    // Get and filter containers
    const containerList = containers.find(filter).map((item) => validateContainer(item.data));
    
    // Only deduplicate if not filtering by specific criteria
    if (!query.id && !query.watcher) {
        const uniqueContainers = Object.values(
            containerList.reduce((acc, container) => {
                const key = getContainerKey(container);
                const existing = acc[key];
                
                // If no existing container with this key, add this one
                if (!existing) {
                    acc[key] = container;
                    return acc;
                }
                
                // Use a clear, prioritized approach to select the best container:
                
                // 1. Prefer running containers over non-running
                if (container.status === 'running' && existing.status !== 'running') {
                    acc[key] = container;
                    return acc;
                }
                
                if (existing.status === 'running' && container.status !== 'running') {
                    return acc; // Keep existing
                }
                
                // 2. If update status differs, prefer containers that don't need updates
                if (container.updateAvailable === false && existing.updateAvailable === true) {
                    acc[key] = container;
                    return acc;
                }
                
                if (existing.updateAvailable === false && container.updateAvailable === true) {
                    return acc; // Keep existing
                }
                
                // 3. If both are running or both stopped and update status is the same,
                // prefer the one with the newer version
                if (container.image && existing.image) {
                    // If tags are different, try to make an informed choice
                    if (container.image.tag && existing.image.tag && 
                        container.image.tag.value !== existing.image.tag.value) {
                        
                        // If both containers use semver tags, compare them properly
                        if (container.image.tag.semver && existing.image.tag.semver) {
                            // Choose the container with the more recent tag value
                            // This is a simplistic approach; proper semver comparison would be better
                            if (container.image.tag.value > existing.image.tag.value) {
                                acc[key] = container;
                            }
                            return acc;
                        }
                    }
                    
                    // If we couldn't decide based on tags, use image ID as last resort
                    // This assumes newer images have "greater" IDs (not always true but often works)
                    if (container.image.id && existing.image.id && 
                        container.image.id !== existing.image.id) {
                        
                        // If the container has been recently updated from the UI
                        if (container.notification && 
                            container.notification.level === 'success' && 
                            container.notification.message && 
                            container.notification.message.includes('completed successfully')) {
                            acc[key] = container;
                            return acc;
                        }
                        
                        // Otherwise try to compare image IDs (imperfect but can help)
                        if (container.image.id > existing.image.id) {
                            acc[key] = container;
                        }
                    }
                }
                
                return acc;
            }, {})
        );
        return uniqueContainers.sort(
            byValues([
                [(container) => container.watcher, byString()],
                [(container) => container.image.registry.name, byString()],
                [(container) => container.name, byString()],
                [(container) => container.image.tag.value, byString()],
            ])
        );
    }
    
    // Return full list when filtering
    return containerList.sort(
        byValues([
            [(container) => container.watcher, byString()],
            [(container) => container.image.registry.name, byString()],
            [(container) => container.name, byString()],
            [(container) => container.image.tag.value, byString()],
        ])
    );
}

/**
 * Get container by id.
 * @param id
 * @returns {null|Image}
 */
function getContainer(id) {
    const container = containers.findOne({
        'data.id': id,
    });

    if (container !== null) {
        return validateContainer(container.data);
    }
    return undefined;
}

/**
 * Delete container by id.
 * @param id
 */
function deleteContainer(id) {
    const container = getContainer(id);
    if (container) {
        console.log(`Attempting to delete container: ${id}`);
        containers.chain().find({ 'data.id': id }).remove();
        emitContainerRemoved(container);
        // Verify removal
        const stillExists = getContainer(id);
        if (stillExists) {
            console.warn(`Container ${id} still exists after deletion attempt.`);
        } else {
            console.log(`Container ${id} deleted successfully.`);
        }
    } else {
        console.warn(`Container ${id} not found for deletion.`);
    }
}

module.exports = {
    createCollections,
    insertContainer,
    updateContainer,
    getContainers,
    getContainer,
    deleteContainer,
};
