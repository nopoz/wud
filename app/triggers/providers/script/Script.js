const { exec } = require('child_process');
const Trigger = require('../Trigger');

/**
 * Script Trigger implementation
 */
class ScriptTrigger extends Trigger {
    /**
     * Initialize the ScriptTrigger with the provided configuration.
     * @param {String} name - Name of the trigger.
     * @param {Object} configuration - Configuration object.
     */
    constructor(name = 'unknown', configuration = {}) {
        super(name, configuration);
        this.name = name;
        this.configuration = this.validateConfiguration(configuration);

        // Validate configuration
        try {
            this.configuration = this.validateConfiguration(configuration);
        } catch (error) {
            console.error('Configuration validation failed:', error);
            throw error;
        }
    }

    /**
     * Get the Trigger configuration schema.
     * @returns {Object} - Joi validation schema for configuration.
     */
    getConfigurationSchema() {
        return this.joi.object().keys({
            path: this.joi.string().required(), // Path to the script to execute
            install: this.joi.boolean().truthy('true').falsy('false').default(false), // Install flag
            timeout: this.joi.number().default(5000), // Timeout in ms
        });
        this.configuration = this.validateConfiguration(configuration);
        return schema;
    }

    /**
     * Install action, only executed if the install flag is true.
     * @param {Object} container - Container object containing details.
     * @returns {Promise<void>}
     */
    async install(container) {
        console.log(`Attempting script install for container: ${container.name || 'unknown'}`);

        if (String(this.configuration.install).toLowerCase() !== 'true') {
            console.log(`Skipping install for container: ${container.name || 'unknown'} because install is not enabled.`);
            return;
        }
        return this.executeScript(container, 'install');
    }

    /**
     * Execute the configured script with container details.
     * @param {Object} container - The container object.
     * @param {String} actionType - The type of action (e.g., 'install').
     * @returns {Promise<void>}
     */
    executeScript(container, actionType) {
        const { path, timeout } = this.configuration;

        const name = container.name || 'unknown';
        const localValue = container.updateKind?.localValue || 'unknown';
        const remoteValue = container.updateKind?.remoteValue || 'unknown';

        const command = `${path} ${name} ${localValue} ${remoteValue}`;

        console.log(`Executing script: ${command}`);

        return new Promise((resolve, reject) => {
            const process = exec(command, { timeout }, (error, stdout, stderr) => {
                if (error) {
                    console.error(`Script execution failed: ${stderr}`);
                    return reject(error);
                }
                resolve(stdout);
            });

            process.on('error', (error) => {
                console.error(`Process error: ${error.message}`);
                reject(error);
            });

            process.stdout?.on('data', (data) => {
                console.log(`Script stdout: ${data}`);
            });

            process.stderr?.on('data', (data) => {
                console.error(`Script stderr: ${data}`);
            });

            process.on('close', (code) => {
                if (code !== 0) {
                    const message = `Script exited with code ${code}`;
                    console.error(message);
                    reject(new Error(message));
                }
            });
        });
    }
}

module.exports = ScriptTrigger;
